// Mid-term memory: a recall block stays in the conversation while its topic
// (the open ingest segment) lasts, and goes when the segment is sealed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { MemoryEngine } from "../src/engine.ts";
import { MemoryStore } from "../src/store.ts";
import { MetaStore } from "../src/meta.ts";
import { CommitLedger, cleanHistory, createContextEngine, hasRecall, staleRecallRewrites } from "../src/context.ts";
import { recallBlock, recallIdsIn, stripRecallBlock, withoutRecall } from "../src/prompts.ts";
import { FakeEmbedder, OverlapJudge, ScriptedLlm, writes } from "./fakes.ts";

async function fixture(t: any, opts: any = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "memkit-midterm-"));
  t.after(() => { MetaStore.for(root).close(); rmSync(root, { recursive: true, force: true }); });
  const store = new MemoryStore(root);
  await store.upsert({ type: "event", topic: "周会时间", text: "周会每周三下午三点", summary: "周会在每周三下午三点" });
  await store.upsert({ type: "event", topic: "周会地点", text: "周会在三楼会议室", summary: "周会在三楼会议室" });
  await store.upsert({ type: "event", topic: "小满生日", text: "小满生日11月12日", summary: "小满的生日是11月12日" });
  const judge = new OverlapJudge();
  const llm = new ScriptedLlm();
  const engine = new MemoryEngine({ store, judge, llm, embedder: new FakeEmbedder(), opts });
  const topicCalls = () => judge.calls.filter((c) => c.questions.topic_shift).length;
  return { store, judge, llm, engine, topicCalls };
}

test("prompts: blocks carry their turn id; only blocks outside `keep` are stripped", () => {
  const a = recallBlock("- 周会在三楼", "run-a");
  const b = recallBlock("- 生日11月12日", "run-b");
  const legacy = recallBlock("- 旧块");
  const text = `问题\n${a}\n${b}\n${legacy}`;
  assert.equal(stripRecallBlock(text), "问题");
  assert.equal(stripRecallBlock(text, new Set(["run-a"])), `问题\n${a}`);
  const msg = { role: "user", content: "问题", __openclaw: { modelPromptProjection: { text } } };
  assert.deepEqual(recallIdsIn(msg), ["run-a", "run-b"]);
  assert.equal(withoutRecall({ role: "user", content: `问题\n${a}` }, { keep: new Set(["run-a"]) }), null, "nothing to strip");
  const out = withoutRecall(msg, { keep: new Set(["run-a", "run-b"]) });
  assert.equal(out.__openclaw.modelPromptProjection.text, `问题\n${a}\n${b}`, "the id-less block always goes");
  // contentOnly (before_message_write): the projection is left alone.
  assert.equal(withoutRecall(msg, { contentOnly: true }), null);
});

test("recallTurn: within a topic, files already recalled are not injected again; observe takes the boundary decided before the answer", async (t) => {
  const { engine, topicCalls } = await fixture(t);
  const r1 = await engine.recallTurn("s", { id: "t1", user: "周会几点开" });
  assert.equal(r1.shift, null, "nothing pending: no topic question");
  assert.ok(r1.evidence && r1.hits.some((h) => h.record.uri === "user/event/周会时间"));
  await engine.observe("s", { id: "t1", user: "周会几点开", assistant: "周三下午三点" });
  assert.equal(topicCalls(), 0);

  const r2 = await engine.recallTurn("s", { id: "t2", user: "周会在哪个会议室" });
  assert.equal(r2.shift!.reason, "same");
  assert.equal(topicCalls(), 1);
  assert.ok(r2.hits.every((h) => !r1.hits.some((x) => x.record.uri === h.record.uri)), "earlier files stay where they are");
  await engine.observe("s", { id: "t2", user: "周会在哪个会议室", assistant: "三楼" });
  assert.equal(topicCalls(), 1, "observe did not ask again");
  const ids = await engine.recallIds("s");
  assert.ok(ids.has("t1"));
  assert.equal(engine.meta.segment("s").pending.length, 2);
});

test("recallTurn: a new topic seals the previous segment before the answer and drops its blocks", async (t) => {
  const { engine, llm, topicCalls } = await fixture(t);
  await engine.recallTurn("s", { id: "t1", user: "周会几点开" });
  await engine.observe("s", { id: "t1", user: "周会几点开", assistant: "周三下午三点" });
  assert.deepEqual([...await engine.recallIds("s")], ["t1"]);

  const r = await engine.recallTurn("s", { id: "t2", user: "小满生日是哪天" });
  assert.equal(r.shift!.reason, "topic");
  const ids = await engine.recallIds("s");
  assert.ok(!ids.has("t1"), "the ended topic's block is no longer mid-term memory");
  assert.ok(r.hits.some((h) => h.record.uri === "user/event/小满生日"));
  assert.ok(ids.has("t2"));
  assert.equal(engine.meta.jobs("s").length, 1, "the previous segment is sealed");

  // The sealed segment is written after the answer; the new turn is not judged again.
  llm.push(writes({ updates: { A: { add: "- 周三下午三点开" } } }));
  const o = await engine.observe("s", { id: "t2", user: "小满生日是哪天", assistant: "11月12日" });
  assert.equal(o.shift!.reason, "topic");
  assert.equal(topicCalls(), 1);
  assert.ok(o.recorded!.actions.every((a) => a.ok));
  assert.deepEqual(engine.meta.segment("s").pending.map((p) => p.id), ["t2"]);
});

test("recallTurn: after a topic ends, a file it recalled may be recalled again in a new topic", async (t) => {
  const { engine, llm } = await fixture(t);
  const uri = "user/event/周会时间";
  const shownIn = async () => (await engine.meta.exclusive(() => engine.meta.recallBlocks("s"))).flatMap((b) => b.uris);
  // Topic A: the file is recalled once, and held back while the topic lasts.
  const a1 = await engine.recallTurn("s", { id: "a1", user: "周会几点开" });
  assert.ok(a1.hits.some((h) => h.record.uri === uri));
  await engine.observe("s", { id: "a1", user: "周会几点开", assistant: "三点" });
  const a2 = await engine.recallTurn("s", { id: "a2", user: "周会几点开来着" });
  assert.equal(a2.shift!.reason, "same");
  assert.ok(!a2.hits.some((h) => h.record.uri === uri), "same topic: not injected twice");
  await engine.observe("s", { id: "a2", user: "周会几点开来着", assistant: "三点" });

  // Topic B: A is sealed — its blocks and its "already shown" records go together.
  llm.push(writes({ updates: { A: { add: "- 三点" } } }));
  const b1 = await engine.recallTurn("s", { id: "b1", user: "小满生日是哪天" });
  assert.equal(b1.shift!.reason, "topic");
  assert.ok(!(await shownIn()).includes(uri));
  assert.deepEqual([...await engine.recallIds("s")], ["b1"]);
  await engine.observe("s", { id: "b1", user: "小满生日是哪天", assistant: "11月12日" });

  // Topic C needs the file again: allowed, it is a new topic and A's block is gone.
  llm.push(writes({ updates: { A: { add: "- 问了生日" } } }));
  const c1 = await engine.recallTurn("s", { id: "c1", user: "周会几点开始" });
  assert.equal(c1.shift!.reason, "topic");
  assert.ok(c1.hits.some((h) => h.record.uri === uri), "recalled again in the new topic");
  assert.deepEqual([...await engine.recallIds("s")], ["c1"]);
});

test("recallTurn: the gate sees the topic's recalled files; when they suffice nothing is recalled", async (t) => {
  const { engine, judge } = await fixture(t);
  await engine.recallTurn("s", { id: "t1", user: "周会几点开" });
  await engine.observe("s", { id: "t1", user: "周会几点开", assistant: "三点" });
  const gate = () => judge.calls.filter((c) => c.questions.need_recall).at(-1)!;
  assert.deepEqual((gate().state as any).recalled_memory, [], "nothing recalled yet in this topic");
  const ask = judge.ask.bind(judge);
  let seen: any = null;
  judge.ask = async (state: any, questions) => {
    if (!questions.need_recall) return ask(state, questions);
    seen = state;
    return { need_recall: { type: "noul", noul: 0.05 } };
  };
  const r = await engine.recallTurn("s", { id: "t2", user: "周会几点开的来着" });
  assert.ok(seen.recalled_memory.some((f: any) => f.uri === "user/event/周会时间"), "the gate knows what this topic already recalled");
  assert.equal(r.evidence, null);
  assert.ok(!(await engine.recallIds("s")).has("t2"), "no block for this turn");
  assert.ok((await engine.recallIds("s")).has("t1"), "the topic's block stays");
});

test("recallTurn: gate and boundary run in parallel; a gate that declined because of blocks the boundary then dropped is asked again", async (t) => {
  const { engine, judge, llm } = await fixture(t);
  await engine.recallTurn("s", { id: "t1", user: "周会几点开" });
  await engine.observe("s", { id: "t1", user: "周会几点开", assistant: "三点" });
  // Jev: a new topic; the gate says "no" only while it still sees the old block.
  const ask = judge.ask.bind(judge);
  const gateStates: any[] = [];
  judge.ask = async (state: any, questions) => {
    if (questions.topic_shift) return { topic_shift: { type: "noul", noul: 0.95 } };
    if (questions.need_recall) { gateStates.push(state.recalled_memory); return { need_recall: { type: "noul", noul: state.recalled_memory.length ? 0.1 : 0.9 } }; }
    return ask(state, questions);
  };
  llm.push(writes({ updates: { A: { add: "- 三点" } } }));
  const r = await engine.recallTurn("s", { id: "t2", user: "小满生日是哪天" });
  assert.equal(r.shift!.reason, "topic");
  assert.equal(gateStates.length, 2, "asked once with the old block, once without");
  assert.equal(gateStates[1].length, 0);
  assert.ok(r.hits.some((h) => h.record.uri === "user/event/小满生日"));
});

test("decideBoundary at assembly: the hook and observe reuse it; an ended topic's blocks are gone from that very request", async (t) => {
  const { engine, llm, topicCalls } = await fixture(t);
  await engine.recallTurn("s", { id: "t1", user: "周会几点开" });
  await engine.observe("s", { id: "t1", user: "周会几点开", assistant: "三点" });
  assert.deepEqual([...await engine.recallIds("s")], ["t1"]);

  // The host assembles first, with the prompt (possibly wrapped) and no run id.
  const shift = await engine.decideBoundary("s", "[Tue 15:30] 小满生日是哪天");
  assert.equal(shift!.reason, "topic");
  assert.equal(topicCalls(), 1);
  assert.deepEqual([...await engine.recallIds("s")], [], "dropped before the request is assembled");
  // The prompt hook, then observe, take the same decision by prompt / by run id.
  llm.push(writes({ updates: { A: { add: "- 三点" } } }));
  const r = await engine.recallTurn("s", { id: "t2", user: "小满生日是哪天" });
  assert.equal(r.shift!.reason, "topic");
  assert.equal(topicCalls(), 1, "not asked again in the hook");
  assert.equal(engine.meta.turnDecision("s")!.turn, "t2", "claimed by the run");
  const o = await engine.observe("s", { id: "t2", user: "小满生日是哪天", assistant: "11月12日" });
  assert.equal(o.shift!.reason, "topic");
  assert.equal(topicCalls(), 1, "nor after the answer");
  assert.equal(engine.meta.turnDecision("s"), null);
  // A second assembly for the same pending prompt (a retry) changes nothing.
  await engine.recallTurn("s", { id: "t3", user: "那她几岁了" });
  const ids = await engine.recallIds("s");
  await engine.decideBoundary("s", "那她几岁了", { id: "t3" });
  assert.deepEqual(await engine.recallIds("s"), ids);
});

test("context: assemble decides the boundary (prepareTurn) before reading the mid-term set, except for a running turn's retry", async () => {
  const calls: string[] = [];
  let keep = new Set(["t1"]);
  const engine = createContextEngine({
    ledger: new CommitLedger(path.join(mkdtempSync(path.join(tmpdir(), "memkit-ctx-")), "c.sqlite")),
    delegateCompaction: async () => ({}),
    readEntries: async () => [],
    recallIds: async () => keep,
    inFlightRun: (key) => (key.endsWith("running") ? "t2" : undefined),
    prepareTurn: async (_target, prompt) => { calls.push(prompt); keep = new Set(); },
    log: {},
  });
  const user = (text: string, id: string) => ({ role: "user", content: text, __openclaw: { modelPromptProjection: { text: `${text}\n\n${recallBlock("- x", id)}` } } });
  const out = await engine.assemble({ sessionKey: "agent:main:s", messages: [user("周会几点", "t1")], prompt: "小满生日是哪天" } as any);
  assert.deepEqual(calls, ["小满生日是哪天"]);
  assert.ok(!hasRecall(out.messages[0]), "the ended topic's block is already gone");
  keep = new Set(["t1"]);
  await engine.assemble({ sessionKey: "agent:main:running", messages: [user("周会几点", "t1")], prompt: "Continue the current task" } as any);
  assert.deepEqual(calls, ["小满生日是哪天"], "a retry of a running turn decides nothing");
});

test("recallTurn: the topic's blocks count toward the segment size", async (t) => {
  const { engine, topicCalls } = await fixture(t, { segmentChars: 120 });
  const r1 = await engine.recallTurn("s", { id: "t1", user: "周会几点开" });
  assert.ok(r1.evidence!.length > 60);
  await engine.observe("s", { id: "t1", user: "周会几点开", assistant: "周三下午三点" });
  // The dialogue alone fits; with the block it does not.
  const r2 = await engine.recallTurn("s", { id: "t2", user: "周会在哪个会议室" });
  assert.equal(r2.shift!.reason, "size");
  assert.equal(topicCalls(), 0);
  assert.ok(!(await engine.recallIds("s")).has("t1"));
});

test("recallTurn: files cut by the evidence budget are not marked shown, so they can come later", async (t) => {
  const { engine, store } = await fixture(t, { evidenceChars: 260, segmentChars: 100000 });
  for (const i of [1, 2, 3, 4]) await store.upsert({ type: "event", topic: `周会议程${i}`, text: `周会议程第${i}项：${"讨论".repeat(30)}`, summary: `周会议程第${i}项` });
  const r1 = await engine.recallTurn("s", { id: "t1", user: "周会议程有哪些" });
  const shown1 = (await engine.meta.exclusive(() => engine.meta.recallBlocks("s")))[0].uris;
  assert.deepEqual(r1.hits.map((h) => h.record.uri), shown1, "hits = what is in the block");
  assert.match(r1.evidence!, /因篇幅所限未列出/);
  await engine.observe("s", { id: "t1", user: "周会议程有哪些", assistant: "……" });
  const r2 = await engine.recallTurn("s", { id: "t2", user: "周会议程还有别的吗" });
  assert.equal(r2.shift!.reason, "same");
  assert.ok(r2.hits.length, "a file cut last time is shown now");
  assert.ok(r2.hits.every((h) => !shown1.includes(h.record.uri)));
});

test("context: history keeps the open topic's blocks at their turns, drops ended ones and the running turn's copy", async () => {
  const user = (text: string, id?: string) => ({
    role: "user",
    content: text,
    ...(id ? { __openclaw: { modelPromptProjection: { text: `${text}\n\n${recallBlock(`- ${id} 的记忆`, id)}` } } } : {}),
  });
  const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
  const history = [user("旧话题", "t0"), assistant("好"), user("周会几点", "t1"), assistant("三点"), user("在哪", "t2"), assistant("三楼"), user("那几点结束", "t3")];
  const { messages, stripped } = cleanHistory(history, new Set(["t1", "t2"]));
  assert.equal(stripped, 2, "t0 (ended topic) and t3 (not kept)");
  assert.ok(!hasRecall(messages[0]) && hasRecall(messages[2]) && hasRecall(messages[4]) && !hasRecall(messages[6]));
  assert.equal(messages[2], history[2], "a kept turn is passed through untouched (prefix stays identical)");

  // A second copy of a kept block (a persisted retry prompt) is dropped.
  const dup = cleanHistory([user("周会几点", "t1"), assistant("…"), user("Continue the current task", "t1")], new Set(["t1"]));
  assert.equal(dup.stripped, 1);
  assert.ok(hasRecall(dup.messages[0]) && !hasRecall(dup.messages[2]));

  // assemble: the running turn's own block rides on the pending message, never in history.
  const engine = createContextEngine({
    ledger: new CommitLedger(path.join(mkdtempSync(path.join(tmpdir(), "memkit-ctx-")), "c.sqlite")),
    delegateCompaction: async () => ({}),
    readEntries: async () => [],
    recallIds: async () => new Set(["t1", "t2", "t3"]),
    inFlightRun: () => "t3",
    log: {},
  });
  const out = await engine.assemble({ sessionKey: "agent:main:s", messages: history });
  assert.deepEqual(out.messages.map(hasRecall), [false, false, true, false, true, false, false]);

  // maintain rewrites only entries whose blocks have ended.
  const entries = history.map((message, i) => ({ entryId: `e${i}`, message }));
  assert.deepEqual(staleRecallRewrites(entries, new Set(["t1", "t2"])).map((r) => r.entryId), ["e0"], "the trailing in-flight entry is left alone");
});

test("recallTurn: returns per-step timings; a boundary decided at assembly is reported by the turn's recallTurn", async (t) => {
  const { store, judge, llm, topicCalls } = await fixture(t);
  const events: { step: string; detail: Record<string, unknown> }[] = [];
  const engine = new MemoryEngine({ store, judge, llm, embedder: new FakeEmbedder(), trace: (e: any) => events.push(e) });
  const keys = ["bge", "boundary", "gate", "judge", "rewrite", "total"];
  const wellFormed = (tm: Record<string, number>) => {
    assert.deepEqual(Object.keys(tm).sort(), keys);
    for (const k of keys) assert.ok(Number.isInteger(tm[k]) && tm[k] >= 0, `${k}=${tm[k]}`);
  };

  const r1 = await engine.recallTurn("s", { id: "t1", user: "周会几点开" });
  wellFormed(r1.timings as any);
  assert.equal(r1.timings.boundary, 0, "nothing pending: no boundary to decide");
  assert.ok(r1.timings.total >= r1.timings.judge);
  const mid = events.filter((e) => e.step === "mid_term").at(-1)!;
  assert.equal(mid.detail.turn, "t1");
  assert.deepEqual(mid.detail.timings, r1.timings, "the trace carries the same timings");
  for (const step of ["gate", "judge"]) assert.equal(typeof events.find((e) => e.step === step)!.detail.ms, "number", `${step} has ms`);
  await engine.observe("s", { id: "t1", user: "周会几点开", assistant: "周三下午三点" });

  // The host decides the boundary at assemble(), before the prompt hook; the
  // hook's recallTurn reuses that decision and reports how long it took.
  const ask = judge.ask.bind(judge);
  judge.ask = async (state: any, questions: any, signal?: AbortSignal) => {
    if (questions.topic_shift) await new Promise((r) => setTimeout(r, 30));
    return ask(state, questions, signal);
  };
  await engine.decideBoundary("s", "小满生日是哪天");
  const r2 = await engine.recallTurn("s", { id: "t2", user: "小满生日是哪天" });
  assert.equal(topicCalls(), 1, "recallTurn did not ask again");
  wellFormed(r2.timings as any);
  assert.ok(r2.timings.boundary >= 25, `boundary=${r2.timings.boundary}`);
  assert.equal(typeof events.find((e) => e.step === "topic_shift")!.detail.ms, "number");

  // Taken once: the next turn without a boundary decision reports 0 again.
  const r3 = await engine.recallTurn("other", { id: "u1", user: "周会几点开" });
  assert.equal(r3.timings.boundary, 0);
});
