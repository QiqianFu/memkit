// OpenClaw plugin entry for memkit — a memory-slot plugin.
//
// How the three stages map onto OpenClaw:
//   * retrieve → `before_prompt_build`: BGE-M3 recalls the top files for the
//                conversation, Jev judges each one against the whole
//                conversation, and the files not already recalled in this
//                topic are appended to this turn's request as a recall block.
//                In parallel Jev decides whether this message starts a new
//                topic (the ingest segment boundary). Mid-term memory: a block
//                stays in the conversation at its turn while its topic lasts;
//                once the topic ends the memkit context engine
//                (src/context.ts) drops it — assemble() from the history it
//                hands the model, maintain() from the transcript — so the
//                prefix stays byte-identical within a topic (provider prefix
//                cache keeps hitting).
//   * answer   → the main agent, which only answers. In the default
//                "answer-only" mode its system prompt is replaced by the
//                persona (a role-play character card from `persona.file`, or
//                the minimal answering prompt) plus the memory rules, and it is
//                given no tools at all: everything it knows about the past
//                arrives in the injected evidence. See src/persona.ts.
//   * ingest   → `agent_end`, by segment: each turn is judged against the turns
//                since the last record; when the topic moves on, that segment is
//                written (new files / updates). `before_reset` and `session_end`
//                record what is still pending. This is the ONLY writer —
//                including when the user explicitly says "remember / correct /
//                forget this".
//
// Why no tools: a main agent with file or shell tools can read and rewrite
// memory behind the memory system's back (an e2e run did exactly that, restoring
// files from a backup and git history). Answer-only makes the single-writer and
// "answer only from retrieved memory" rules structural rather than a request.

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { delegateCompactionToRuntime } from "openclaw/plugin-sdk/core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { buildEngine } from "./src/config.ts";
import { CommitLedger, createContextEngine, ENGINE_ID } from "./src/context.ts";
import { attemptAnswered, TurnState } from "./src/turns.ts";
import type { MemkitConfig } from "./src/config.ts";
import type { HistoryTurn, MemoryEngine, TurnTimings } from "./src/engine.ts";
import { PersonaSource, resolvePersonaPath } from "./src/persona.ts";
import { DEFAULT_MONOLOGUE_TAGS, stripHtmlAndUrls, stripMonologue, stripRecallMarkup } from "./src/monologue.ts";
import { recallBlock, recallUnavailable, stripRecallBlock, withoutRecall } from "./src/prompts.ts";

type Ctx = { agentId?: string; workspaceDir?: string; runId?: string; sessionKey?: string; trigger?: string };

function msSince(t0: number): number {
  return Math.round(performance.now() - t0);
}

/**
 * The MEMKIT_DEBUG per-turn timing line. `total` is this hook's recall wall
 * time; `boundary` usually ran earlier, at context assembly (not in total).
 * What is left of a turn's latency after this, the assemble line and the
 * agent_end line is the main model and OpenClaw itself.
 */
function recallTimingLine(runId: string | undefined, totalMs: number, t: Partial<TurnTimings> | undefined, block: boolean): string {
  const part = (k: keyof TurnTimings) => `${k}=${t?.[k] ?? 0}ms`;
  return `memkit: recall run=${runId} total=${totalMs}ms ${part("boundary")} ${part("gate")} ${part("bge")} ${part("rewrite")} ${part("judge")} block=${block ? "yes" : "no"}`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((p: any) => (typeof p === "string" ? p : p?.type === "text" && typeof p.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  return "";
}

/** Prior user/assistant turns as plain text (recall blocks removed), oldest first. */
function historyOf(messages: unknown[], current: string): HistoryTurn[] {
  const out: HistoryTurn[] = [];
  for (const m of messages as { role?: string; content?: unknown }[]) {
    if (m?.role !== "user" && m?.role !== "assistant") continue;
    const text = stripRecallBlock(textOf(m.content));
    if (text) out.push({ role: m.role, text });
  }
  // The prepared messages may already end with the current request.
  const last = out[out.length - 1];
  if (last?.role === "user" && last.text.endsWith(current)) out.pop();
  return out;
}

/** The last assistant text in the run, and the user message that preceded it. */
function lastTurn(messages: unknown[]): { user: string; assistant: string } {
  let assistant = "";
  let user = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (!assistant && m?.role === "assistant") assistant = textOf(m.content);
    else if (assistant && m?.role === "user") {
      user = textOf(m.content);
      break;
    }
  }
  return { user, assistant };
}

/** The key a session's segment buffer lives under (stable across compaction's id rotation). */
function sessionOf(ctx: Ctx): string {
  return ctx.sessionKey || "default";
}

/** The agent a session key belongs to ("agent:<id>:…"), when the host does not say. */
function agentOfKey(sessionKey: string): string | undefined {
  return /^agent:([^:]+):/.exec(sessionKey)?.[1];
}

/**
 * Process-level state. A retried attempt of the same run can be served by a
 * freshly registered plugin instance, whose closures would otherwise start
 * empty; and every registration should share one ledger connection per file.
 */
function processState(): { turns: TurnState; ledgers: Map<string, CommitLedger> } {
  const k = Symbol.for("memkit.processState.v2");
  const g = globalThis as any;
  return (g[k] ??= { turns: new TurnState(), ledgers: new Map() });
}

const IDLE_TICK_MS = 60_000;

/** The idle-flush timer, one per process; `tick` is the newest registration's. */
function idleState(): { timer: ReturnType<typeof setInterval> | null; tick: (() => Promise<void>) | null; running: boolean } {
  const k = Symbol.for("memkit.idleFlush.v1");
  const g = globalThis as any;
  return (g[k] ??= { timer: null, tick: null, running: false });
}

export default definePluginEntry({
  id: "memkit",
  name: "memkit",
  description: "Long-term memory: Jev-judged retrieval, DeepSeek-written memory files.",
  register(api: any) {
    const cfg: MemkitConfig = (api.pluginConfig ?? {}) as MemkitConfig;
    const log = api.logger ?? console;
    const answerOnly = (cfg.mainAgent ?? "answer-only") === "answer-only";
    const engines = new Map<string, MemoryEngine>();
    const { turns, ledgers } = processState();

    // Memory belongs to the agent, not to whatever directory a run happens to use
    // as its workspace (`agent exec --cwd` changes that per run), so the default
    // root lives under the profile's state dir: <state>/memkit/<agentId>.
    const stateDir = (): string => {
      try {
        const d = api.runtime?.state?.resolveStateDir?.(process.env);
        if (typeof d === "string" && d) return d;
      } catch {
        // fall through
      }
      return process.env.OPENCLAW_STATE_DIR || path.join(homedir(), ".openclaw");
    };
    // Persona: read now (so a bad path is reported at startup) and re-checked
    // on every turn, so edits to the card apply without a gateway restart.
    const persona = new PersonaSource({
      // host mode keeps the host's prompt as the persona: the file is not read.
      file: answerOnly && cfg.persona?.file ? resolvePersonaPath(cfg.persona.file, stateDir()) : undefined,
      inline: cfg.answerPrompt,
      rules: cfg.persona?.rules,
      vars: cfg.persona?.vars,
      log,
    });
    {
      const p = persona.current();
      if (!answerOnly && cfg.persona?.file) log.warn?.("memkit: persona.file is ignored with mainAgent \"host\" (the host's own prompt is kept)");
      log.info?.(`memkit: answer prompt from ${answerOnly ? p.origin : "host"}, ${p.style} memory rules`);
    }
    const baseDir = (): string => (cfg.rootDir ? (api.resolvePath ? api.resolvePath(cfg.rootDir) : cfg.rootDir) : path.join(stateDir(), "memkit"));
    const rootFor = (ctx: Ctx): string => path.join(baseDir(), ctx.agentId || "main");
    const engineFor = (ctx: Ctx): MemoryEngine => {
      const root = rootFor(ctx);
      let e = engines.get(root);
      if (!e) {
        e = buildEngine(root, cfg);
        engines.set(root, e);
        log.info?.(`memkit: store ${root} (judge=${e.judge.name}, recall=${e.embedder?.name ?? "bm25"}, llm=${e.llm.model}, mainAgent=${answerOnly ? "answer-only" : "host"})`);
      }
      return e;
    };

    // The slot owner registers no tools and no extra prompt section: in
    // answer-only mode the whole system prompt comes from before_prompt_build.
    api.registerMemoryCapability?.({ promptBuilder: () => [] });

    // Context engine (select with plugins.slots.contextEngine = "memkit"): makes
    // recall evidence visible to the current request only. See src/context.ts.
    const ledgerFile = path.join(stateDir(), "memkit", "_context", "committed.sqlite");
    let ledger = ledgers.get(ledgerFile);
    if (!ledger) ledgers.set(ledgerFile, (ledger = new CommitLedger(ledgerFile)));
    api.registerContextEngine?.(ENGINE_ID, () =>
      createContextEngine({
        ledger,
        delegateCompaction: delegateCompactionToRuntime,
        isTurnInFlight: (sessionKey) => turns.isInFlight(sessionKey),
        inFlightRun: (sessionKey) => turns.inFlightRun(sessionKey),
        recallIds: (target) => engineFor({ agentId: target.agentId || agentOfKey(target.sessionKey) }).recallIds(target.sessionKey),
        prepareTurn: cfg.autoCapture === false ? undefined : (target, prompt) =>
          engineFor({ agentId: target.agentId || agentOfKey(target.sessionKey) })
            .decideBoundary(target.sessionKey, stripRecallBlock(prompt), { signal: AbortSignal.timeout(cfg.recallTimeoutMs ?? 12000) }),
        readEntries: async (target) =>
          (await readVisibleSessionTranscriptMessageEntries({ ...target, agentId: target.agentId || "main" })).map((e: any) => ({
            entryId: e.entryId,
            message: e.message,
          })),
        log,
        debug: Boolean(process.env.MEMKIT_DEBUG),
      }),
    );

    // ------------------------------------------------------------------ hooks
    api.on("before_prompt_build", async (event: any, ctx: Ctx) => {
      if (ctx.trigger === "heartbeat" || ctx.trigger === "cron") return;
      // answer-only: no tools this turn (on top of the config-level tools.deny),
      // and a minimal answering prompt in place of the host's system prompt.
      // host: only the rules are appended (the host prompt is the persona there).
      const answer = persona.current();
      const style = answer.style;
      const base = answerOnly ? { systemPrompt: answer.systemPrompt, toolsAllow: [] as string[] } : { appendSystemContext: answer.rules };
      const raw = typeof event?.currentUserMessage === "string" ? event.currentUserMessage : String(event?.prompt ?? "");
      const text = stripRecallBlock(raw);
      if (!text) return base;
      // One logical turn may run several attempts; the first attempt's prompt is
      // the user's words for the whole turn (a retry's prompt is a synthetic
      // "Continue the current task..."). Bound even without auto-recall, so
      // ingest still gets the original words. See src/turns.ts.
      const runId = ctx.runId;
      const turn = runId ? turns.begin(runId, ctx.sessionKey, text) : { user: text, block: undefined };
      if (cfg.autoRecall === false) return base;
      if (process.env.MEMKIT_DEBUG)
        log.info?.(
          `memkit: before_prompt_build run=${runId} trigger=${ctx.trigger} reuse=${Boolean(turn.block)} ` +
            `prompt=${JSON.stringify(text.slice(0, 40))} user=${JSON.stringify(turn.user.slice(0, 40))}`,
        );
      if (turn.block !== undefined) return turn.block ? { ...base, appendContext: turn.block } : base;
      let block: string;
      const t0 = performance.now();
      try {
        const history = historyOf(Array.isArray(event?.messages) ? event.messages : [], turn.user);
        const signal = AbortSignal.timeout(cfg.recallTimeoutMs ?? 12000);
        if (runId && cfg.autoCapture !== false) {
          // Mid-term memory needs the topic boundaries, which come from ingest's segments.
          const r = await engineFor(ctx).recallTurn(sessionOf(ctx), { id: runId, user: turn.user }, { history, signal });
          if (r.shift && r.shift.reason !== "same") log.info?.(`memkit: new topic (${r.shift.reason}, p=${r.shift.p}): previous recall blocks dropped`);
          if (process.env.MEMKIT_DEBUG) log.info?.(recallTimingLine(runId, msSince(t0), r.timings, Boolean(r.evidence)));
          // Nothing new: what this topic already recalled is still in the conversation.
          turns.remember(runId, r.evidence ? recallBlock(r.evidence, runId, style) : "");
          if (!r.evidence) return base;
          block = recallBlock(r.evidence, runId, style);
        } else {
          const r = await engineFor(ctx).retrieve(turn.user, { history, signal });
          if (process.env.MEMKIT_DEBUG) log.info?.(recallTimingLine(runId, msSince(t0), r.timings, r.hits.length > 0));
          block = recallBlock(style === "roleplay" && !r.hits.length ? "（没有想起相关的往事）" : r.evidence, undefined, style);
          if (runId) turns.remember(runId, block);
        }
      } catch (e) {
        // Failures never block the reply: answer without recall (not cached, so a
        // retry of this turn retrieves again — with the original words).
        log.warn?.(`memkit: recall failed: ${(e as Error).message}`);
        block = recallBlock(recallUnavailable(style), undefined, style);
      }
      return { ...base, appendContext: block };
    });

    // A recall block belongs in the projection of the turn it was recalled for
    // (frozen there by OpenClaw, which this hook cannot see; the context engine
    // decides how long it stays). Retry prompts ("Continue the current
    // task...") are written with the block in `content` — strip it there, or the
    // topic would carry the same block twice. Must stay synchronous.
    // The character's hidden monologue never reaches the channel. Only the
    // outbound text is rewritten; the transcript keeps the block (see
    // src/monologue.ts for why). A reply that was nothing but monologue is
    // not sent at all: silence beats leaking the thoughts.
    const monoCfg = cfg.persona?.monologue;
    const monoTags = { open: monoCfg?.open || DEFAULT_MONOLOGUE_TAGS.open, close: monoCfg?.close || DEFAULT_MONOLOGUE_TAGS.close };
    const stripOutbound = (): boolean => {
      const mode = monoCfg?.strip ?? "auto";
      return mode === "always" || (mode === "auto" && persona.current().style === "roleplay");
    };
    // Recall markup the model wrote into its own reply (an imitation of the
    // injected evidence, sometimes invented) is removed unconditionally, in
    // every mode: it is never the character's words.
    api.on("message_sending", (event: any) => {
      if (typeof event?.content !== "string") return;
      let text: string = event.content;
      if (text.includes("memkit-recall")) {
        const rec = stripRecallMarkup(text);
        if (rec.blocks || rec.unterminated) {
          log.warn?.(`memkit: the reply carried recall markup (${rec.blocks} block(s)${rec.unterminated ? ", a lone tag" : ""}); removed from the outbound message`);
          if (!rec.text) return { cancel: true, cancelReason: "memkit: reply contained only recall markup" };
          text = rec.text;
        }
      }
      const recallOnly = () => (text === event.content ? undefined : { content: text });
      if (!stripOutbound()) return recallOnly();
      const r = stripMonologue(text, monoTags);
      if (r.blocks === 0 && !r.unterminated && r.text === text.trim()) return recallOnly();
      if (r.unterminated) log.warn?.("memkit: monologue block without a close tag; its paragraph was dropped from the outbound message");
      if (!r.text) {
        log.warn?.("memkit: outbound message was only monologue; not sent");
        return { cancel: true, cancelReason: "memkit: reply contained only the hidden monologue" };
      }
      // Role-play: the character cannot send images or links; drop what the model made up.
      const h = stripHtmlAndUrls(r.text);
      if (h.removed) log.warn?.(`memkit: removed ${h.removed} HTML tag(s)/URL(s) from the outbound message`);
      if (!h.text) return { cancel: true, cancelReason: "memkit: reply contained only markup" };
      return { content: h.text };
    });

    api.on("before_message_write", (event: any) => {
      if (process.env.MEMKIT_DEBUG) {
        const m = event?.message;
        log.info?.(
          `memkit: before_message_write role=${m?.role} contentRecall=${JSON.stringify(m?.content ?? "").includes("memkit-recall")} ` +
            `projection=${Boolean(m?.__openclaw?.modelPromptProjection)} projectionRecall=${String(m?.__openclaw?.modelPromptProjection?.text ?? "").includes("memkit-recall")}`,
        );
      }
      const stripped = withoutRecall(event?.message, { contentOnly: true });
      return stripped ? { message: stripped } : undefined;
    });

    // Always registered: ending the turn (releasing its cached recall and its
    // in-flight mark, which gates the context engine's transcript clean-up) must
    // not depend on autoCapture, which only controls ingest.
    api.on("agent_end", async (event: any, ctx: Ctx) => {
      const answered = attemptAnswered(event);
      if (process.env.MEMKIT_DEBUG) log.info?.(`memkit: agent_end run=${ctx.runId} success=${event?.success} answered=${answered}`);
      // A failed attempt that OpenClaw will retry: the turn goes on.
      if (!answered) return;
      const original = ctx.runId ? turns.userOf(ctx.runId) : undefined;
      if (ctx.runId) turns.end(ctx.runId, ctx.sessionKey);
      if (cfg.autoCapture === false) return;
      const all = Array.isArray(event.messages) ? event.messages : [];
      const last = lastTurn(all);
      const user = stripRecallBlock(original ?? last.user);
      if (!user) return;
      // By segment: this turn is judged against the turns since the last
      // record; the finished segment is written only when the topic moves on
      // (src/engine.ts, observe).
      const t0 = performance.now();
      try {
        const res = await engineFor(ctx).observe(
          sessionOf(ctx),
          { id: ctx.runId, user, assistant: stripRecallBlock(last.assistant), time: new Date().toISOString() },
          { timeoutMs: cfg.captureTimeoutMs ?? 40000 },
        );
        // Whether this delays the reply depends on whether the host awaits
        // agent_end (the embedded runner does not); the time is logged either way.
        if (process.env.MEMKIT_DEBUG)
          log.info?.(`memkit: agent_end observe run=${ctx.runId} ms=${msSince(t0)} shift=${res.shift?.reason ?? "-"} recorded=${res.recorded ? "yes" : "no"}`);
        if (res.error) log.warn?.(`memkit: recording the previous segment failed (kept pending): ${res.error}`);
        const written = (res.recorded?.actions ?? []).filter((a) => a.ok && a.op !== "skip").map((a) => `${a.op}:${a.uri}`);
        if (written.length) log.info?.(`memkit: segment recorded (${res.shift?.reason}): ${written.join(", ")}`);
      } catch (e) {
        log.warn?.(`memkit: capture failed: ${(e as Error).message}`);
      }
    });

    // A session that ends or is reset records what it still has pending —
    // there will be no next message to trigger the topic-shift judgment. A
    // compaction that only rotates the session id keeps the same key and the
    // pending turns carry on.
    const flush = async (ctx: Ctx, key: string | undefined, why: string) => {
      if (cfg.autoCapture === false || !key) return;
      try {
        const res = await engineFor(ctx).flush(key, { timeoutMs: cfg.captureTimeoutMs ?? 40000 });
        if (res?.actions.some((a) => !a.ok)) log.warn?.(`memkit: flush on ${why} incomplete (kept pending): ${res.actions.filter((a) => !a.ok).map((a) => a.error).join("; ")}`);
        const written = (res?.actions ?? []).filter((a) => a.ok && a.op !== "skip").map((a) => `${a.op}:${a.uri}`);
        if (written.length) log.info?.(`memkit: segment recorded (${why}): ${written.join(", ")}`);
      } catch (e) {
        log.warn?.(`memkit: flush on ${why} failed: ${(e as Error).message}`);
      }
    };
    api.on("before_reset", async (_event: any, ctx: Ctx) => flush(ctx, ctx.sessionKey, "reset"));
    api.on("session_end", async (event: any, ctx: Ctx) => {
      const key = event?.sessionKey ?? ctx.sessionKey;
      if (key && event?.nextSessionKey === key) return;
      await flush(ctx, key, `session end (${event?.reason ?? "?"})`);
    });

    // Idle flush: a session quiet for `idleFlushMinutes` (default 20) gets its
    // unrecorded turns recorded as one segment. Nothing came after them, so
    // there is no topic change to ask Jev about — flush() seals and writes
    // straight away. Without this, a chat that simply stops would keep its
    // last segment out of memory until the next message.
    //
    // One timer per process (re-registration only swaps in the newest tick);
    // each tick walks every agent store under the memkit root, so sessions
    // left pending before a restart are picked up too.
    const idleMs = Math.max(0, cfg.idleFlushMinutes ?? 20) * 60_000;
    const idle = idleState();
    idle.tick = async () => {
      if (cfg.autoCapture === false || !idleMs || idle.running) return;
      idle.running = true;
      try {
        let agents: string[] = [];
        try {
          agents = readdirSync(baseDir(), { withFileTypes: true })
            .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
            .map((d) => d.name);
        } catch {
          return; // no store yet
        }
        for (const agentId of agents) {
          const ctx: Ctx = { agentId };
          for (const key of await engineFor(ctx).idleSessions(idleMs)) {
            // A turn under way will reach agent_end and observe() itself.
            if (turns.isInFlight(key)) continue;
            await flush(ctx, key, "idle");
          }
        }
      } catch (e) {
        log.warn?.(`memkit: idle flush failed: ${(e as Error).message}`);
      } finally {
        idle.running = false;
      }
    };
    if (!idle.timer && idleMs && cfg.autoCapture !== false) {
      idle.timer = setInterval(() => void idle.tick?.(), IDLE_TICK_MS);
      idle.timer.unref?.();
    }
    api.on("gateway_stop", async () => {
      if (idle.timer) clearInterval(idle.timer);
      idle.timer = null;
    });
  },
});
