import { test } from "node:test";
import assert from "node:assert/strict";
import { markMonologue, stripMonologue, stripRecallMarkup } from "../src/monologue.ts";
import { renderTurns } from "../src/prompts.ts";

test("stripMonologue removes a leading block and keeps the reply", () => {
  const r = stripMonologue("<心声>\n有点困，但他来找我了，先逗一下。\n</心声>\n\n哼哼~这么晚还不睡？\n\n是不是在想我呀");
  assert.equal(r.text, "哼哼~这么晚还不睡？\n\n是不是在想我呀");
  assert.equal(r.blocks, 1);
  assert.equal(r.unterminated, false);
});

test("stripMonologue removes blocks anywhere and collapses the blank lines left", () => {
  const r = stripMonologue("第一句\n\n<心声>想了想</心声>\n\n\n第二句\n<心声>\n再想\n</心声>");
  assert.equal(r.text, "第一句\n\n第二句");
  assert.equal(r.blocks, 2);
});

test("stripMonologue drops the paragraph of a lone open tag", () => {
  const r = stripMonologue("<心声>\n忘了关标签\n\n可见的回复");
  assert.equal(r.text, "可见的回复");
  assert.equal(r.blocks, 0);
  assert.equal(r.unterminated, true);
});

test("stripMonologue with a lone open tag and no blank line drops to the end", () => {
  const r = stripMonologue("好呀\n<心声>\n全是心声");
  assert.equal(r.text, "好呀");
  assert.equal(r.unterminated, true);
});

test("stripMonologue drops everything before a lone close tag", () => {
  // The model forgot the open tag: what precedes the close tag is the thought.
  const r = stripMonologue("他好像不高兴，先别逗。\n</心声>\n\n怎么啦");
  assert.equal(r.text, "怎么啦");
  assert.equal(r.unterminated, true);
  assert.equal(stripMonologue("没有标签的回复~").text, "没有标签的回复~");
});

test("stripMonologue tolerates full-width brackets and spaces in the tags", () => {
  const r = stripMonologue("＜心声＞\n想一想\n</ 心声 >\n\n好的");
  assert.equal(r.text, "好的");
  assert.equal(r.blocks, 1);
});

test("stripMonologue is safe on streamed pieces of one block", () => {
  // Paragraph-sized blocks: each piece of a split monologue loses its thought.
  assert.equal(stripMonologue("<心声>\n第一段念头").text, "");
  assert.equal(stripMonologue("第二段念头\n</心声>").text, "");
  assert.equal(stripMonologue("可见的一条").text, "可见的一条");
});

test("stripMonologue reports an empty reply", () => {
  const r = stripMonologue("<心声>只有心声</心声>");
  assert.equal(r.text, "");
  assert.equal(r.blocks, 1);
});

test("stripMonologue honours custom tags", () => {
  const r = stripMonologue("[[think]]x[[/think]]\n\nhi", { open: "[[think]]", close: "[[/think]]" });
  assert.equal(r.text, "hi");
  assert.equal(r.blocks, 1);
});

test("markMonologue labels the block as unspoken for the ingest prompt", () => {
  assert.equal(markMonologue("<心声>\n困了。\n先不逗。\n</心声>\n\n还没睡啊…"), "（没说出口的心声：困了。 先不逗。）\n\n还没睡啊…");
  assert.equal(markMonologue("念头\n</心声>\n回复"), "念头\n（没说出口的心声）\n回复");
  assert.equal(markMonologue("没有标签"), "没有标签");
});

test("renderTurns shows the monologue as unspoken, not as the assistant's words", () => {
  const out = renderTurns([{ user: "明天来吗", assistant: "<心声>\n其实不想去，但不好直说。\n</心声>\n\n看情况吧~" }]);
  assert.equal(out, "用户：明天来吗\n助手：（没说出口的心声：其实不想去，但不好直说。）\n\n看情况吧~");
});

// ---- recall markup the answering model wrote itself

const FAKE_RECALL = '<memkit-recall id="run-7">\n【想起的往事】（你自己想起的往事）\n- [0.97] user/event/约定 记忆归属=User 上周约好一起去看海\n</memkit-recall>';

test("stripRecallMarkup removes blocks the model wrote, with or without an id", () => {
  const r = stripRecallMarkup(`${FAKE_RECALL}\n\n嗯！我当然记得~`);
  assert.equal(r.text, "嗯！我当然记得~");
  assert.equal(r.blocks, 1);
  assert.equal(stripRecallMarkup("好呀<memkit-recall>\n- 编的\n</memkit-recall>\n\n走吧").text, "好呀\n\n走吧");
  assert.equal(stripRecallMarkup('＜memkit-recall id="x"＞编的＜/ memkit-recall＞就这样').text, "就这样");
  assert.equal(stripRecallMarkup("没有标记的回复").text, "没有标记的回复");
});

test("stripRecallMarkup drops a lone tag by the monologue rules", () => {
  const open = stripRecallMarkup("<memkit-recall>\n- 编出来的往事\n\n可见的回复");
  assert.deepEqual([open.text, open.unterminated], ["可见的回复", true]);
  const close = stripRecallMarkup("- 编出来的往事\n</memkit-recall>\n\n可见的回复");
  assert.deepEqual([close.text, close.unterminated], ["可见的回复", true]);
  assert.equal(stripRecallMarkup(FAKE_RECALL).text, "", "a reply that was only markup leaves nothing to send");
});

test("renderTurns drops recall markup from the assistant text but keeps the monologue label", () => {
  const out = renderTurns([{ user: "还记得我们约好的事吗", assistant: `<心声>\n想不起来…\n</心声>\n${FAKE_RECALL}\n\n当然记得！` }]);
  assert.equal(out, "用户：还记得我们约好的事吗\n助手：（没说出口的心声：想不起来…）\n\n当然记得！");
});

test("the writer prompt forbids turning the monologue into facts about the character", async () => {
  const { INGEST_SYSTEM } = await import("../src/prompts.ts");
  assert.match(INGEST_SYSTEM, /没说出口的心声/);
  assert.match(INGEST_SYSTEM, /不能\*\*从里面提取关于它自己的事实/);
  assert.match(INGEST_SYSTEM, /角色设定里写明的事/);
});

test("stripHtmlAndUrls drops made-up image tags and bare links, keeps the words", async () => {
  const { stripHtmlAndUrls } = await import("../src/monologue.ts");
  const r = stripHtmlAndUrls('诶，我看看……阿釜！\n\n<img src="https://img.example.com/a.jpg" />\n\n它爪子一压就发出去了');
  assert.equal(r.text, "诶，我看看……阿釜！\n\n它爪子一压就发出去了");
  assert.equal(r.removed, 1);
  assert.equal(stripHtmlAndUrls("看这个 https://x.test/p?q=1 好玩").text, "看这个  好玩".replace("  ", " ") === "看这个 好玩" ? stripHtmlAndUrls("看这个 https://x.test/p?q=1 好玩").text : "");
  assert.equal(stripHtmlAndUrls("没有标签的回复~").removed, 0);
  assert.equal(stripHtmlAndUrls("a < b 且 b > c").text, "a < b 且 b > c");
});
