// Ingest-side time and role-play wording (DEVELOPMENT.md decision 31):
// titles carry no time, dated entries carry their weekday, every ingest Jev
// judgment sees when the segment was said, and the gate / scope / writer
// prompts treat the character's own statements as assistant-side memory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { MemoryEngine } from "../src/engine.ts";
import { MemoryStore } from "../src/store.ts";
import { timeWordsIn, weekdayProblems, withoutTimeWords } from "../src/dates.ts";
import {
  DATE_GUIDE,
  GATE_CRITERIA,
  GATE_QUESTION,
  INGEST_BACKGROUND,
  INGEST_SCOPE_CRITERIA,
  INGEST_SCOPE_QUESTION,
  INGEST_SYSTEM,
  SCOPE_BRIEF,
} from "../src/prompts.ts";
import { FakeEmbedder, FixedJudge, ScriptedLlm } from "./fakes.ts";

const tmp = () => mkdtempSync(path.join(tmpdir(), "memkit-itime-"));
const reply = (files: Record<string, unknown>[]) => ({ content: JSON.stringify({ files }) });
const newFile = (uri: string, topic: string, body: string) => ({ mode: "new", uri, topic, summary: topic, body });

// ---------------------------------------------------------------- titles

test("titles: dates, weekdays, clock times and relative words are found; names with numbers are not", () => {
  const cases: [string, string[]][] = [
    ["周日见约定", ["周日"]],
    ["周日六分街日程", ["周日"]],
    ["九点见", ["九点"]],
    ["这周课表", ["这周"]],
    ["凌晨回笼觉到七点", ["七点"]],
    ["六号中午面摊之约", ["六号"]],
    ["我的生日11月2日", ["11月2日"]],
    ["明天的事", ["明天"]],
    ["下周三", ["下周三"]],
    ["周末安排", ["周末"]],
    ["11:30开会", ["11:30"]],
    ["十点半", ["十点半"]],
    // Not time: an ordinal, a numbered thing, a quantity, a name.
    ["第七号隧道观影约定", []],
    ["第十七号", []],
    ["3号线", []],
    ["5号楼", []],
    ["有一点难过", []],
    ["差一点赢", []],
    ["霓虹拳脚3连输小学生七把", []],
    ["午夜第九站台", []],
    ["周会时间", []],
    ["两个月", []],
  ];
  for (const [title, words] of cases) assert.deepEqual(timeWordsIn(title), words, title);
  assert.equal(withoutTimeWords("周日六分街看片约定"), "六分街看片约定");
});

test("ingest: a new file with time in its name or topic is bounced once with the reason", async () => {
  const llm = new ScriptedLlm()
    .push(reply([newFile("assistant/event/周日见约定", "周日见约定", "- 2026-11-02（周一）05:15 我说「周日见~」，即 2026-11-08（周日）见面")]))
    .push(reply([newFile("assistant/event/六分街看片之约", "六分街看片之约", "- 2026-11-02（周一）05:15 我说「周日见~」，即 2026-11-08（周日）见面")]));
  const store = new MemoryStore(tmp());
  const trace: any[] = [];
  const e = new MemoryEngine({ store, judge: new FixedJudge({ scope: "assistant" }), llm, embedder: new FakeEmbedder(), trace: (ev) => trace.push(ev) });
  const r = await e.ingest({ user: "[Mon 2026-11-02 05:15 GMT+8] 才五点一刻，睡吧", assistant: "好，真的躺下了。周日见~" });
  assert.equal(llm.seen.length, 2, "one corrective round");
  const complaint = String(llm.seen[1].at(-1)!.content);
  assert.match(complaint, /assistant\/event\/周日见约定 的文件名「周日见约定」带了时间「周日」/);
  assert.match(complaint, /不含日期、星期、钟点、相对时间的名字/);
  assert.deepEqual(r.actions.map((a) => [a.op, a.uri]), [["new", "assistant/event/六分街看片之约"]]);
  assert.equal(trace.some((t) => t.step === "title_time"), false);
});

test("ingest: a title still carrying time after the corrective round is kept, with a title_time trace warning", async () => {
  const proposal = reply([newFile("user/event/九点见", "九点见", "- 2026-11-02（周一）09:00 再聊")]);
  const llm = new ScriptedLlm().push(proposal).push(proposal);
  const store = new MemoryStore(tmp());
  const trace: any[] = [];
  const e = new MemoryEngine({ store, judge: new FixedJudge({}), llm, embedder: new FakeEmbedder(), trace: (ev) => trace.push(ev) });
  const r = await e.ingest({ user: "[Mon 2026-11-02 05:30 GMT+8] 好，九点见" });
  assert.equal(llm.seen.length, 2);
  assert.deepEqual(r.actions.map((a) => [a.op, a.uri, a.ok]), [["new", "user/event/九点见", true]]);
  const warn = trace.find((t) => t.step === "title_time");
  assert.deepEqual(warn?.detail.titles, [["user/event/九点见", "九点见", ["九点"]]]);
});

test("ingest: an update that renames the topic to one with time is bounced; an unchanged old timed topic is not", async () => {
  const store = new MemoryStore(tmp());
  await store.upsert({ type: "event", topic: "周日六分街看片约定", text: "- 2026-11-08（周日）13:00 看片", summary: "看片之约" });
  const uri = "user/event/周日六分街看片约定";
  const keep = new ScriptedLlm().push(reply([{ mode: "append", uri, importance: 0.5, topic: "周日六分街看片约定", summary: "看片之约", add: "- 2026-11-08（周日）15:00 吃点心" }]));
  const e1 = new MemoryEngine({ store, judge: new FixedJudge({ related: 0.9 }), llm: keep, embedder: new FakeEmbedder() });
  await e1.ingest({ user: "[Mon 2026-11-02 05:20 GMT+8] 看完三点吃点心，六分街看片那天" });
  assert.equal(keep.seen.length, 1, "the file's own old title is not the writer's doing");

  const rename = new ScriptedLlm()
    .push(reply([{ mode: "append", uri, importance: 0.5, topic: "下周日看片", summary: "看片之约", add: "- 2026-11-08（周日）理碟" }]))
    .push(reply([{ mode: "append", uri, importance: 0.5, topic: "六分街看片之约", summary: "看片之约", add: "- 2026-11-08（周日）理碟" }]));
  const e2 = new MemoryEngine({ store, judge: new FixedJudge({ related: 0.9 }), llm: rename, embedder: new FakeEmbedder() });
  await e2.ingest({ user: "[Mon 2026-11-02 05:21 GMT+8] 看片那天看完还要理碟" });
  assert.equal(rename.seen.length, 2);
  assert.match(String(rename.seen[1].at(-1)!.content), /topic「下周日看片」带了时间「下周日」/);
  assert.equal((await store.get(uri))!.topic, "六分街看片之约");
});

test("ingest: a time-free new title collides with an existing title that differs only by its time words", async () => {
  const store = new MemoryStore(tmp());
  await store.upsert({ scope: "assistant", type: "event", topic: "周日六分街看片约定", text: "- 2026-11-08（周日）13:00 看片", summary: "看片之约" });
  const llm = new ScriptedLlm()
    .push(reply([newFile("assistant/event/六分街看片约定", "六分街看片约定", "- 2026-11-08（周日）理碟")]))
    .push(reply([{ mode: "append", uri: "assistant/event/周日六分街看片约定", importance: 0.5, summary: "看片之约", add: "- 2026-11-08（周日）看完理碟" }]));
  const trace: any[] = [];
  const e = new MemoryEngine({ store, judge: new FixedJudge({ related: 0.1, scope: "assistant" }), llm, embedder: new FakeEmbedder(), trace: (ev) => trace.push(ev) });
  const r = await e.ingest({ user: "[Mon 2026-11-02 05:25 GMT+8] 看完记得理碟", assistant: "知道啦" });
  assert.deepEqual(trace.find((t) => t.step === "new_taken")?.detail.taken, [["assistant/event/六分街看片约定", "assistant/event/周日六分街看片约定"]]);
  assert.deepEqual(r.actions.map((a) => [a.op, a.uri]), [["update", "assistant/event/周日六分街看片约定"]]);
  assert.equal((await store.all()).length, 1);
});

test("ingest: a time-stripped key too short to mean anything does not collide (「九点见」 vs 「八点见」 → 「见」)", async () => {
  const store = new MemoryStore(tmp());
  await store.upsert({ type: "event", topic: "八点见", text: "- 2026-11-01（周日）20:00 见", summary: "八点见" });
  // The writer keeps a timed title (warned), but it must not be taken for 「八点见」.
  const proposal = reply([newFile("user/event/九点见", "九点见", "- 2026-11-02（周一）09:00 再聊")]);
  const llm = new ScriptedLlm().push(proposal).push(proposal);
  const trace: any[] = [];
  const e = new MemoryEngine({ store, judge: new FixedJudge({ related: 0.1 }), llm, embedder: new FakeEmbedder(), trace: (ev) => trace.push(ev) });
  await e.ingest({ user: "[Mon 2026-11-02 05:30 GMT+8] 好，九点见" });
  assert.equal(trace.some((t) => t.step === "new_taken"), false);
});

// ---------------------------------------------------------------- weekdays

test("weekdays: a dated entry needs its weekday, and the right one; yearless dates are exempt", () => {
  assert.deepEqual(weekdayProblems("- 2026-11-08 看片"), ["「2026-11-08」没有写星期（2026-11-08 是周日）"]);
  assert.deepEqual(weekdayProblems("- 2026-11-08（周六）看片"), ["「2026-11-08」的星期写错了（2026-11-08 是周日）"]);
  assert.deepEqual(weekdayProblems("- 2026-11-08（周日）13:00 在六分街 Random Play 看《第七号隧道》"), []);
  assert.deepEqual(weekdayProblems("- 周日（2026-11-08）看片"), []);
  assert.deepEqual(weekdayProblems("- 2026年11月8日 星期天 看片"), []);
  assert.deepEqual(weekdayProblems("- 我的生日是11月2日"), []);
  assert.deepEqual(weekdayProblems("- 2026-11-07（周六）、2026-11-08 两天"), ["「2026-11-08」没有写星期（2026-11-08 是周日）"]);
});

test("ingest: an entry with a date but no weekday is bounced once; the second reply stands", async () => {
  const llm = new ScriptedLlm()
    .push(reply([newFile("user/event/六分街看片之约", "六分街看片之约", "- 2026-11-08 看片")]))
    .push(reply([newFile("user/event/六分街看片之约", "六分街看片之约", "- 2026-11-08 看片")]));
  const store = new MemoryStore(tmp());
  const e = new MemoryEngine({ store, judge: new FixedJudge({}), llm, embedder: new FakeEmbedder() });
  const r = await e.ingest({ user: "[Mon 2026-11-02 05:15 GMT+8] 周日一点来六分街看片" });
  assert.equal(llm.seen.length, 2);
  assert.match(String(llm.seen[1].at(-1)!.content), /「2026-11-08」没有写星期（2026-11-08 是周日）/);
  assert.match(String(llm.seen[1].at(-1)!.content), /HH:MM/);
  assert.deepEqual(r.actions.map((a) => [a.op, a.ok]), [["new", true]], "a soft check never blocks the write");
});

test("prompts: DATE_GUIDE asks for date + weekday + clock and keeps the ambiguity rules; titles carry no time", () => {
  assert.match(DATE_GUIDE, /2026-11-08（周日）13:00 在六分街 Random Play 看《第七号隧道》/);
  assert.match(DATE_GUIDE, /只写「2026-11-08 看片」不够/);
  assert.match(DATE_GUIDE, /歧义规则/);
  assert.match(DATE_GUIDE, /不写进 topic 和文件名/);
  assert.match(INGEST_SYSTEM, /topic 和名字里不能有时间/);
  assert.match(INGEST_SYSTEM, /「周日见约定」→「六分街看片之约」/);
});

// ---------------------------------------------------------------- Jev sees the time

test("ingest: gate/scope and every related judgment see when the segment was said; files show their write times", async () => {
  const store = new MemoryStore(tmp());
  await store.upsert({ type: "event", topic: "六分街看片之约", text: "- 2026-11-08（周日）13:00 看片", summary: "看片之约", time: "2026-11-01T21:15:00Z" });
  const judge = new FixedJudge({ related: 0.1 });
  const llm = new ScriptedLlm().push(reply([newFile("user/event/暮色烟花", "暮色烟花", "- 用户在新碟里翻到《暮色烟花》")]));
  const e = new MemoryEngine({ store, judge, llm, embedder: new FakeEmbedder() });
  await e.ingestSegment(
    [
      { user: "[Mon 2026-11-02 05:16 GMT+8] 翻到一张《暮色烟花》", assistant: "<心声>想听他讲。</心声>老片子诶" },
      { user: "[Mon 2026-11-02 05:17 GMT+8] 周日一起看", assistant: "好呀" },
    ],
    [],
  );
  const gate = judge.calls.find((c) => c.questions.worth_storing)!.state as any;
  assert.equal(gate.spoken_at, "这段对话说于 2026-11-02（周一） 05:16 至 2026-11-02（周一） 05:17；对话里的「今天」「周日」「九点」都以说话的时间为准");
  assert.equal(gate.conversation[0].time, "2026-11-02（周一） 05:16");
  assert.equal(gate.conversation[1].time, undefined, "only the user's turns carry the time");
  assert.match(gate.conversation[1].text, /（没说出口的心声：想听他讲。）/, "Jev sees the monologue labelled as unspoken");
  const related = judge.calls.find((c) => c.questions.related)!;
  assert.equal((related.state as any).spoken_at, gate.spoken_at);
  assert.match((related.state as any).background, /spoken_at/);
  const mem = (related.questions.related as any).instructions.memory;
  assert.equal(mem.written_at.length, 1);
  assert.match(mem.written_at[0], /^2026-11-0[12]（周[一日]） \d{2}:\d{2}$/);
  assert.equal(mem.latest_time, undefined, "the UTC ISO latest_time is replaced on the ingest side");
});

test("ingest: a segment with no known time has no spoken_at (offline scenarios unchanged)", async () => {
  const judge = new FixedJudge({});
  const llm = new ScriptedLlm().push(reply([newFile("user/event/猫", "猫", "- 猫叫咪咪")]));
  const e = new MemoryEngine({ store: new MemoryStore(tmp()), judge, llm, embedder: new FakeEmbedder() });
  await e.ingest({ user: "我家猫叫咪咪", time: "第2天" });
  const gate = judge.calls.find((c) => c.questions.worth_storing)!.state as any;
  assert.deepEqual(Object.keys(gate), ["conversation"]);
});

test("writer: the files it is shown list their write times in local time with the weekday", async () => {
  const store = new MemoryStore(tmp());
  await store.upsert({ type: "event", topic: "六分街看片之约", text: "- 2026-11-08（周日）13:00 看片", summary: "看片之约", time: "2026-11-01T21:15:00Z" });
  const llm = new ScriptedLlm().push(reply([]));
  const e = new MemoryEngine({ store, judge: new FixedJudge({ related: 0.9 }), llm, embedder: new FakeEmbedder() });
  await e.ingest({ user: "[Mon 2026-11-02 05:20 GMT+8] 六分街看片那天别迟到" });
  const prompt = String(llm.seen[0][1].content);
  assert.match(prompt, /历次时间：2026-11-0[12]（周[一日]） \d{2}:\d{2}/);
  assert.doesNotMatch(prompt, /历次时间：2026-11-01T21:15/);
});

// ---------------------------------------------------------------- role-play wording

test("prompts: the gate and scope name the character's own statements as assistant-side memory, with transcript examples", () => {
  assert.match(GATE_QUESTION, /角色扮演的角色/);
  assert.match(GATE_QUESTION, /说出口的、关于它自己的具体事/);
  assert.match(GATE_QUESTION, /没说出口的心声[^。]*不算它说过的事/);
  assert.match(GATE_CRITERIA.true, /睡啦，七点还得爬起来/);
  assert.match(GATE_CRITERIA.true, /阿釜睡我枕头边/);
  assert.match(GATE_CRITERIA.false, /没有说出关于它自己的具体事/);
  assert.match(INGEST_SCOPE_QUESTION, /说出口的、关于它自己的具体事，是助手这边的记忆/);
  assert.match(INGEST_SCOPE_CRITERIA.assistant, /今天做了什么、在哪、吃了什么/);
  assert.match(INGEST_SCOPE_CRITERIA.assistant, /角色设定里本来就写着的身份信息（生日、家人是谁）不算/);
  assert.match(INGEST_SCOPE_CRITERIA.user, /助手只是在附和、提问、评论用户的事/);
  assert.match(INGEST_SCOPE_CRITERIA.both, /助手也说了自己的事/);
  assert.match(INGEST_BACKGROUND, /角色扮演的角色（助手）/);
});

test("prompts: the writer records the character's improvisations on the assistant side, keeps persona and monologue out", () => {
  assert.match(SCOPE_BRIEF.assistant, /即兴说出的细节也要记，说了就算数/);
  assert.match(SCOPE_BRIEF.assistant, /不写角色设定里本来就有的身份信息，不把心声里的念头写成事实/);
  assert.match(SCOPE_BRIEF.user, /助手（角色）说的关于它自己的事不写在这一侧/);
  assert.match(INGEST_SYSTEM, /一旦说出口就是它的经历，以后要照着说/);
  assert.match(INGEST_SYSTEM, /「睡啦，七点还得爬起来」→「我说 2026-11-02（周一）07:00 要起床」/);
  assert.match(INGEST_SYSTEM, /原先说…，后来改口…/);
  // The existing monologue and persona rules stay.
  assert.match(INGEST_SYSTEM, /\*\*不能\*\*从里面提取关于它自己的事实/);
  assert.match(INGEST_SYSTEM, /角色设定里写明的事（它的生日、家人、住处）也不写进记忆/);
  // Speaker labels unchanged (memory files and ROLEPLAY_RULES use User/Assistant sides).
  assert.match(INGEST_SYSTEM, /助手（角色）的话里/);
});
