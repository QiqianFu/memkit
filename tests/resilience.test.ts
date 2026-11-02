import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { MemoryEngine } from "../src/engine.ts";
import { MemoryStore } from "../src/store.ts";
import { MetaStore } from "../src/meta.ts";
import { FixedJudge, FakeEmbedder, ScriptedLlm, writes } from "./fakes.ts";

function fixture(t: any, opts: any = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "memkit-resilience-"));
  const store = new MemoryStore(root);
  const judge = new FixedJudge({});
  const llm = new ScriptedLlm();
  let now = Date.now();
  const engine = new MemoryEngine({ store, judge, llm, embedder: new FakeEmbedder(), opts, now: () => ++now });
  t.after(() => { engine.meta.close(); rmSync(root, { force: true, recursive: true }); });
  return { root, store, judge, llm, engine };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("operation was blocked")), 3000); })]); }
  finally { clearTimeout(timer!); }
}
const newFile = (topic: string) => ({ type: "event", topic, summary: topic, body: topic });
const update = (text: string) => writes({ updates: { A: { mode: "append", summary: text, add: text } } });

// A malformed plan is a real failure even though no exception was thrown.
test("quarantine: repeated missing targets stop at the limit, remain searchable, and let later jobs commit", async (t) => {
  const { engine, store, llm, judge, root } = fixture(t);
  await store.upsert({ type: "event", topic: "旧A", text: "原A" });
  await store.upsert({ type: "event", topic: "旧B", text: "原B" });
  let badCalls = 0;
  let repair = false;
  llm.chat = async (messages) => {
    llm.seen.push(messages);
    const current = String(messages[1].content).split("【这段对话】")[1].split("【相关的记忆文件】")[0];
    if (current.includes("坏段")) {
      badCalls++;
      // Until repaired, the writer names a file it was not given (also in its second try).
      return { content: writes(repair ? { updates: { A: { add: "补充A" }, B: { add: "补充B" } } } : { updates: { "user/event/不存在": { add: "补充" } } }).resolve(messages), toolCalls: [] };
    }
    return { content: writes({ new: [newFile("后续好段")] }).resolve(messages), toolCalls: [] };
  };
  await engine.observe("s", { id: "bad", user: "坏段同时更新两个文件" });
  await engine.observe("s", { id: "good", user: "后续好段" }); // failure 1, good stays open
  const id = engine.meta.jobs("s")[0].id;
  await engine.flush("s"); // failure 2, good is now sealed behind it
  const r = await engine.flush("s"); // failure 3 quarantines, then good commits
  assert.ok(r!.actions.some((a) => a.ok && a.op === "new"));
  assert.equal(badCalls, 6, "three attempts, each with one corrective round");
  assert.equal(engine.meta.job(id)!.status, "quarantined");
  assert.equal(engine.meta.job(id)!.attempts, 3);
  assert.match(engine.meta.job(id)!.lastError!, /not one of the related files/);
  assert.deepEqual(engine.meta.segment("s").pending.map((x) => x.id), ["bad"]);
  assert.equal(await engine.flush("s"), null);
  engine.meta.close();
  const freshLlm = new ScriptedLlm();
  const fresh = new MemoryEngine({ store: new MemoryStore(root), judge, llm: freshLlm });
  assert.equal(await fresh.flush("s"), null);
  assert.equal(freshLlm.seen.length, 0, "restart never silently resets the retry budget");
  repair = true;
  assert.ok((await engine.retrySegment(id))!.actions.every((a) => a.ok));
  assert.equal(engine.meta.job(id)!.status, "committed");
  assert.equal(engine.meta.job(id)!.attempts, 1);
  assert.equal(engine.meta.segment("s").tail.at(-1)!.id, "good", "manual retry of an older job does not move recent context backwards");
});

test("quarantine: thrown model failures also stop blocking the queue at the configured limit", async (t) => {
  const { engine, llm } = fixture(t, { maxAttempts: 1 });
  engine.meta.receive("s", { id: "bad", user: "坏段" }, 1);
  const bad = engine.meta.seal("s", engine.meta.openSegment("s").pending, false, 3)!;
  engine.meta.receive("s", { id: "good", user: "好段" }, 2);
  let calls = 0;
  llm.chat = async (messages) => {
    if (++calls === 1) throw new Error("writer unavailable");
    return { content: writes({ new: [newFile("好段")] }).resolve(messages), toolCalls: [] };
  };
  const r = await engine.flush("s");
  assert.deepEqual(r!.actions.map((a) => a.ok), [false, true]);
  assert.equal(engine.meta.job(bad.id)!.status, "quarantined");
  assert.equal(await engine.flush("s"), null);
  assert.equal(calls, 2);
});

test("retry budget: receipt-only recovery finishes the final attempt without buying another model call", async (t) => {
  const { engine, llm } = fixture(t, { maxAttempts: 1 });
  await engine.observe("s", { user: "只写一次" });
  llm.push(writes({ new: [newFile("只写一次")] }));
  const complete = engine.meta.complete.bind(engine.meta);
  engine.meta.complete = () => { throw new Error("crash before checkpoint"); };
  await assert.rejects(engine.flush("s"), /checkpoint/);
  engine.meta.complete = complete;
  const id = engine.meta.jobs("s")[0].id;
  assert.equal(engine.meta.job(id)!.attempts, 1);
  await engine.flush("s");
  assert.equal(engine.meta.job(id)!.status, "committed");
  assert.equal(llm.seen.length, 1);
});

test("locks: separate sessions reach Jev and DeepSeek concurrently, then commit safely", async (t) => {
  const { engine, judge, llm, store } = fixture(t);
  await engine.observe("a", { user: "会话A" });
  await engine.observe("b", { user: "会话B" });
  const gatesEntered = deferred(); const releaseGates = deferred();
  const writersEntered = deferred(); const releaseWriters = deferred();
  let gates = 0; let writers = 0;
  const ask = judge.ask.bind(judge);
  judge.ask = async (state, questions) => {
    if (questions.worth_storing) { if (++gates === 2) gatesEntered.resolve(); await releaseGates.promise; }
    return ask(state, questions);
  };
  llm.chat = async (messages) => {
    const n = ++writers;
    if (n === 2) writersEntered.resolve();
    await releaseWriters.promise;
    return { content: writes({ new: [newFile(`会话${n}`)] }).resolve(messages), toolCalls: [] };
  };
  const a = engine.flush("a"); const b = engine.flush("b");
  try {
    await bounded(gatesEntered.promise);
    releaseGates.resolve();
    await bounded(writersEntered.promise);
  } finally { releaseGates.resolve(); releaseWriters.resolve(); }
  assert.ok((await a)!.actions.every((x) => x.ok));
  assert.ok((await b)!.actions.every((x) => x.ok));
  assert.equal((await store.all()).length, 2);
  assert.equal(engine.meta.segment("a").pending.length + engine.meta.segment("b").pending.length, 0);
});

test("timeout: the capture budget starts after waiting for the same session", async (t) => {
  const { engine, llm, judge } = fixture(t);
  await engine.observe("s", { user: "第一轮" });
  const entered = deferred(); const release = deferred();
  let count = 0;
  llm.chat = async (messages) => {
    if (++count === 1) { entered.resolve(); await release.promise; }
    return { content: writes({ new: [newFile(`轮次${count}`)] }).resolve(messages), toolCalls: [] };
  };
  let observedSignal: AbortSignal | undefined;
  const ask = judge.ask.bind(judge);
  judge.ask = async (state: any, questions, signal?: AbortSignal) => {
    if (state.current_user_message === "第三轮") {
      observedSignal = signal;
      signal?.throwIfAborted();
    }
    if (questions.place) return { place: { type: "choice", choice: "new", probabilities: { new: 1 } } };
    return ask(state, questions);
  };
  const first = engine.observe("s", { user: "第二轮" });
  await bounded(entered.promise);
  const queued = engine.observe("s", { user: "第三轮" }, { timeoutMs: 150 });
  try { await new Promise((r) => setTimeout(r, 220)); }
  finally { release.resolve(); }
  await first;
  const result = await queued;
  assert.equal(result.error, undefined);
  assert.ok(observedSignal);
  assert.ok(result.recorded!.actions.every((a) => a.ok));
});

test("locks: another session's input is not rolled back with a failing file transaction", async (t) => {
  const { engine, store, llm } = fixture(t);
  await engine.observe("a", { user: "第一会话" });
  llm.push(writes({ new: [newFile("第一会话")] }));
  const entered = deferred(); const release = deferred();
  const write = store.write.bind(store);
  store.write = async (...args) => { await write(...args); entered.resolve(); await release.promise; throw new Error("write-back failure"); };
  const first = engine.flush("a");
  await bounded(entered.promise);
  const second = engine.observe("b", { id: "b", user: "第二会话必须留下" }, { timeoutMs: 150 });
  release.resolve();
  await first;
  assert.equal((await second).error, undefined);
  assert.equal(engine.meta.segment("b").pending[0].id, "b");
  assert.equal(engine.meta.segment("a").pending.length, 1);
  store.write = write;
});

async function appendTurn(engine: MemoryEngine, llm: ScriptedLlm, session: string, text: string) {
  await engine.observe(session, { user: text });
  llm.push(update(text));
  const r = await engine.flush(session);
  assert.ok(r!.actions.every((a) => a.ok));
  return r!;
}

test("markers: keep 20 recent ids; an older committed action replays from SQLite without duplication", async (t) => {
  const { engine, store, llm } = fixture(t);
  const old = await store.upsert({ type: "event", topic: "记事", text: "原文" });
  await engine.observe("old", { user: "最早追加" });
  llm.push(update("最早追加"));
  const complete = engine.meta.complete.bind(engine.meta);
  engine.meta.complete = () => { throw new Error("checkpoint failure"); };
  await assert.rejects(engine.flush("old"), /checkpoint/);
  engine.meta.complete = complete;
  const job = engine.meta.jobs("old")[0];
  const firstAction = engine.meta.receipts<any>(job.id)[0];
  for (let i = 0; i < 24; i++) await appendTurn(engine, llm, `s${i}`, `后续追加${i}`);
  const rec = (await store.get(old.rec.uri))!;
  assert.equal(rec.appliedActions!.length, 20);
  assert.ok(!rec.appliedActions!.includes(firstAction.id));
  assert.equal(engine.meta.receipt<any>(firstAction.id)!.ok, true);
  const before = llm.seen.length;
  await engine.flush("old");
  assert.equal(llm.seen.length, before);
  assert.equal((await store.get(old.rec.uri))!.body.split("最早追加").length - 1, 1);
});

test("markers: unacknowledged old ids survive the window until their crash receipt is recovered", async (t) => {
  const { root, engine, store, llm, judge } = fixture(t, { maxAttempts: 1 });
  const old = await store.upsert({ type: "event", topic: "记事", text: "原文" });
  await engine.observe("old", { user: "崩溃时追加" });
  llm.push(update("崩溃时追加"));
  const receipt = engine.meta.saveReceipt.bind(engine.meta);
  engine.meta.saveReceipt = () => { throw new Error("receipt unavailable"); };
  await engine.flush("old");
  engine.meta.saveReceipt = receipt;
  const job = engine.meta.jobs("old", true)[0];
  const firstId = (await store.get(old.rec.uri))!.appliedActions![0];
  assert.equal(job.status, "quarantined");
  for (let i = 0; i < 24; i++) await appendTurn(engine, llm, `s${i}`, `后续追加${i}`);
  const rec = (await store.get(old.rec.uri))!;
  assert.equal(rec.appliedActions!.length, 21, "20 recent ids plus the still-unacknowledged marker");
  assert.ok(rec.appliedActions!.includes(firstId));
  assert.equal(engine.meta.receipt(firstId), null);
  engine.meta.close();
  const freshLlm = new ScriptedLlm();
  const fresh = new MemoryEngine({ store: new MemoryStore(root), llm: freshLlm, judge });
  assert.ok((await fresh.retrySegment(job.id))!.actions.every((a) => a.ok));
  assert.equal(freshLlm.seen.length, 0, "the persisted plan and file marker recover without generation");
  assert.equal((await fresh.store.get(old.rec.uri))!.body.split("崩溃时追加").length - 1, 1);
  await appendTurn(engine, llm, "last", "最后一次追加");
  assert.equal((await store.get(old.rec.uri))!.appliedActions!.length, 20);
  assert.ok(!(await store.get(old.rec.uri))!.appliedActions!.includes(firstId));
});

test("migration: pre-budget SQLite jobs keep their source and gain persistent attempt fields", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { root, engine, llm } = fixture(t);
  const db = new DatabaseSync(path.join(root, ".meta.sqlite"));
  db.exec("CREATE TABLE segment_jobs (id TEXT PRIMARY KEY, session TEXT NOT NULL, turns TEXT NOT NULL, earlier TEXT NOT NULL, continuation_of TEXT, status TEXT NOT NULL DEFAULT 'sealed', decision TEXT)");
  db.prepare("INSERT INTO segment_jobs (id, session, turns, earlier) VALUES (?, ?, ?, ?)")
    .run("legacy-job", "legacy-session", JSON.stringify([{ id: "legacy-run", user: "迁移前原话" }]), "[]");
  db.close();
  assert.equal(engine.meta.job("legacy-job")!.attempts, 0);
  assert.equal(engine.meta.job("legacy-job")!.lastError, null);
  llm.push(writes({ new: [newFile("迁移前原话")] }));
  assert.ok((await engine.flush("legacy-session"))!.actions.every((a) => a.ok));
  assert.equal(engine.meta.job("legacy-job")!.attempts, 1);
  assert.equal(engine.meta.job("legacy-job")!.status, "committed");
  assert.equal(engine.meta.segment("legacy-session").tail[0].id, "legacy-run");
});
