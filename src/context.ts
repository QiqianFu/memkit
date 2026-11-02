// memkit as an OpenClaw context engine.
//
// Why this exists: retrieval evidence is injected through before_prompt_build's
// appendContext, and OpenClaw freezes the text it sent into the user message's
// immutable `__openclaw.modelPromptProjection` — which it then replays as history
// on every later turn. That replay is what mid-term memory rides on: a recall
// block stays in the conversation, at the turn it was recalled for, while its
// topic (the open ingest segment) lasts — the prefix stays byte-identical, so
// the provider's prefix cache keeps hitting. Blocks of a topic that has ended
// (its segment was sealed) must go, and this engine closes the two paths that
// would replay them:
//
//   * assemble()  — runs BEFORE the prompt hook, with the turn's prompt, so the
//                   topic boundary is decided here first (`prepareTurn`): an
//                   ended topic's blocks are dropped from this very request.
//                   The history handed to the model is a cleaned COPY: recall blocks
//                   not in the session's mid-term set (`recallIds`) are removed
//                   from both `content` and the projection text of every user
//                   message before the current turn. The current turn's message
//                   is appended by the host after assemble and keeps its evidence.
//   * maintain()  — after each accepted turn (and before compaction), every user
//                   entry on the transcript's active branch that still carries an
//                   ended topic's block is rewritten clean (OpenClaw's
//                   branch-and-reappend rewrite). So anything that reads the
//                   active branch without this engine — the legacy fallback after
//                   a quarantine, the built-in compactor, a later engine switch —
//                   sees no stale memory either. Scanning the branch (rather than
//                   tracking turns) also catches cancelled turns, turns from
//                   before a restart and sessions from before the engine was
//                   enabled. The original entries survive only on the abandoned
//                   branch.
//
// Compaction is delegated to OpenClaw (ownsCompaction: false + compact() calling
// the runtime), and long-term memory writes stay in the agent_end hook: commitTurn
// only records the advancement key and must not write memory a second time.
//
// Nothing here imports openclaw so it can be unit-tested; index.ts injects the
// runtime compaction delegate, the transcript reader and the mid-term set.

import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import { recallIdsIn, withoutRecall } from "./prompts.ts";

type Msg = { role?: string; content?: unknown; [k: string]: unknown };
type Log = { info?: (m: string) => void; warn?: (m: string) => void };

const NON_USER_TURN_ROLES = new Set(["assistant", "toolResult", "tool"]);

/**
 * Index of a trailing current-turn user message (a user message with no
 * assistant/tool message after it), or -1. Its evidence is still in use.
 */
function currentTurnIndex(roles: (string | undefined)[]): number {
  for (let i = roles.length - 1; i >= 0; i--) {
    const role = roles[i];
    if (role === "user") return i;
    if (role && NON_USER_TURN_ROLES.has(role)) return -1;
  }
  return -1;
}

/**
 * History with recall blocks removed from every user message, except blocks
 * in `keep` (the current topic's mid-term memory).
 *
 * The history is everything before the current turn (the declared
 * before-current-turn fence; if it cannot be honoured, OpenClaw runs the whole
 * turn on the legacy path and never calls assemble). The current turn's
 * evidence rides on the pending message the host appends afterwards, so the
 * caller leaves the running turn's own id out of `keep`: after overflow
 * compaction the host retries with a synthetic "continue" prompt that carries
 * the same block, and the copy left in history would duplicate it.
 */
export function cleanHistory(messages: Msg[], keep?: ReadonlySet<string>): { messages: Msg[]; stripped: number } {
  let stripped = 0;
  const once = firstOnly(keep);
  const out = messages.map((m) => {
    const clean = withoutRecall(m, { keep: once(m) });
    if (!clean) return m;
    stripped++;
    return clean;
  });
  return { messages: stripped ? out : messages, stripped };
}

/**
 * A kept block belongs to one turn; should a second message carry the same id
 * (a retry prompt persisted with it), only the first copy stays. Returns the
 * keep set for each message in order.
 */
function firstOnly(keep?: ReadonlySet<string>): (m: Msg) => ReadonlySet<string> | undefined {
  if (!keep?.size) return () => keep;
  const seen = new Set<string>();
  return (m) => {
    const ids = recallIdsIn(m).filter((id) => keep.has(id));
    const mine = new Set(ids.filter((id) => !seen.has(id)));
    for (const id of ids) seen.add(id);
    return mine;
  };
}

export function hasRecall(message: unknown): boolean {
  return withoutRecall(message) !== null;
}

export type TranscriptEntry = { entryId: string; message: Msg };
export type Rewrite = { entryId: string; message: Msg };

/**
 * Replacements for every active-branch user entry that still carries a recall
 * block not in `keep`, except a trailing in-flight one: rewriting the admitted
 * entry of a running turn would break its transcript fence (and drop its live
 * evidence).
 */
export function staleRecallRewrites(entries: TranscriptEntry[], keep?: ReadonlySet<string>): Rewrite[] {
  const current = currentTurnIndex(entries.map((e) => e.message?.role));
  const once = firstOnly(keep);
  const out: Rewrite[] = [];
  entries.forEach((e, i) => {
    const mine = once(e.message);
    if (i === current) return;
    const clean = withoutRecall(e.message, { keep: mine });
    if (clean) out.push({ entryId: e.entryId, message: clean });
  });
  return out;
}

/** Rough token estimate (CJK-heavy text runs ~1.5 chars/token, JSON overhead included). */
export function estimateTokens(messages: Msg[]): number {
  let chars = 0;
  for (const m of messages) chars += JSON.stringify(m?.content ?? "").length + 8;
  return Math.ceil(chars / 2);
}

/**
 * Durable set of committed advancement keys in SQLite. One commitTurn is one
 * `INSERT OR IGNORE` against a PRIMARY KEY: the database, not this object,
 * decides committed vs duplicate, so it stays atomic and idempotent across
 * plugin instances (hot reload, a fresh registration per run) and across
 * processes sharing the state dir (WAL + busy timeout).
 */
export class CommitLedger {
  readonly file: string;
  readonly limit: number;
  private db: DatabaseSync | null = null;
  constructor(file: string, limit = 50000) {
    this.file = file;
    this.limit = limit;
  }

  private open(): DatabaseSync {
    if (this.db) return this.db;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE IF NOT EXISTS committed (key TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    this.db = db;
    return db;
  }

  async commit(key: string): Promise<"committed" | "duplicate"> {
    const db = this.open();
    const r = db.prepare("INSERT OR IGNORE INTO committed (key, at) VALUES (?, ?)").run(key, Date.now());
    if (Number(r.changes) === 0) return "duplicate";
    // Bounded: drop the oldest keys now and then (a retry that old is long settled).
    if (Number(r.lastInsertRowid) % 1000 === 0)
      db.prepare("DELETE FROM committed WHERE rowid <= ?").run(Number(r.lastInsertRowid) - this.limit);
    return "committed";
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

type SessionParams = {
  sessionKey?: string;
  sessionId?: string;
  sessionTarget?: { agentId?: string; sessionId?: string; sessionKey?: string; storePath?: string };
  runtimeContext?: any;
};
type RewriteFn = (req: { replacements: Rewrite[] }) => Promise<{ changed: boolean; rewrittenEntries: number; bytesFreed?: number; reason?: string }>;

export type ContextEngineDeps = {
  ledger: CommitLedger;
  /** OpenClaw's built-in compaction (delegateCompactionToRuntime). */
  delegateCompaction: (params: any) => Promise<any>;
  /**
   * True while a turn of this session is running. Rewriting then would replace
   * the running turn's admitted entry and break its transcript fence (seen when
   * overflow compaction runs maintenance mid-turn after a failed attempt left an
   * error reply behind the user entry, defeating the trailing-entry guard).
   */
  isTurnInFlight?: (sessionKey: string) => boolean;
  /**
   * Ids of the recall blocks that are the session's mid-term memory (the open
   * topic's). Without it every block is stale after its turn.
   */
  recallIds?: (target: { agentId?: string; sessionKey: string }) => Promise<ReadonlySet<string>>;
  /** Run id of the session's turn in flight, if any (its block rides on the pending message). */
  inFlightRun?: (sessionKey: string) => string | undefined;
  /**
   * Decide the topic boundary for the turn about to run (the host passes its
   * prompt to assemble), BEFORE the mid-term set is read: an ended topic's
   * blocks must already be gone from the history assembled for that turn.
   */
  prepareTurn?: (target: { agentId?: string; sessionKey: string }, prompt: string) => Promise<unknown>;
  /** Active-branch message entries, oldest first (readVisibleSessionTranscriptMessageEntries). */
  readEntries: (target: { agentId?: string; sessionKey?: string; sessionId?: string; storePath?: string }) => Promise<TranscriptEntry[]>;
  log?: Log;
  debug?: boolean;
};

export const ENGINE_ID = "memkit";

const unchanged = (reason: string) => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0, reason });

export function createContextEngine(deps: ContextEngineDeps) {
  const log = deps.log ?? console;
  const sessionOf = (p: SessionParams) => p.sessionKey || p.sessionTarget?.sessionKey || p.sessionId || "";
  /** The mid-term set; on failure, nothing is kept (stale memory is worse than none). */
  const keepFor = async (p: SessionParams): Promise<Set<string>> => {
    const sessionKey = p.sessionKey || p.sessionTarget?.sessionKey || "";
    if (!sessionKey || !deps.recallIds) return new Set();
    try {
      return new Set(await deps.recallIds({ agentId: p.sessionTarget?.agentId, sessionKey }));
    } catch (e) {
      log.warn?.(`memkit: mid-term recall set unavailable session=${sessionKey}: ${(e as Error).message}`);
      return new Set();
    }
  };

  /** Rewrite every stale recall block on the active branch. Never throws. */
  const cleanTranscript = async (p: SessionParams) => {
    const rewrite: RewriteFn | undefined = p.runtimeContext?.rewriteTranscriptEntries;
    if (typeof rewrite !== "function") return unchanged("no rewrite capability");
    if (deps.isTurnInFlight?.(sessionOf(p))) {
      // The next accepted turn's maintenance cleans it.
      if (deps.debug) log.info?.(`memkit: transcript clean deferred session=${sessionOf(p)} (turn in flight)`);
      return unchanged("turn in flight");
    }
    try {
      // Maintenance is foreground: the reply waits for it, so its time is logged.
      const t0 = performance.now();
      const entries = await deps.readEntries({
        ...p.sessionTarget,
        sessionKey: p.sessionTarget?.sessionKey ?? p.sessionKey,
        sessionId: p.sessionTarget?.sessionId ?? p.sessionId,
      });
      const replacements = staleRecallRewrites(entries, await keepFor(p));
      if (!replacements.length) return unchanged("no stale recall");
      const t1 = performance.now();
      const r = await rewrite({ replacements });
      if (deps.debug)
        log.info?.(
          `memkit: transcript cleaned session=${sessionOf(p)} entries=${r.rewrittenEntries} ${r.reason ?? ""} ` +
            `readMs=${Math.round(t1 - t0)} rewriteMs=${Math.round(performance.now() - t1)}`,
        );
      return { bytesFreed: 0, ...r };
    } catch (e) {
      // The next maintenance pass retries; assemble() filters in the meantime.
      log.warn?.(`memkit: transcript clean failed session=${sessionOf(p)}: ${(e as Error).message}`);
      return unchanged("rewrite failed");
    }
  };

  return {
    info: {
      id: ENGINE_ID,
      name: "memkit (topic-scoped recall)",
      version: "0.2.0",
      ownsCompaction: false,
      turnMaintenanceMode: "foreground" as const,
      transcriptSemantics: {
        currentTurnFence: "before-current-turn-entry-v1" as const,
        turnAdvancementIdempotency: "atomic-idempotent-v1" as const,
      },
    },

    // The session store owns persistence; memkit's long-term memory is written
    // by the agent_end hook, not per message.
    async ingest() {
      return { ingested: false };
    },

    async assemble(params: SessionParams & { messages: Msg[] }) {
      // Timed because the topic boundary (a Jev call) runs here, before the
      // prompt hook: the debug line is the only place its share of the turn
      // shows up in the gateway log.
      const t0 = performance.now();
      let boundaryMs = 0;
      const sessionKey = params.sessionKey || params.sessionTarget?.sessionKey || "";
      const running = deps.inFlightRun?.(sessionOf(params));
      const prompt = typeof (params as any).prompt === "string" ? (params as any).prompt.trim() : "";
      // A retry attempt of a running turn re-assembles with a synthetic prompt: its boundary is already decided.
      if (deps.prepareTurn && sessionKey && prompt && !running) {
        try {
          await deps.prepareTurn({ agentId: params.sessionTarget?.agentId, sessionKey }, prompt);
        } catch (e) {
          log.warn?.(`memkit: topic boundary at assembly failed session=${sessionKey}: ${(e as Error).message}`);
        }
        boundaryMs = Math.round(performance.now() - t0);
      }
      const keep = await keepFor(params);
      if (running) keep.delete(running);
      const { messages, stripped } = cleanHistory(Array.isArray(params.messages) ? params.messages : [], keep);
      if (deps.debug) log.info?.(`memkit: assemble session=${sessionOf(params)} messages=${messages.length} stripped=${stripped} keep=[${[...keep].join(",")}] running=${running ?? "-"} prompt=${JSON.stringify(prompt.slice(0, 40))} ms=${Math.round(performance.now() - t0)} boundaryMs=${boundaryMs}`);
      return { messages, estimatedTokens: estimateTokens(messages) };
    },

    async commitTurn(params: SessionParams & { advancementKey: string }) {
      const status = await deps.ledger.commit(params.advancementKey);
      if (deps.debug) log.info?.(`memkit: commitTurn ${status} session=${sessionOf(params)} key=${params.advancementKey}`);
      return { status };
    },

    async maintain(params: SessionParams) {
      return cleanTranscript(params);
    },

    async compact(params: any) {
      // Clean first so the summariser never sees an ended topic's evidence.
      await cleanTranscript(params);
      return deps.delegateCompaction(params);
    },
  };
}
