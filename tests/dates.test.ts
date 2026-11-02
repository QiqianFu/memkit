// Time awareness: rule-based date resolution, the date search's candidate
// merge, the time_related question on the recall gate, and the writer's
// absolute-date post-check.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { MemoryEngine } from "../src/engine.ts";
import type { TraceEvent } from "../src/types.ts";
import { MemoryStore } from "../src/store.ts";
import type { Answer, Judge, Question } from "../src/judge.ts";
import { dateHits, envelopeOf, isoWeekday, mergeCandidates, parseNum, relativeWithoutDate, resolveDates, weekdayName } from "../src/dates.ts";
import { FakeEmbedder, OverlapJudge, ScriptedLlm } from "./fakes.ts";

const tmp = () => mkdtempSync(path.join(tmpdir(), "memkit-dates-"));

test("dates: weekday helpers and Chinese numerals", () => {
  assert.equal(weekdayName("2026-11-01"), "周日");
  assert.equal(isoWeekday("2026-11-01"), 7);
  assert.equal(isoWeekday("2026-11-02"), 1);
  assert.deepEqual(["6", "十", "十二", "二十", "二十一", "三十一", "两"].map(parseNum), [6, 10, 12, 20, 21, 31, 2]);
  assert.deepEqual(envelopeOf("[Sun 2026-11-01 10:32 CST] 你好"), { day: "2026-11-01", clock: "10:32" });
  assert.deepEqual(envelopeOf("[Mon 2026-11-02 04:36 GMT+8] 早"), { day: "2026-11-02", clock: "04:36" });
  assert.equal(envelopeOf("没有信封"), null);
});

// [today, expression, expected days]
const TABLE: [string, string, string[]][] = [
  // 2026-11-01 is a Sunday: this week runs 10-26 (Mon) … 11-01 (Sun).
  ["2026-11-01", "今天吃什么", ["2026-11-01"]],
  ["2026-11-01", "今晚早点睡", ["2026-11-01"]],
  ["2026-11-01", "明天来吗", ["2026-11-02"]],
  ["2026-11-01", "后天呢", ["2026-11-03"]],
  ["2026-11-01", "大后天", ["2026-11-04"]],
  ["2026-11-01", "你昨天说的", ["2026-10-31"]],
  ["2026-11-01", "昨晚那部片子", ["2026-10-31"]],
  ["2026-11-01", "前天", ["2026-10-30"]],
  ["2026-11-01", "大前天", ["2026-10-29"]],
  ["2026-11-01", "周六我们约了什么", ["2026-10-31", "2026-11-07"]], // past this week → also the coming one
  ["2026-11-01", "周日", ["2026-11-01"]],
  ["2026-11-01", "星期天", ["2026-11-01"]],
  ["2026-11-01", "礼拜三", ["2026-10-28", "2026-11-04"]],
  ["2026-11-01", "这周六", ["2026-10-31"]],
  ["2026-11-01", "本周一", ["2026-10-26"]],
  ["2026-11-01", "下周六", ["2026-11-07"]],
  ["2026-11-01", "下个星期三", ["2026-11-04"]],
  ["2026-11-01", "下下周三", ["2026-11-11"]],
  ["2026-11-01", "上周五", ["2026-10-23"]],
  ["2026-11-01", "上个礼拜五", ["2026-10-23"]],
  ["2026-11-01", "上上周一", ["2026-10-12"]],
  ["2026-11-01", "周末去哪", ["2026-10-31", "2026-11-01"]],
  ["2026-11-01", "这个周末", ["2026-10-31", "2026-11-01"]],
  ["2026-11-01", "下周末", ["2026-11-07", "2026-11-08"]],
  ["2026-11-01", "上个周末", ["2026-10-24", "2026-10-25"]],
  ["2026-11-01", "6号是哪天", ["2026-11-06"]],
  ["2026-11-01", "六号", ["2026-11-06"]],
  ["2026-11-01", "二十一号", ["2026-11-21"]],
  ["2026-11-01", "15日", ["2026-11-15"]],
  ["2026-11-01", "下个月5号", ["2026-12-05"]],
  ["2026-11-01", "上个月30号", ["2026-10-30"]],
  ["2026-11-01", "12月25日", ["2026-12-25"]],
  ["2026-11-01", "十二月二十五号", ["2026-12-25"]],
  ["2026-11-01", "明年3月1号生日", ["2027-03-01"]],
  ["2026-11-01", "去年11月2日", ["2025-11-02"]],
  ["2026-11-01", "2027年1月3日", ["2027-01-03"]],
  ["2026-11-01", "2026-11-02 那天", ["2026-11-02"]],
  ["2026-11-01", "2026/11/9", ["2026-11-09"]],
  ["2026-11-01", "[Sun 2026-11-01 10:32 CST] 明天见", ["2026-11-02"]], // the envelope is not a mention
  ["2026-11-01", "明年再说", []],
  ["2026-11-01", "123号房", []],
  ["2026-11-01", "我们聊点别的", []],
  ["2026-11-01", "2月30日", []],
  ["2026-11-01", "下周六和昨天", ["2026-11-07", "2026-10-31"]],
  // Month and year boundaries. 2026-12-30 is a Wednesday.
  ["2026-12-30", "明天", ["2026-12-31"]],
  ["2026-12-30", "后天", ["2027-01-01"]],
  ["2026-12-30", "周六", ["2027-01-02"]],
  ["2026-12-30", "下周一", ["2027-01-04"]],
  ["2026-12-30", "上周五", ["2026-12-25"]],
  ["2026-12-30", "下个月3号", ["2027-01-03"]],
  ["2026-12-30", "这周一", ["2026-12-28"]],
  // 2026-03-01 is a Sunday; February has 28 days.
  ["2026-03-01", "昨天", ["2026-02-28"]],
  ["2026-03-01", "上周六", ["2026-02-21"]],
  ["2026-03-01", "这周一", ["2026-02-23"]],
  ["2026-03-01", "上个月29号", []],
  // Leap year; 2028-03-01 is a Wednesday.
  ["2028-03-01", "昨天", ["2028-02-29"]],
  ["2028-03-01", "周一", ["2028-02-28", "2028-03-06"]],
  ["2026-01-01", "前天", ["2025-12-30"]],
  ["2026-01-01", "上周末", ["2025-12-27", "2025-12-28"]],
];

test("dates: resolution table", () => {
  for (const [today, expr, want] of TABLE) assert.deepEqual(resolveDates(expr, today), want, `${today} 「${expr}」`);
});

test("dates: an entry with relative time and no absolute date is flagged", () => {
  assert.deepEqual(relativeWithoutDate("- 周六去饮茶仙"), ["周六"]);
  assert.deepEqual(relativeWithoutDate("- 店长说明天来，下周再说"), ["明天", "下周"]);
  assert.deepEqual(relativeWithoutDate("- 2026-11-07（周六）去饮茶仙"), []);
  assert.deepEqual(relativeWithoutDate("- 11月7日（周六）去饮茶仙"), []);
  assert.deepEqual(relativeWithoutDate("- 喜欢吃虾饺"), []);
});

test("dates: date hits count text forms and write times; 11月2日 is not inside 11月21日", () => {
  const rec = (body: string, times: string[] = []) => ({ topic: "t", summary: "", body, times });
  assert.deepEqual(dateHits(rec("- 2026-11-07（周六）请客；11月7日再确认"), ["2026-11-07"]), { text: 2, times: 0 });
  assert.deepEqual(dateHits(rec("- 11月21日"), ["2026-11-02"]), { text: 0, times: 0 });
  assert.deepEqual(dateHits(rec("- 2026-11-21"), ["2026-11-02"]), { text: 0, times: 0 });
  assert.deepEqual(dateHits(rec("- 无日期", ["2026-11-02"]), ["2026-11-02"]), { text: 0, times: 1 });
});

test("dates: candidates are n date-matched files, then BGE up to the total, each once", () => {
  const id = (x: string) => x;
  const bge = ["b1", "b2", "b3", "d2", "b4", "b5", "b6", "b7", "b8", "b9"];
  assert.deepEqual(mergeCandidates(["d1", "d2", "d3", "d4"], bge, 10, 3, id), ["d1", "d2", "d3", "b1", "b2", "b3", "b4", "b5", "b6", "b7"]);
  // Fewer date matches than n: BGE fills more.
  assert.deepEqual(mergeCandidates(["d1"], bge, 5, 3, id), ["d1", "b1", "b2", "b3", "d2"]);
  // n = 0: plain BGE.
  assert.deepEqual(mergeCandidates(["d1"], bge, 3, 0, id), ["b1", "b2", "b3"]);
});

/** OverlapJudge with the gate's two answers fixed. */
class TimeJudge implements Judge {
  readonly name = "time";
  inner = new OverlapJudge();
  private time: number;
  private need: number;
  constructor(time: number, need = 0.9) {
    this.time = time;
    this.need = need;
  }
  get calls() { return this.inner.calls; }
  async ask(state: unknown, questions: Record<string, Question>): Promise<Record<string, Answer>> {
    const out = await this.inner.ask(state, questions);
    if (questions.need_recall) out.need_recall = { type: "noul", noul: this.need };
    if (questions.time_related) out.time_related = { type: "noul", noul: this.time };
    return out;
  }
}

const OLD = "2026-09-01T00:00:00Z"; // written long before: no write time hits the asked days

async function datedStore(): Promise<MemoryStore> {
  const store = new MemoryStore(tmp());
  await store.upsert({ type: "event", topic: "饮茶仙请客", text: "2026-11-07（周六）在饮茶仙由我请客", summary: "2026-11-07（周六）饮茶仙请客", time: OLD });
  await store.upsert({ type: "event", topic: "放映会", text: "2026-11-07 晚上店里开放映会；2026-11-07 前要把带子对完", summary: "放映会在 2026-11-07", time: OLD });
  await store.upsert({ type: "event", topic: "铃的生日", text: "铃的生日是 2026-12-03", summary: "铃生日 12-03", time: OLD });
  for (const t of ["约会安排", "周末安排", "我们约了什么", "约好的事", "星期六的计划"]) {
    await store.upsert({ type: "event", topic: t, text: `${t}：周六我们约了什么还没定`, summary: `${t}还没定`, time: OLD });
  }
  return store;
}

test("retrieve: time_related high → dates resolved, date-matched files lead the candidates (≤ timeFiles), traced", async () => {
  const store = await datedStore();
  const judge = new TimeJudge(0.9);
  const events: TraceEvent[] = [];
  const e = new MemoryEngine({ store, judge, llm: new ScriptedLlm(), embedder: new FakeEmbedder(),
    opts: { recall: 4, timeFiles: 1, queryRewrite: false }, trace: (ev) => events.push(ev) });
  const r = await e.retrieve("[Sun 2026-11-01 10:32 GMT+8] 周六我们约了什么？");
  // Same gate request carries both questions.
  assert.deepEqual(Object.keys(judge.calls[0].questions), ["need_recall", "time_related"]);
  assert.equal(r.time!.fired, true);
  assert.equal(r.time!.today, "2026-11-01");
  assert.deepEqual(r.time!.mentions, [{ text: "周六", dates: ["2026-10-31", "2026-11-07"] }]);
  // Two files name 2026-11-07; the one with more hits ranks first; timeFiles = 1 keeps one.
  assert.deepEqual(r.time!.dated, ["user/event/放映会"]);
  assert.equal(r.recalled.length, 4, "1 dated + 3 BGE");
  assert.equal(r.recalled[0].uri, "user/event/放映会");
  assert.deepEqual(r.recalled[0].dated, { text: 3, times: 0 });
  assert.equal(new Set(r.recalled.map((x) => x.uri)).size, 4, "no duplicates");
  // The per-file judge sees what 「周六」 resolved to.
  const perFile = judge.calls.slice(1);
  assert.ok(perFile.every((c) => /2026-11-07（周六）/.test(JSON.stringify((c.state as any).time_reference))));
  const tr = events.find((ev) => ev.step === "time")!;
  assert.deepEqual(tr.detail.used, ["user/event/放映会"]);
  assert.equal(events.find((ev) => ev.step === "gate")!.detail.time, 0.9);
});

test("retrieve: date-matched files are deduped against BGE and capped by timeFiles", async () => {
  const store = await datedStore();
  const e = new MemoryEngine({ store, judge: new TimeJudge(0.9), llm: new ScriptedLlm(), embedder: new FakeEmbedder(),
    opts: { recall: 3, timeFiles: 3, queryRewrite: false } });
  const r = await e.retrieve("[Sun 2026-11-01 10:32 GMT+8] 下周六放映会几点");
  assert.deepEqual(r.time!.dated!.sort(), ["user/event/放映会", "user/event/饮茶仙请客"]);
  assert.equal(r.recalled.length, 3);
  assert.equal(new Set(r.recalled.map((x) => x.uri)).size, 3);
  assert.deepEqual(r.recalled.slice(0, 2).map((x) => x.uri).sort(), ["user/event/放映会", "user/event/饮茶仙请客"]);
});

test("retrieve: time_related low → normal recall, no date search", async () => {
  const store = await datedStore();
  const judge = new TimeJudge(0.1);
  const e = new MemoryEngine({ store, judge, llm: new ScriptedLlm(), embedder: new FakeEmbedder(), opts: { recall: 3, timeFiles: 3, queryRewrite: false } });
  const r = await e.retrieve("[Sun 2026-11-01 10:32 GMT+8] 周六我们约了什么？");
  assert.deepEqual(r.time, { p: 0.1, fired: false });
  assert.ok(r.recalled.every((x) => !x.dated));
  assert.ok(judge.calls.slice(1).every((c) => !(c.state as any).time_reference));
});

test("retrieve: time_related fires but no date resolves → normal recall, still traced", async () => {
  const store = await datedStore();
  const events: TraceEvent[] = [];
  const e = new MemoryEngine({ store, judge: new TimeJudge(0.9), llm: new ScriptedLlm(), embedder: new FakeEmbedder(),
    opts: { recall: 3, queryRewrite: false }, trace: (ev) => events.push(ev) });
  const r = await e.retrieve("[Sun 2026-11-01 10:32 GMT+8] 我们上次约的是什么时候？");
  assert.equal(r.time!.fired, true);
  assert.deepEqual(r.time!.mentions, []);
  assert.deepEqual(r.time!.dated, []);
  assert.equal(r.recalled.length, 3);
  assert.ok(events.some((ev) => ev.step === "time" && Array.isArray(ev.detail.mentions)));
});

test("retrieve: timeAware off → the gate asks only need_recall", async () => {
  const store = await datedStore();
  const judge = new TimeJudge(0.9);
  const e = new MemoryEngine({ store, judge, llm: new ScriptedLlm(), embedder: new FakeEmbedder(), opts: { recall: 3, timeAware: false, queryRewrite: false } });
  const r = await e.retrieve("[Sun 2026-11-01 10:32 GMT+8] 周六我们约了什么？");
  assert.deepEqual(Object.keys(judge.calls[0].questions), ["need_recall"]);
  assert.equal(r.time, null);
});

test("retrieve: the gate declines → nothing recalled, the time answer is still reported", async () => {
  const store = await datedStore();
  const e = new MemoryEngine({ store, judge: new TimeJudge(0.9, 0.1), llm: new ScriptedLlm(), embedder: new FakeEmbedder() });
  const r = await e.retrieve("[Sun 2026-11-01 10:32 GMT+8] 周六好开心");
  assert.equal(r.gate!.recall, false);
  assert.deepEqual(r.time, { p: 0.9, fired: true });
  assert.equal(r.recalled.length, 0);
});

const writerReply = (body: string) => ({ content: JSON.stringify({ files: [{ mode: "new", uri: "user/event/饮茶仙请客", topic: "饮茶仙请客", summary: "饮茶仙请客", body }] }) });

test("ingest: the writer is told 'now', and a relative-only entry is bounced once", async () => {
  const llm = new ScriptedLlm().push(writerReply("- 周六去饮茶仙，我请客")).push(writerReply("- 2026-11-07（周六）去饮茶仙，我请客"));
  const store = new MemoryStore(tmp());
  const e = new MemoryEngine({ store, judge: new OverlapJudge(), llm, embedder: new FakeEmbedder() });
  const r = await e.ingest({ user: "[Sun 2026-11-01 10:32 GMT+8] 周六去饮茶仙吧，你请客", time: "2026-11-01T02:32:00Z" });
  assert.deepEqual(r.actions.map((a) => [a.op, a.ok]), [["new", true]]);
  assert.equal(llm.seen.length, 2, "one corrective round");
  const first = String(llm.seen[0][1].content);
  assert.match(first, /【现在】这段对话最后一句话说于 2026-11-01（周日） 10:32/);
  assert.match(String(llm.seen[0][0].content), /【时间怎么写】/);
  const complaint = String(llm.seen[1].at(-1)!.content);
  assert.match(complaint, /相对时间「周六」/);
  const rec = await store.get("user/event/饮茶仙请客");
  assert.match(rec!.body, /2026-11-07（周六）/);
});

test("ingest: a second relative-only reply is accepted (the check never blocks a write)", async () => {
  const llm = new ScriptedLlm().push(writerReply("- 明天去饮茶仙")).push(writerReply("- 明天去饮茶仙"));
  const store = new MemoryStore(tmp());
  const e = new MemoryEngine({ store, judge: new OverlapJudge(), llm, embedder: new FakeEmbedder() });
  const r = await e.ingest({ user: "[Sun 2026-11-01 10:32 GMT+8] 明天去饮茶仙", time: "2026-11-01T02:32:00Z" });
  assert.deepEqual(r.actions.map((a) => [a.op, a.ok]), [["new", true]]);
  assert.equal(llm.seen.length, 2);
  assert.match((await store.get("user/event/饮茶仙请客"))!.body, /明天去饮茶仙/);
});

test("ingest: an entry with an absolute date is not bounced; a segment with no known time is never bounced", async () => {
  const ok = new ScriptedLlm().push(writerReply("- 2026-11-02（周一）去饮茶仙，原话「明天」"));
  const e1 = new MemoryEngine({ store: new MemoryStore(tmp()), judge: new OverlapJudge(), llm: ok, embedder: new FakeEmbedder() });
  await e1.ingest({ user: "[Sun 2026-11-01 10:32 GMT+8] 明天去饮茶仙" });
  assert.equal(ok.seen.length, 1);
  const untimed = new ScriptedLlm().push(writerReply("- 明天去饮茶仙"));
  const e2 = new MemoryEngine({ store: new MemoryStore(tmp()), judge: new OverlapJudge(), llm: untimed, embedder: new FakeEmbedder() });
  await e2.ingest({ user: "明天去饮茶仙", time: "第2天" });
  assert.equal(untimed.seen.length, 1);
});
