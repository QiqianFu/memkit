import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { composeAnswerPrompt, PersonaSource, resolvePersonaPath } from "../src/persona.ts";
import { ANSWER_RULES, DEFAULT_ANSWER_PROMPT, recallBlock, recallUnavailable, ROLEPLAY_RULES, stripRecallBlock } from "../src/prompts.ts";

function quietLog() {
  const info: string[] = [];
  const warn: string[] = [];
  return { info, warn, log: { info: (m: string) => info.push(m), warn: (m: string) => warn.push(m) } };
}

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "memkit-persona-"));
}

/** Set a file's mtime explicitly: two writes within one clock tick must still count as a change. */
function touch(file: string, sec: number): void {
  utimesSync(file, sec, sec);
}

test("persona: no persona configured → exactly the old default prompt and assistant rules", () => {
  const { log, warn } = quietLog();
  const p = new PersonaSource({ log }).current();
  assert.equal(p.systemPrompt, `${DEFAULT_ANSWER_PROMPT}\n\n${ANSWER_RULES}`);
  assert.equal(p.rules, ANSWER_RULES);
  assert.equal(p.style, "assistant");
  assert.equal(p.origin, "default");
  assert.equal(warn.length, 0);
  // The default wording is what the existing e2e results were measured with.
  assert.match(DEFAULT_ANSWER_PROMPT, /^你是一个带长期记忆的助手。/);
  assert.match(ANSWER_RULES, /^【长期记忆使用规则】/);
});

test("persona: inline answerPrompt keeps the assistant rules (old behaviour)", () => {
  const { log } = quietLog();
  const p = new PersonaSource({ inline: "  你是测试助手。  ", log }).current();
  assert.equal(p.systemPrompt, `你是测试助手。\n\n${ANSWER_RULES}`);
  assert.equal(p.origin, "inline");
  assert.equal(p.style, "assistant");
});

test("persona: a persona file wins over answerPrompt and brings the role-play rules", () => {
  const dir = tmp();
  const file = path.join(dir, "card.md");
  writeFileSync(file, "﻿# 你是谁\n你是小灯。\n");
  const { log, info } = quietLog();
  const p = new PersonaSource({ file, inline: "你是测试助手。", log }).current();
  assert.equal(p.origin, "file");
  assert.equal(p.style, "roleplay");
  assert.equal(p.systemPrompt, `# 你是谁\n你是小灯。\n\n${ROLEPLAY_RULES}`);
  assert.doesNotMatch(p.systemPrompt, /测试助手/);
  assert.ok(info.some((m) => m.includes("persona loaded")));
});

test("persona: rules can be forced either way", () => {
  assert.equal(composeAnswerPrompt({ text: "你是小灯。", origin: "inline" }, "roleplay").rules, ROLEPLAY_RULES);
  assert.equal(composeAnswerPrompt({ text: "你是小灯。", origin: "file" }, "assistant").rules, ANSWER_RULES);
  // Forced role-play rules with nothing configured still use the default text.
  const p = composeAnswerPrompt({ origin: "default" }, "roleplay");
  assert.equal(p.systemPrompt, `${DEFAULT_ANSWER_PROMPT}\n\n${ROLEPLAY_RULES}`);
  // A blank persona text is no persona.
  assert.equal(composeAnswerPrompt({ text: "  \n", origin: "file" }).origin, "default");
});

test("persona: the file is re-read when it changes, and only then", () => {
  const dir = tmp();
  const file = path.join(dir, "card.md");
  writeFileSync(file, "你是小灯。");
  touch(file, 1_000_000);
  const { log, info } = quietLog();
  const src = new PersonaSource({ file, log });
  const first = src.current();
  assert.match(first.systemPrompt, /^你是小灯。/);
  assert.equal(src.current(), first, "unchanged file → the very same prompt object");
  writeFileSync(file, "你是小雨。");
  touch(file, 1_000_100);
  const second = src.current();
  assert.match(second.systemPrompt, /^你是小雨。/);
  assert.notEqual(second, first);
  assert.equal(info.filter((m) => m.includes("persona reloaded")).length, 1);
  // Same-size edit with a new mtime is still picked up.
  writeFileSync(file, "你是小风。");
  touch(file, 1_000_200);
  assert.match(src.current().systemPrompt, /^你是小风。/);
});

test("persona: missing file → one clear warning, fallback to answerPrompt, then picked up once it appears", () => {
  const dir = tmp();
  const file = path.join(dir, "nope.md");
  const { log, warn } = quietLog();
  const src = new PersonaSource({ file, inline: "你是测试助手。", log });
  const p = src.current();
  assert.equal(p.origin, "inline");
  assert.equal(p.style, "assistant", "auto rules follow the text actually in effect");
  src.current();
  assert.equal(warn.length, 1, "a persisting problem is logged once");
  assert.match(warn[0], /nope\.md/);
  assert.match(warn[0], /ENOENT/);
  assert.match(warn[0], /using answerPrompt/);
  writeFileSync(file, "你是小灯。");
  assert.equal(src.current().origin, "file");
});

test("persona: missing file and no answerPrompt → built-in default; a directory or empty file is not a persona", () => {
  const dir = tmp();
  const { log, warn } = quietLog();
  assert.equal(new PersonaSource({ file: path.join(dir, "x.md"), log }).current().systemPrompt, `${DEFAULT_ANSWER_PROMPT}\n\n${ANSWER_RULES}`);
  assert.match(warn[0], /built-in answer prompt/);
  assert.equal(new PersonaSource({ file: dir, log }).current().origin, "default");
  assert.match(warn[1], /not a regular file/);
  const empty = path.join(dir, "empty.md");
  writeFileSync(empty, "  \n");
  assert.equal(new PersonaSource({ file: empty, log }).current().origin, "default");
  assert.match(warn[2], /is empty/);
});

test("persona: a file that disappears after loading keeps the last good copy (save-by-rename)", () => {
  const dir = tmp();
  const file = path.join(dir, "card.md");
  writeFileSync(file, "你是小灯。");
  const { log, warn } = quietLog();
  const src = new PersonaSource({ file, inline: "你是测试助手。", log });
  assert.equal(src.current().origin, "file");
  renameSync(file, file + ".swp");
  const p = src.current();
  assert.equal(p.origin, "file");
  assert.match(p.systemPrompt, /^你是小灯。/);
  assert.match(warn[0], /keeping the last loaded persona/);
  rmSync(file + ".swp");
  writeFileSync(file, "你是小雨。");
  touch(file, 2_000_000);
  assert.match(src.current().systemPrompt, /^你是小雨。/);
});

test("persona: paths resolve against the state dir unless absolute or ~/", () => {
  assert.equal(resolvePersonaPath("persona/card.md", "/srv/state"), path.join("/srv/state", "persona/card.md"));
  assert.equal(resolvePersonaPath("/abs/card.md", "/srv/state"), "/abs/card.md");
  assert.equal(resolvePersonaPath("~/cards/a.md", "/srv/state"), path.join(homedir(), "cards/a.md"));
});

test("role-play rules keep the anti-fabrication rule and stay in character", () => {
  assert.match(ROLEPLAY_RULES, /<memkit-recall>/);
  assert.match(ROLEPLAY_RULES, /绝不能编出具体的数值、日期、人名/);
  assert.match(ROLEPLAY_RULES, /记忆归属=User/);
  assert.match(ROLEPLAY_RULES, /记忆归属=Assistant/);
  assert.match(ROLEPLAY_RULES, /time=/);
  assert.match(ROLEPLAY_RULES, /不要说自己是 AI 或助手/);
  // OpenClaw appends "Current model identity: …" after every hook prompt (unremovable); the rules pre-empt it.
  assert.match(ROLEPLAY_RULES, /Current model identity:/);
  // The rules talk to the character about the person, never about "用户".
  assert.doesNotMatch(ROLEPLAY_RULES, /用户/);
});

test("recall block: role-play header changes wording only; stripping and ids are unaffected", () => {
  const legacy = recallBlock("- x", "run-1");
  assert.match(legacy, /【记忆检索结果】/, "default wording unchanged");
  const rp = recallBlock("- x", "run-1", "roleplay");
  assert.match(rp, /^<memkit-recall id="run-1">\n【想起的往事】/);
  assert.doesNotMatch(rp, /检索|系统|用户/);
  assert.equal(stripRecallBlock(`${rp}\n\n你好`), "你好");
  assert.equal(stripRecallBlock(`${rp}\n\n你好`, new Set(["run-1"])), `${rp}\n\n你好`);
  assert.doesNotMatch(recallUnavailable("roleplay"), /检索|系统/);
  assert.equal(recallUnavailable(), "（记忆检索暂时不可用）");
});

test("renderPersona removes HTML comments and fills placeholders", async () => {
  const { renderPersona } = await import("../src/persona.ts");
  const r = renderPersona("<!--\n部署说明\n-->\n\n# 你是谁\n\n对方是{{player_name}}，{{ sibling }}。\n\n{{unknown}}", { player_name: "哲", sibling: "和妹妹铃一起开店" });
  assert.equal(r.text, "# 你是谁\n\n对方是哲，和妹妹铃一起开店。\n\n{{unknown}}");
  assert.deepEqual(r.missing, ["unknown"]);
});
