import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { MemoryEngine, segmentQuery } from "../src/engine.ts";
import { MemoryStore } from "../src/store.ts";
import { MetaStore } from "../src/meta.ts";
import { FakeEmbedder, FixedJudge, OverlapJudge, ScriptedLlm, writes } from "./fakes.ts";

function fixture(t: any, options: any = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "memkit-segments-"));
  t.after(() => { MetaStore.for(root).close(); rmSync(root, { recursive: true, force: true }); });
  const store = new MemoryStore(root);
  const judge = new FixedJudge({});
  const llm = new ScriptedLlm();
  const engine = new MemoryEngine({ store, judge, llm, embedder: new FakeEmbedder(), ...options });
  return { root, store, judge, llm, engine };
}
const newFile = (topic: string, body = topic) => ({ type: "event", topic, summary: body, body });
const append = (add: string) => ({ mode: "append", summary: add, add });

test("segments: invalid writer output keeps a sealed job; restart retries it without advancing tail", async (t) => {
  const { root, llm, engine } = fixture(t);
  await engine.observe("s", { id: "run-1", user: "生日12月3日" });
  llm.push({ content: "bad" }).push({ content: "still bad" });
  const failed = await engine.flush("s");
  assert.equal(failed!.actions[0].ok, false);
  assert.equal(engine.meta.segment("s").pending.length, 1);
  assert.equal(engine.meta.segment("s").tail.length, 0);
  const id = engine.meta.jobs("s")[0].id;
  engine.meta.close();
  const retry = new ScriptedLlm().push(writes({ new: [newFile("生日", "生日12月3日")] }));
  const fresh = new MemoryEngine({ store: new MemoryStore(root), judge: new FixedJudge({ worth: 0 }), llm: retry });
  assert.equal((await fresh.flush("s"))!.actions[0].ok, true, "the persisted gate decision is reused");
  assert.equal(fresh.meta.job(id)!.status, "committed");
  assert.equal(fresh.meta.segment("s").pending.length, 0);
  assert.equal(fresh.meta.segment("s").tail[0].id, "run-1");
});

test("segments: current turn is durable before topic judgment, including when it throws", async (t) => {
  const { engine, judge } = fixture(t);
  await engine.observe("s", { id: "one", user: "原来的安排" });
  const ask = judge.ask.bind(judge);
  judge.ask = async (state, questions) => {
    if (questions.topic_shift) {
      assert.deepEqual(engine.meta.segment("s").pending.map((x) => x.id), ["one", "two"]);
      throw new Error("Jev 503");
    }
    return ask(state, questions);
  };
  const result = await engine.observe("s", { id: "two", user: "新的更正", assistant: "收到更正" });
  assert.match(result.error!, /503/);
  await engine.observe("s", { id: "two", user: "新的更正", assistant: "收到更正" });
  assert.equal(engine.meta.segment("s").pending.length, 2, "host retry is deduplicated");
});

test("segments: user side commits once when assistant side fails and the process restarts", async (t) => {
  const judge = new FixedJudge({ scope: "both" });
  const { root, store, llm, engine } = fixture(t, { judge });
  const old = await store.upsert({ type: "event", topic: "接站约定", text: "用户明天到站" });
  llm.push(writes({ updates: { A: append("用户改到八点到站") } }));
  const chat = llm.chat.bind(llm);
  llm.chat = async (...args) => { if (llm.seen.length) throw new Error("assistant writer 503"); return chat(...args); };
  await engine.observe("s", { id: "one", user: "改到八点到站", assistant: "我答应来接你" });
  await assert.rejects(engine.flush("s"), /503/);
  assert.equal(engine.meta.segment("s").pending.length, 1);
  const retry = new ScriptedLlm().push(writes({ new: [newFile("接站承诺", "我答应八点接站")] }));
  engine.meta.close();
  const fresh = new MemoryEngine({ store: new MemoryStore(root), judge, llm: retry, embedder: new FakeEmbedder() });
  assert.ok((await fresh.flush("s"))!.actions.every((a) => a.ok));
  assert.equal(retry.seen.length, 1, "only the failed side calls the writer");
  assert.equal((await fresh.store.get(old.rec.uri))!.body.split("用户改到八点到站").length - 1, 1);
  assert.equal((await fresh.store.all()).length, 2);
});

test("segments: partial IO failure replays only remaining actions of the persisted plan", async (t) => {
  const judge = new FixedJudge({});
  const { root, store, llm, engine } = fixture(t, { judge });
  await store.upsert({ type: "event", topic: "行程", text: "行程周五" });
  await store.upsert({ type: "event", topic: "酒店", text: "酒店周五" });
  llm.push(writes({ updates: { A: append("本次更正A"), B: append("本次更正B") }, new: [newFile("另一个新事项")] }));
  const write = store.write.bind(store);
  let attempts = 0;
  store.write = async (input) => { if (++attempts === 2) throw new Error("disk unavailable"); return write(input); };
  await engine.observe("s", { user: "行程和酒店都改了，还有一个新事项" });
  const failed = await engine.flush("s");
  assert.deepEqual(failed!.actions.map((a) => a.ok), [true, false]);
  const freshLlm = new ScriptedLlm();
  const fresh = new MemoryEngine({ store: new MemoryStore(root), judge, llm: freshLlm });
  assert.ok((await fresh.flush("s"))!.actions.every((a) => a.ok));
  assert.equal(freshLlm.seen.length, 0, "reuse the immutable plan, not another generation");
  const files = await fresh.store.all();
  assert.equal(files.length, 3);
  assert.equal(files.map((r) => r.body).join("\n").split("本次更正A").length - 1, 1);
  assert.equal(fresh.meta.segment("s").pending.length, 0);
});

for (const mode of ["append", "create"] as const) test(`segments: ${mode} survives crash between file rename and SQLite receipt`, async (t) => {
  const judge = new FixedJudge(mode === "append" ? {} : { related: 0.1 });
  const { root, store, llm, engine } = fixture(t, { judge });
  if (mode === "append") await store.upsert({ type: "event", topic: "记事", text: "原始内容" });
  llm.push(writes(mode === "append" ? { updates: { A: append("仅写一次") } } : { new: [newFile("记事", "仅写一次")] }));
  await engine.observe("s", { id: "same-run", user: "仅写一次" });
  const save = engine.meta.saveReceipt.bind(engine.meta);
  let fail = true;
  engine.meta.saveReceipt = (...args) => { if (fail) { fail = false; throw new Error("crash before receipt"); } return save(...args); };
  assert.equal((await engine.flush("s"))!.actions[0].ok, false);
  engine.meta.saveReceipt = save;
  engine.meta.close();
  const retry = new ScriptedLlm();
  const fresh = new MemoryEngine({ store: new MemoryStore(root), judge, llm: retry });
  assert.equal((await fresh.flush("s"))!.actions[0].ok, true);
  assert.equal(retry.seen.length, 0);
  const files = await fresh.store.all();
  assert.equal(files.length, 1);
  assert.equal(files[0].body.split("仅写一次").length - 1, 1);
  assert.equal(files[0].appliedActions!.length, 1);
  await fresh.observe("s", { id: "same-run", user: "仅写一次" });
  assert.equal(fresh.meta.segment("s").pending.length, 0, "even a late host retry is deduplicated");
});

test("segments: malformed partial plans apply nothing and remain retryable", async (t) => {
  const judge = new FixedJudge({});
  const { store, llm, engine } = fixture(t, { judge });
  await store.upsert({ type: "event", topic: "A", text: "原A" });
  await store.upsert({ type: "event", topic: "B", text: "原B" });
  // One valid update next to an illegal new uri: the whole reply is refused (twice).
  llm.push(writes({ updates: { A: append("新A") }, files: [{ mode: "new", uri: "user/event/坏 名字", topic: "x", summary: "x", body: "- x" }] }));
  await engine.observe("s", { user: "A和B都变化了" });
  assert.equal((await engine.flush("s"))!.actions[0].ok, false);
  assert.ok((await store.all()).every((r) => !r.body.includes("新A")));
  llm.push(writes({ updates: { A: append("新A"), B: append("新B") } }));
  assert.ok((await engine.flush("s"))!.actions.every((a) => a.ok));
});

test("segments: explicit skip commits, failed tail advancement retries without another write", async (t) => {
  const { engine, llm } = fixture(t);
  await engine.observe("s", { user: "值得记录" });
  llm.push(writes({ new: [newFile("记忆")] }));
  const complete = engine.meta.complete.bind(engine.meta);
  engine.meta.complete = () => { throw new Error("crash before tail"); };
  await assert.rejects(engine.flush("s"), /before tail/);
  assert.equal(engine.meta.segment("s").pending.length, 1);
  engine.meta.complete = complete;
  await engine.flush("s");
  assert.equal(llm.seen.length, 1);
  assert.equal(engine.meta.segment("s").pending.length, 0);
  const skip = new MemoryEngine({ store: engine.store, judge: new FixedJudge({ worth: 0 }), llm });
  await skip.observe("other", { user: "不需要保存" });
  const job = (await skip.flush("other"))!;
  assert.equal(job.actions[0].op, "skip");
  assert.equal(skip.meta.segment("other").pending.length, 0);
});

test("routing: Assistant promises participate in BGE queries with explicit speaker labels", async (t) => {
  const embedder = new FakeEmbedder();
  const judge = new FixedJudge({ scope: "assistant" });
  const { engine, store, llm } = fixture(t, { embedder, judge });
  await store.upsert({ scope: "assistant", type: "event", topic: "接站", text: "我答应接站" });
  llm.push(writes({ updates: { A: append("明天八点接站") } }));
  await engine.ingest({ user: "嗯，接着说", assistant: "我答应明天八点去车站接你" });
  assert.match(embedder.calls[0][0], /User: 嗯，接着说\nAssistant: 我答应明天八点去车站接你/);
  const query = segmentQuery([{ user: "用户不能被挤掉", assistant: "长回复".repeat(3000) + "最后承诺八点接站" }], 1500);
  assert.ok(query.length <= 1500);
  assert.match(query, /用户不能被挤掉/);
  assert.match(query, /最后承诺八点接站/);
});

test("segments: raw sources survive clipping and action ids trace back to speakers and run ids", async (t) => {
  const { engine, llm } = fixture(t);
  const assistant = "说明".repeat(2000) + "我答应明天八点接站";
  await engine.observe("s", { id: "origin-run", user: "好，你说", assistant });
  assert.equal(engine.meta.segment("s").pending[0].assistant, assistant);
  llm.push(writes({ new: [newFile("接站承诺", "助手承诺八点接站")] }));
  const result = await engine.flush("s");
  const id = result!.actions[0].id!;
  const job = engine.meta.job(id.split(":")[0])!;
  assert.equal(job.turns[0].id, "origin-run");
  assert.equal(job.turns[0].assistant, assistant);
  assert.match(llm.seen[0][1].content, /我答应明天八点接站/);
});

test("segments: size continuations keep the previous file even when BGE top-k excludes it", async (t) => {
  const embedder = new FakeEmbedder();
  const judge = new FixedJudge({});
  const { engine, store, llm } = fixture(t, { judge, embedder, opts: { segmentChars: 1, ingestCandidates: 1 } });
  llm.push(writes({ new: [newFile("出游主记录", "出游时间周五")] }));
  await engine.observe("s", { user: "出游时间周五" });
  await engine.observe("s", { user: "那个安排再加一个人" });
  const old = (await store.all())[0];
  await store.upsert({ type: "event", topic: "无关文件", text: "无关" });
  // Force the unrelated file to win BGE's one slot.
  embedder.embed = async (texts) => texts.map((text) => Float32Array.from(text.includes("出游主记录") ? [0, 1] : [1, 0]));
  const ask = judge.ask.bind(judge);
  let linked = false;
  judge.ask = async (state: any, questions) => {
    if (!questions.related) return ask(state, questions);
    const uri = (questions.related.instructions as any).memory.uri;
    assert.ok(state.continuation.files.includes(old.uri));
    if (uri === old.uri) linked = true; // reintroduced beyond BGE's shortlist
    return { related: { type: "noul", noul: uri === old.uri ? 1 : 0.1 } };
  };
  llm.push(writes({ updates: { A: append("再加一个人") } }));
  assert.ok((await engine.flush("s"))!.actions.every((a) => a.ok));
  assert.equal(linked, true);
  assert.equal((await store.all()).length, 2);
  assert.match((await store.get(old.uri))!.body, /再加一个人/);
});

test("segments: stale uncommitted edit is rebased without repeating committed actions", async (t) => {
  const judge = new FixedJudge({});
  const { store, llm, engine } = fixture(t, { judge });
  await store.upsert({ type: "event", topic: "行程", text: "原行程" });
  await store.upsert({ type: "event", topic: "酒店", text: "原酒店" });
  llm.push(writes({ updates: { A: append("本段更新A"), B: { mode: "edit", summary: "更正B", body: "本段更正B" } } }));
  const write = store.write.bind(store);
  let calls = 0;
  let failedUri = "";
  store.write = async (input) => {
    if (++calls === 2) { failedUri = input.uri!; throw new Error("IO failure"); }
    return write(input);
  };
  await engine.observe("s", { user: "行程和酒店需要改" });
  await engine.flush("s");
  store.write = write;
  await store.write({ mode: "append", uri: failedUri, type: "event", topic: "酒店", summary: "外部变更", body: "外部新增内容" });
  llm.push(writes({ updates: { A: append("本段更正B") } }));
  assert.ok((await engine.flush("s"))!.actions.every((a) => a.ok));
  assert.equal(llm.seen.length, 2, "only the conflicted file is regenerated");
  assert.match(llm.seen[1][1].content, /外部新增内容/);
  const allBodies = (await store.all()).map((r) => r.body).join("\n");
  assert.equal(allBodies.split("本段更新A").length - 1, 1);
  assert.match((await store.get(failedUri))!.body, /外部新增内容[\s\S]*本段更正B/);
});

test("segments: legacy pending buffers without run ids are preserved and can commit", async (t) => {
  const { engine, llm } = fixture(t);
  engine.meta.saveSegment("legacy", { pending: [{ user: "旧版未整理内容", assistant: "旧版回复" }], tail: [], updatedAt: 1 });
  llm.push(writes({ new: [newFile("旧版内容")] }));
  await engine.flush("legacy");
  assert.equal(engine.meta.segment("legacy").tail[0].user, "旧版未整理内容");
  assert.equal(engine.meta.segment("legacy").pending.length, 0);
});

test("segments: SIGKILL after file persistence recovers the same action in a new process", async (t) => {
  const { spawn } = await import("node:child_process");
  const { root, engine } = fixture(t);
  const source = `
    import { MemoryEngine } from ${JSON.stringify(new URL("../src/engine.ts", import.meta.url).href)};
    import { MemoryStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
    import { FixedJudge, ScriptedLlm, writes } from ${JSON.stringify(new URL("./fakes.ts", import.meta.url).href)};
    const store = new MemoryStore(${JSON.stringify(root)});
    const llm = new ScriptedLlm().push(writes({ new: [{ type: 'event', topic: '崩溃测试', summary: '只写一次', body: '只写一次' }] }));
    const e = new MemoryEngine({ store, judge: new FixedJudge({}), llm });
    await e.observe('s', { id: 'crash-run', user: '只写一次' });
    const write = store.write.bind(store);
    store.write = async (input) => { await write(input); process.kill(process.pid, 'SIGKILL'); throw new Error('unreachable'); };
    await e.flush('s');
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  const ended = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  assert.equal(ended.signal, "SIGKILL", stderr);
  assert.equal(engine.meta.segment("s").pending.length, 1);
  assert.equal((await engine.store.all()).length, 1, "the child reached file persistence");
  assert.ok((await engine.flush("s"))!.actions.every((a) => a.ok));
  assert.equal((engine.llm as ScriptedLlm).seen.length, 0);
  assert.equal((await engine.store.all()).length, 1);
  assert.equal(engine.meta.segment("s").pending.length, 0);
});

test("segments: three new files per side are supported; excess items do not silently commit a partial segment", async (t) => {
  const { engine, llm, store } = fixture(t, { judge: new FixedJudge({ scope: "both" }) });
  llm.push(writes({ new: [newFile("A"), newFile("B"), newFile("C"), newFile("D")] }));
  await engine.observe("s", { user: "双方各自的几件事情", assistant: "还有我的几件事情" });
  assert.equal((await engine.flush("s"))!.actions[0].ok, false);
  assert.equal((await store.all()).length, 0);
  assert.equal(engine.meta.segment("s").pending.length, 1);
  llm.push(writes({ new: [newFile("A"), newFile("B"), newFile("CD")] }));
  llm.push(writes({ new: [newFile("E"), newFile("F"), newFile("G")] }));
  const r = await engine.flush("s");
  assert.equal(r!.actions.length, 6);
  assert.ok(r!.actions.every((a) => a.ok));
  assert.equal(new Set(r!.actions.map((a) => a.id)).size, 6);
  assert.equal((await store.all()).length, 6);
});

test("segments: a skipped size continuation does not lose its original file association", async (t) => {
  const judge = new FixedJudge({ related: 0.1 });
  const { engine, store, llm } = fixture(t, { judge, opts: { segmentChars: 1, ingestCandidates: 0 } });
  const ask = judge.ask.bind(judge);
  let sawLink = false;
  judge.ask = async (state: any, questions) => {
    if (questions.worth_storing && JSON.stringify(state.conversation).includes("没有新增")) {
      return { worth_storing: { type: "noul", noul: 0 }, scope: { type: "choice", choice: "empty", probabilities: { empty: 1 } } };
    }
    if (questions.related) {
      assert.ok(state.continuation.files.includes("user/event/出游"));
      sawLink = true;
      return { related: { type: "noul", noul: 1 } };
    }
    return ask(state, questions);
  };
  llm.push(writes({ new: [newFile("出游", "周五出游")] }));
  llm.push(writes({ updates: { A: append("改到周六") } }));
  await engine.observe("s", { user: "周五出游" });
  await engine.observe("s", { user: "没有新增" });
  await engine.observe("s", { user: "改到周六" });
  await engine.flush("s");
  assert.equal(sawLink, true);
  assert.equal((await store.all()).length, 1);
  assert.match((await store.all())[0].body, /改到周六/);
});

test("segments: recovering an older file receipt does not revert a newer action's importance or time", async (t) => {
  let now = 1000;
  const { engine, store, llm } = fixture(t, { judge: new FixedJudge({}), now: () => now });
  const { rec } = await store.upsert({ type: "event", topic: "安排", text: "原始安排" });
  llm.push(writes({ updates: { A: { ...append("第一次补充"), importance: 0.2 } } }));
  await engine.observe("first", { user: "第一次补充" });
  const receipt = engine.meta.saveReceipt.bind(engine.meta);
  engine.meta.saveReceipt = () => { throw new Error("receipt failed"); };
  await engine.flush("first");
  engine.meta.saveReceipt = receipt;
  now = 2000;
  llm.push(writes({ updates: { A: { ...append("更重要的第二次补充"), importance: 0.9 } } }));
  await engine.observe("second", { user: "更重要的第二次补充" });
  await engine.flush("second");
  const newer = engine.meta.get(rec.uri);
  now = 3000;
  assert.ok((await engine.flush("first"))!.actions.every((a) => a.ok));
  assert.deepEqual(engine.meta.get(rec.uri), newer);
  assert.equal(engine.meta.get(rec.uri)!.importance, 0.9);
  assert.equal((await store.get(rec.uri))!.body.split("第一次补充").length - 1, 1);
});


test("idle: a quiet session's unrecorded turns are recorded as one segment, with no topic judgment", async (t) => {
  let now = Date.parse("2026-10-29T10:00:00Z");
  // Overlap judge: the second line shares "小满" with the first, so it is the same topic.
  const judge = new OverlapJudge();
  const { engine, llm } = fixture(t, { now: () => now, judge });
  await engine.observe("s", { id: "1", user: "小满下周三过生日", assistant: "记下了" });
  await engine.observe("s", { id: "2", user: "小满想要一个风车", assistant: "好呀" });
  assert.equal(engine.meta.jobs("s").length, 0, "same topic: still one open segment");
  const shifts = () => judge.calls.filter((c) => "topic_shift" in c.questions).length;
  const asked = shifts();
  now += 19 * 60_000;
  assert.deepEqual(await engine.idleSessions(20 * 60_000), [], "not idle yet");
  now += 2 * 60_000;
  assert.deepEqual(await engine.idleSessions(20 * 60_000), ["s"]);
  llm.push(writes({ new: [newFile("小满生日", "小满下周三过生日，想要风车")] }));
  const r = await engine.flush("s");
  assert.deepEqual(r!.actions.map((a) => [a.op, a.ok]), [["new", true]]);
  assert.equal(shifts(), asked, "flush asks Jev no topic question");
  // Both turns went to the writer as one segment.
  assert.match(String(llm.seen.at(-1)![1].content), /小满下周三[\s\S]*风车/);
  assert.deepEqual(await engine.idleSessions(20 * 60_000), [], "nothing left to record");
});

test("idle: quarantined segments are not idle work; a later quiet turn still is", async (t) => {
  let now = Date.parse("2026-10-29T10:00:00Z");
  const { engine } = fixture(t, { now: () => now, opts: { maxAttempts: 1 } });
  await engine.observe("s", { id: "1", user: "我的列车明天八点到站" });
  await engine.observe("s", { id: "2", user: "我女儿小满下周三过生日" }); // topic change; writer fails → quarantined
  assert.equal(engine.meta.jobs("s", true)[0].status, "quarantined");
  now += 21 * 60_000;
  assert.deepEqual(await engine.idleSessions(20 * 60_000), ["s"], "the open turn (小满) is waiting");
  await engine.flush("s"); // writer fails again: this segment is quarantined too
  assert.deepEqual(await engine.idleSessions(20 * 60_000), [], "only quarantined segments left");
});

test("idle: a failed segment is retried only a full idle window after its last attempt", async (t) => {
  let now = Date.parse("2026-10-29T10:00:00Z");
  const { engine } = fixture(t, { now: () => now });
  await engine.observe("s", { id: "1", user: "小满下周三过生日" });
  now += 21 * 60_000;
  assert.deepEqual(await engine.idleSessions(20 * 60_000), ["s"]);
  await engine.flush("s").catch(() => undefined); // the writer produces nothing: attempt 1 fails, stays sealed
  assert.equal(engine.meta.jobs("s")[0].attempts, 1);
  now += 60_000;
  assert.deepEqual(await engine.idleSessions(20 * 60_000), [], "not on the next tick");
  now += 20 * 60_000;
  assert.deepEqual(await engine.idleSessions(20 * 60_000), ["s"], "after a full window");
});
