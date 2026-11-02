// The ingest related-or-not judgment: exactly what Jev receives per file.
//
// Regression for the e2e duplicate (2026-10-31): a segment that re-asked
// what user/event/小满生日 already held (the birthday, the dinner and peanut
// notes) next to an unrelated question got P(related) 0.37 from the real Jev,
// so the writer never saw the file and created user/event/女儿小满生日. The
// payload was complete (nothing clipped or truncated); what was missing was
// the framing: no background, and a question about "what this segment needs
// to remember" that a pure re-ask does not satisfy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { MemoryEngine } from "../src/engine.ts";
import { MemoryStore } from "../src/store.ts";
import { INGEST_BACKGROUND, RELATED_CRITERIA, RELATED_QUESTION } from "../src/prompts.ts";
import { FakeEmbedder, FixedJudge, ScriptedLlm, writes } from "./fakes.ts";

const tmp = () => mkdtempSync(path.join(tmpdir(), "memkit-related-"));

const DINNER_REPLY =
  "小满生日那天（11 月 12 日）晚饭，我记下的注意事项是：**全程避开花生**，包括花生、花生油、花生酱、花生碎，以及配料表写“可能含花生”的东西；" +
  "家里其他人如果吃花生，要分开做，餐具和案板也分开。\n\n菜单方向我之前给过这些，但你还没定：\n\n- 清蒸鱼\n- 红烧鸡翅\n- 白灼虾\n- 糖醋排骨\n- 时蔬\n- 长寿面或米饭\n" +
  "- 水果拼盘或蛋糕，需要确认不含花生，且没有交叉污染\n\n你想先定哪几道，还是有别的想法？";

// The segment and the recorded turns before it, as sealed in that run.
const TURNS = [
  { user: "我女儿哪天过生日？", assistant: "11 月 12 日（下个月 12 号）。" },
  { user: "那天晚饭给她做点什么好，有什么要注意的吗？", assistant: DINNER_REPLY },
  { user: "上回定的那个上限是几成来着？", assistant: "两成。凡高风险的事，最多动用小金库的两成。" },
];
const EARLIER = [
  { user: "我们组周会是什么时候、在哪开？", assistant: "你们组周会每周三下午三点，地点在 5 楼听涛会议室。" },
  { user: "那个会议室在几楼来着？", assistant: "5 楼，听涛会议室。" },
];

async function scenarioStore() {
  const store = new MemoryStore(tmp());
  await store.upsert({ type: "event", topic: "小满生日", text: "用户的女儿叫小满，生日是 11 月 12 日。", summary: "用户女儿小满的生日是11月12日" });
  await store.upsert({
    type: "event",
    topic: "小满生日",
    text: "用户问小满生日那天晚饭做什么好；助手建议全程避开花生，并给出清蒸鱼、红烧鸡翅等菜单方向；用户尚未确认具体菜单。",
    summary: "用户女儿小满的生日是11月12日；当天晚饭全程避开花生，具体菜单尚未确认。",
  });
  await store.upsert({ type: "principle", topic: "小金库高风险动用上限", text: "凡是高风险的营生，最多只能动用小金库的两成。", summary: "高风险营生最多动用小金库两成" });
  await store.upsert({ type: "event", topic: "组周会", text: "组周会每周三下午三点，5 楼听涛会议室。", summary: "组周会每周三下午三点，5 楼听涛会议室" });
  return store;
}

const relatedCall = (judge: FixedJudge, uri: string) =>
  judge.calls.find((c) => c.questions.related && (c.questions.related.instructions as any).memory.uri === uri)!;

test("related: Jev gets the ingest background, the whole segment and the whole file", async () => {
  const store = await scenarioStore();
  const judge = new FixedJudge({ related: 0.1 });
  const llm = new ScriptedLlm().push(writes({ new: [{ type: "event", topic: "x", summary: "x", body: "- x" }] }));
  const e = new MemoryEngine({ store, judge, llm, embedder: new FakeEmbedder() });
  await e.ingestSegment(TURNS, EARLIER);

  const call = relatedCall(judge, "user/event/小满生日");
  const st = call.state as any;
  // background first, then the recorded context, then the segment being recorded.
  assert.deepEqual(Object.keys(st), ["background", "earlier_conversation", "conversation"]);
  assert.equal(st.background, INGEST_BACKGROUND);
  // The background says what the segment and the context are, and that a
  // segment repeating what a file holds is normal.
  assert.match(st.background, /conversation 是这次要记录的这段对话/);
  assert.match(st.background, /earlier_conversation[^。]*只用来理解指代/);
  assert.match(st.background, /内容一样，是正常的/);
  // Nothing of this segment is clipped: the long reply arrives whole.
  assert.deepEqual(st.conversation.map((m: any) => m.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);
  assert.equal(st.conversation[3].text, DINNER_REPLY);
  assert.equal(st.earlier_conversation.length, 4);
  assert.equal(st.continuation, undefined, "not a size continuation");

  const q = call.questions.related as any;
  assert.equal(q.type, "noul");
  assert.equal(q.instructions.question, RELATED_QUESTION);
  assert.deepEqual(q.criteria, RELATED_CRITERIA);
  const mem = q.instructions.memory;
  assert.deepEqual(Object.keys(mem), ["uri", "scope", "type", "topic", "summary", "written_at", "times_written", "content"]);
  // Every write time, local with its weekday (not the UTC ISO string).
  assert.equal(mem.written_at.length, 2);
  for (const t of mem.written_at) assert.match(t, /^\d{4}-\d{2}-\d{2}（周[一二三四五六日]）/);
  const rec = (await store.get("user/event/小满生日"))!;
  assert.equal(mem.content, rec.body, "both entries, not a truncated tail");
  assert.equal(mem.summary, rec.summary);
  assert.equal(mem.times_written, 2);

  // The gate/scope request over the same segment is unchanged: no background.
  const gate = judge.calls.find((c) => c.questions.worth_storing)!;
  assert.deepEqual(Object.keys(gate.state as object), ["earlier_conversation", "conversation"]);
});

test("related: the question asks whether one of the segment's matters is the file's, repeats and questions included", () => {
  assert.match(RELATED_QUESTION, /聊到的事情里，有没有哪一件就是下面这个已有记忆文件讲的那件事/);
  assert.match(RELATED_CRITERIA.true, /重复了文件里已有的内容/);
  assert.match(RELATED_CRITERIA.true, /只是问到它、助手按记忆回答了它/);
  assert.match(RELATED_CRITERIA.true, /同时还聊了别的事，也不影响/);
  assert.match(RELATED_CRITERIA.false, /只在 earlier_conversation 里出现过/);
});

test("related: a file judged related to a re-asking segment reaches the writer (no duplicate)", async () => {
  const store = await scenarioStore();
  const judge = new FixedJudge({ related: { "user/event/小满生日": 0.99, "user/principle/小金库高风险动用上限": 0.99, "user/event/组周会": 0.03 } });
  const llm = new ScriptedLlm().push(writes({ updates: { "user/event/小满生日": { mode: "append", summary: "小满生日11月12日", add: "- 用户又问了一次" } } }));
  const e = new MemoryEngine({ store, judge, llm, embedder: new FakeEmbedder() });
  const r = await e.ingestSegment(TURNS, EARLIER);
  assert.ok(r.targets.includes("user/event/小满生日"));
  assert.ok(!r.targets.includes("user/event/组周会"), "the earlier topic is not a target");
  assert.match(String(llm.seen[0][1].content), /uri：user\/event\/小满生日/);
  assert.ok(r.actions.every((a) => a.ok && a.op === "update"));
  assert.equal((await store.all()).filter((f) => f.uri.includes("小满")).length, 1);
});

test("related: a file longer than fileChars is shown whole when the request budget allows; a full segment keeps the newest entries", async () => {
  const store = new MemoryStore(tmp());
  // 40 entries of ~150 characters: ~6,000 characters, over fileChars (3,000 here).
  for (let i = 0; i < 40; i++) {
    await store.upsert({ type: "event", topic: "出游", text: `第${i}条：${"出游安排的细节".repeat(20)}`, summary: "出游安排" });
  }
  const rec = (await store.get("user/event/出游"))!;
  const judge = new FixedJudge({ related: 0.1 });
  const llm = new ScriptedLlm()
    .push(writes({ new: [{ type: "event", topic: "a", summary: "a", body: "- a" }] }))
    .push(writes({ new: [{ type: "event", topic: "b", summary: "b", body: "- b" }] }));
  const e = new MemoryEngine({ store, judge, llm, embedder: new FakeEmbedder(), opts: { fileChars: 3000 } });

  await e.ingestSegment([{ user: "出游的安排再说一下" }], []);
  const whole = (relatedCall(judge, "user/event/出游").questions.related.instructions as any).memory;
  assert.equal(whole.older_entries_omitted, undefined);
  assert.equal(whole.content, rec.body);

  // A segment near segmentChars leaves less room: the oldest entries go first,
  // and the whole request still fits jevChars.
  judge.calls.length = 0;
  await e.ingestSegment(Array.from({ length: 4 }, (_, i) => ({ user: `出游第${i}件要带的${"东西".repeat(950)}` })), []);
  const call = relatedCall(judge, "user/event/出游");
  const cut = (call.questions.related.instructions as any).memory;
  assert.ok(cut.older_entries_omitted > 0);
  assert.ok(rec.body.endsWith(cut.content), "the newest entries are kept");
  assert.ok(JSON.stringify(call).length <= 11000 * 1.05, `request ${JSON.stringify(call).length} chars`);
});
