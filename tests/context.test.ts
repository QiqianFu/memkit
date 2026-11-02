import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { CommitLedger, cleanHistory, createContextEngine, hasRecall, staleRecallRewrites } from "../src/context.ts";
import type { Rewrite, TranscriptEntry } from "../src/context.ts";
import { recallBlock } from "../src/prompts.ts";

const tmp = () => mkdtempSync(path.join(tmpdir(), "memkit-ctx-"));

/** A persisted user message the way OpenClaw stores it: own words + projection with evidence. */
const user = (text: string, evidence?: string) => ({
  role: "user",
  content: text,
  ...(evidence ? { __openclaw: { modelPromptProjection: { version: 1, text: `${text}\n\n${recallBlock(evidence)}` } } } : {}),
});
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

const engineWith = (over: Partial<Parameters<typeof createContextEngine>[0]> = {}) =>
  createContextEngine({
    ledger: new CommitLedger(path.join(tmp(), "committed.json")),
    delegateCompaction: async () => ({ ok: true, compacted: true }),
    readEntries: async () => [],
    log: {},
    ...over,
  });

/** A fake transcript whose rewrite applies replacements in place. */
function fakeTranscript(entries: TranscriptEntry[]) {
  const calls: Rewrite[][] = [];
  return {
    calls,
    entries,
    readEntries: async () => entries.map((e) => ({ ...e })),
    runtimeContext: {
      rewriteTranscriptEntries: async (req: { replacements: Rewrite[] }) => {
        calls.push(req.replacements);
        for (const r of req.replacements) {
          const e = entries.find((x) => x.entryId === r.entryId)!;
          e.message = r.message;
        }
        return { changed: true, bytesFreed: 1, rewrittenEntries: req.replacements.length };
      },
    },
  };
}

test("cleanHistory strips recall from content and projection of past user turns", () => {
  const msgs = [user("我叫阿明", "（无）"), assistant("好的阿明"), user("我叫什么", "阿明"), assistant("你叫阿明")];
  const { messages, stripped } = cleanHistory(msgs);
  assert.equal(stripped, 2);
  assert.ok(messages.every((m) => !hasRecall(m)));
  assert.equal((messages[0] as any).__openclaw.modelPromptProjection.text, "我叫阿明");
  assert.equal((messages[0] as any).__openclaw.modelPromptProjection.version, 1);
  // The input transcript objects are never mutated.
  assert.ok(hasRecall(msgs[0]) && hasRecall(msgs[2]));
});

test("cleanHistory strips a trailing user message too (fenced history never holds the current turn)", () => {
  // After overflow compaction the host retries with a synthetic continue prompt
  // carrying the same evidence; the original prompt is history by then.
  const msgs = [user("summary"), user("我车停哪", "B2-37")];
  const { messages, stripped } = cleanHistory(msgs);
  assert.equal(stripped, 1);
  assert.ok(!hasRecall(messages[1]));
});

test("cleanHistory returns the same array when nothing to strip", () => {
  const msgs = [user("一"), assistant("好")];
  assert.equal(cleanHistory(msgs).messages, msgs);
});

test("ledger: first commit is committed, retries are duplicate, survives restart", async () => {
  const file = path.join(tmp(), "c.sqlite");
  const a = new CommitLedger(file);
  const results = await Promise.all([a.commit("k1"), a.commit("k1"), a.commit("k2")]);
  assert.deepEqual(results, ["committed", "duplicate", "committed"]);
  a.close();
  const b = new CommitLedger(file);
  assert.equal(await b.commit("k1"), "duplicate");
  assert.equal(await b.commit("k3"), "committed");
});

test("ledger: instances sharing one file never lose or double-commit keys", async () => {
  // Plugin re-registration creates a new instance on the same file.
  const file = path.join(tmp(), "c.sqlite");
  const a = new CommitLedger(file);
  const b = new CommitLedger(file);
  assert.equal(await a.commit("A"), "committed");
  assert.equal(await b.commit("B"), "committed");
  assert.equal(await a.commit("C"), "committed");
  const c = new CommitLedger(file);
  for (const k of ["A", "B", "C"]) assert.equal(await c.commit(k), "duplicate", k);
  // Concurrent commits of the same keys from two instances: exactly one wins each.
  const keys = Array.from({ length: 8 }, (_, i) => `k${i}`);
  const results = await Promise.all(keys.flatMap((k) => [a.commit(k), b.commit(k)]));
  assert.equal(results.filter((r) => r === "committed").length, keys.length);
  assert.equal(results.filter((r) => r === "duplicate").length, keys.length);
});

test("staleRecallRewrites skips the trailing in-flight user entry", () => {
  const entries = [
    { entryId: "u1", message: user("一", "旧") },
    { entryId: "a1", message: assistant("好") },
    { entryId: "u2", message: user("二", "新") },
  ];
  const r = staleRecallRewrites(entries);
  assert.deepEqual(r.map((x) => x.entryId), ["u1"]);
  assert.equal(r[0].message.content, "一");
});

test("engine: maintain rewrites every stale recall on the active branch, then is a no-op", async () => {
  // Turn 1 accepted, turn 2 cancelled after its user entry was persisted, turn 3 accepted.
  const t = fakeTranscript([
    { entryId: "u1", message: user("我叫阿明", "（无）") },
    { entryId: "a1", message: assistant("好") },
    { entryId: "u2", message: user("被取消的问题", "证据2") },
    { entryId: "u3", message: user("我叫什么", "阿明") },
    { entryId: "a3", message: assistant("阿明") },
  ]);
  const engine = engineWith({ readEntries: t.readEntries });
  const r = await engine.maintain({ sessionKey: "s", runtimeContext: t.runtimeContext });
  assert.equal(r.rewrittenEntries, 3);
  assert.ok(t.entries.every((e) => !hasRecall(e.message)));
  const again = await engine.maintain({ sessionKey: "s", runtimeContext: t.runtimeContext });
  assert.equal(again.changed, false);
  assert.equal(t.calls.length, 1);
});

test("engine: rewrite failures never throw out of maintain", async () => {
  const engine = engineWith({ readEntries: async () => [{ entryId: "u", message: user("问", "证据") }, { entryId: "a", message: assistant("答") }] });
  const r = await engine.maintain({
    sessionKey: "s",
    runtimeContext: {
      rewriteTranscriptEntries: async () => {
        throw new Error("Session transcript changed before rewrite preparation");
      },
    },
  });
  assert.equal(r.changed, false);
  assert.equal((await engine.maintain({ sessionKey: "s" })).reason, "no rewrite capability");
});

test("engine: never rewrites while a turn of the session is in flight", async () => {
  // A failed attempt left an error reply after the running turn's user entry,
  // so the trailing-entry guard alone would not protect it.
  const t = fakeTranscript([
    { entryId: "u1", message: user("问", "证据") },
    { entryId: "a1", message: assistant("error") },
  ]);
  let running = true;
  const engine = engineWith({ readEntries: t.readEntries, isTurnInFlight: (k) => running && k === "s" });
  assert.equal((await engine.compact({ sessionKey: "s", runtimeContext: t.runtimeContext })).compacted, true);
  assert.equal(t.calls.length, 0);
  running = false;
  await engine.maintain({ sessionKey: "s", runtimeContext: t.runtimeContext });
  assert.equal(t.calls.length, 1);
});

test("engine: commitTurn is idempotent by advancement key", async () => {
  const engine = engineWith();
  assert.equal((await engine.commitTurn({ advancementKey: "k" })).status, "committed");
  assert.equal((await engine.commitTurn({ advancementKey: "k" })).status, "duplicate");
});

test("engine: compact cleans the transcript first, keeps the in-flight turn, then delegates", async () => {
  const order: string[] = [];
  const t = fakeTranscript([
    { entryId: "u1", message: user("旧问题", "旧证据") },
    { entryId: "a1", message: assistant("旧回答") },
    { entryId: "u2", message: user("当前问题", "当前证据") },
  ]);
  const engine = engineWith({
    readEntries: t.readEntries,
    delegateCompaction: async () => {
      order.push(`delegate:${t.entries.filter((e) => hasRecall(e.message)).map((e) => e.entryId)}`);
      return { ok: true, compacted: true };
    },
  });
  const res = await engine.compact({ sessionKey: "s", sessionId: "x", runtimeContext: t.runtimeContext });
  assert.deepEqual(order, ["delegate:u2"]);
  assert.equal(res.compacted, true);
});

test("engine declares the durable-turn semantics and delegating compaction", () => {
  const { info } = engineWith();
  assert.equal(info.ownsCompaction, false);
  assert.deepEqual(info.transcriptSemantics, {
    currentTurnFence: "before-current-turn-entry-v1",
    turnAdvancementIdempotency: "atomic-idempotent-v1",
  });
});
