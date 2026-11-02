// The Yuzuha seed memory (personas/yuzuha/memory_seed): the files a test run
// starts from must load through memkit's own store exactly like files the
// writer produced, and be findable. Offline: BM25 recall, no models.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore, renderUri } from "../src/store.ts";
import { MemoryEngine } from "../src/engine.ts";
import { relativeWithoutDate } from "../src/dates.ts";
import { OverlapJudge, ScriptedLlm } from "./fakes.ts";

const SEED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../personas/yuzuha/memory_seed");

async function seededStore(): Promise<MemoryStore> {
  const root = mkdtempSync(path.join(tmpdir(), "memkit-seed-"));
  for (const side of ["user", "assistant"]) cpSync(path.join(SEED, side), path.join(root, side), { recursive: true });
  return new MemoryStore(root);
}

// Dates, weekdays, clock times and relative time words do not belong in a topic.
const TIME_IN_TOPIC = [
  /\d{4}\s*[-/.年]\s*\d{1,2}/,
  /\d{1,2}\s*月\s*\d{1,2}\s*[日号]?/,
  /\d{1,2}\s*[:：]\s*\d{2}/,
  /\d+\s*点/,
  /(周|星期|礼拜)[一二三四五六日天末]/,
  /(大?前天|大?后天|昨天|昨晚|今天|今晚|今早|明天|明早|明晚|去年|今年|明年|上个?月|下个?月|这个?月|上次|下次|上周|下周|这周|本周|刚才|最近)/,
];

test("seed: every file parses through MemoryStore with topic, summary, type and entries", { skip: !existsSync(SEED) }, async () => {
  const store = await seededStore();
  const all = await store.all();
  assert.ok(all.length >= 8 && all.length <= 15, `8–15 seed files, got ${all.length}`);
  for (const r of all) {
    const where = r.uri;
    assert.ok(r.topic.trim(), `${where}: topic`);
    assert.ok(r.summary.trim(), `${where}: summary`);
    assert.ok(r.type === "event" || r.type === "principle", `${where}: type`);
    assert.equal(r.uri.split("/")[1], r.type, `${where}: directory matches type`);
    assert.equal(renderUri(r.scope, r.type, r.topic), r.uri, `${where}: file name is slug(topic)`);
    const bullets = r.body.split("\n").filter((l) => l.startsWith("- "));
    assert.equal(bullets.length, r.body.split("\n").length, `${where}: body is bullets only`);
    assert.equal(r.entries, bullets.length, `${where}: entries count`);
    assert.ok(bullets.length >= 2 && bullets.length <= 6, `${where}: 2–6 entries`);
    assert.ok(r.times.length >= 1 && r.times.every((t) => !Number.isNaN(Date.parse(t))), `${where}: times`);
    assert.ok(!Number.isNaN(Date.parse(r.createdAt)) && !Number.isNaN(Date.parse(r.updatedAt)), `${where}: created/updated`);
    const raw = readFileSync(path.join(store.root, `${r.uri}.md`), "utf8");
    assert.ok(!raw.includes("{{"), `${where}: no placeholders`);
    const imp = /^importance:\s*(.+)$/m.exec(raw);
    assert.ok(imp && Number(imp[1]) === 1, `${where}: seed importance is 1 (pinned, no forgetting)`);
    for (const re of TIME_IN_TOPIC) assert.ok(!re.test(r.topic), `${where}: time word in topic (${re})`);
    // Canon events have no calendar date, so entries carry no relative time
    // words either (the writer's post-check would send those back).
    for (const line of bullets) assert.deepEqual(relativeWithoutDate(line), [], `${where}: relative time word in「${line}」`);
  }
  const sides = new Set(all.map((r) => r.scope));
  assert.ok(sides.has("user") && sides.has("assistant"), "both sides seeded");
});

test("seed: BM25 recall finds known entries", { skip: !existsSync(SEED) }, async () => {
  const store = await seededStore();
  const e = new MemoryEngine({ store, judge: new OverlapJudge(), llm: new ScriptedLlm(), embedder: null, opts: { retrieval: "bm25", k: 5 } });
  const cases: [string, string][] = [
    ["你最爱吃饮茶仙的什么？虾饺吗", "assistant/principle/吃东西和热量"],
    ["还记得菲洛克斯那次吗", "assistant/event/卫非地风波"],
    ["我们约好暑假一起去海边的", "assistant/event/约好暑假一起去海边"],
    ["我的录像店叫什么来着", "user/event/哲和录像店"],
  ];
  for (const [q, uri] of cases) {
    const r = await e.retrieve(q);
    assert.equal(r.recallSource, "bm25");
    assert.ok(r.hits.some((h) => h.record.uri === uri), `「${q}」 → ${uri}; got ${r.hits.map((h) => h.record.uri).join(", ")}`);
  }
});
