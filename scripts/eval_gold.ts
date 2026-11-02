// Offline experiment harness: inject → probe → grade, one fresh store per scenario.
//
//   node scripts/eval_gold.ts --data data/goldset_v2.json [--limit 10] [--judge auto|jev|llm]
//        [--retrieval judge|bm25] [--concurrency 3] [--out runs/<name>]
//
// Each scenario's dialogue is ingested turn by turn (stamped with its day), then
// the probe question goes through retrieve → answer with NO access to the
// dialogue itself — the answer can only come from what memory kept. A grader
// (the same chat model, temperature 0) checks the answer against the gold
// answer and the rubric's must_contain / must_not_contain.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { buildEngine, jsonlTrace, resolveLlm } from "../src/config.ts";
import type { MemkitConfig } from "../src/config.ts";
import { extractJson } from "../src/llm.ts";
import type { TraceEvent } from "../src/types.ts";

const { values: args } = parseArgs({
  options: {
    data: { type: "string" },
    limit: { type: "string" },
    judge: { type: "string", default: "auto" },
    retrieval: { type: "string", default: "judge" },
    concurrency: { type: "string", default: "3" },
    out: { type: "string" },
    ids: { type: "string" },
  },
});

interface Scenario {
  id: string;
  skill?: string;
  inject: { day?: number; speaker?: string; text: string }[];
  probe: string;
  gold: string;
  abstention?: boolean;
  rubric?: { must_contain?: string[]; must_not_contain?: string[]; scoring_notes?: string };
}

const data = JSON.parse(readFileSync(String(args.data), "utf8"));
let scenarios: Scenario[] = Array.isArray(data) ? data : data.scenarios;
if (args.ids) {
  const want = new Set(String(args.ids).split(","));
  scenarios = scenarios.filter((s) => want.has(s.id));
}
if (args.limit) scenarios = scenarios.slice(0, Number(args.limit));

const runName = `${args.judge}-${args.retrieval}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const outDir = path.resolve(String(args.out ?? path.join("runs", runName)));
mkdirSync(outDir, { recursive: true });

const cfg: MemkitConfig = {
  judge: { backend: args.judge as "auto" | "jev" | "llm" },
  retrieve: { retrieval: args.retrieval as "judge" | "bm25" },
};
const grader = resolveLlm(cfg);

const GRADER_SYSTEM = `你是严格的评分员。给定一个问题、标准答案、评分要点和被测回答，判断被测回答是否正确。
- 必须包含 must_contain 里的每个要点（意思一致即可，不要求逐字）。
- 不能把 must_not_contain 描述的错误当成当前答案（只是叙述"原先是X、后来改了"不算错）。
- 若标准答案是"不知道/没被告知"（abstention），被测回答必须表示不记得或没被告知，编造具体值即为错。
只输出 JSON：{"correct": true|false, "reason": "<一句话>"}`;

function pickIngest(r: { gate: number | null; scope: unknown; targets: string[]; options: unknown; actions: unknown[] }) {
  return { gate: r.gate, scope: r.scope, targets: r.targets, options: r.options, actions: r.actions };
}

async function runOne(s: Scenario) {
  const root = mkdtempSync(path.join(tmpdir(), `memkit-${s.id}-`));
  const events: TraceEvent[] = [];
  const fileTrace = jsonlTrace(path.join(outDir, "traces", `${s.id}.jsonl`));
  const engine = buildEngine(root, { ...cfg, trace: false }, {
    trace: (ev) => {
      events.push(ev);
      fileTrace(ev);
    },
  });
  const t0 = Date.now();
  const ingests = [];
  // By segment, as in a live session: each line is judged against the lines
  // since the last record; the dialogue's last segment is flushed at the end.
  for (const turn of s.inject) {
    const r = await engine.observe(s.id, { user: turn.text, time: turn.day != null ? `第${turn.day}天` : undefined });
    ingests.push({ text: turn.text, shift: r.shift, error: r.error, recorded: r.recorded && pickIngest(r.recorded) });
  }
  const last = await engine.flush(s.id);
  ingests.push({ text: "(flush)", shift: null, recorded: last && pickIngest(last) });
  const tIngest = Date.now() - t0;
  const t1 = Date.now();
  const ret = await engine.retrieve(s.probe);  // no history: the dialogue was injected as memory, not shown
  const tRetrieve = Date.now() - t1;
  const answer = await engine.answer(s.probe, ret.evidence);

  const mustContain = s.rubric?.must_contain ?? [];
  const containHits = mustContain.filter((m) => answer.includes(m)).length;
  const gradeOnce = () => grader.chat(
    [
      { role: "system", content: GRADER_SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          question: s.probe,
          gold: s.gold,
          abstention: !!s.abstention,
          must_contain: mustContain,
          must_not_contain: s.rubric?.must_not_contain ?? [],
          notes: s.rubric?.scoring_notes ?? "",
          answer,
        }),
      },
    ],
    { json: true, temperature: 0, maxTokens: 1000 },
  );
  // The grader occasionally returns an empty/unparseable body; one retry keeps a
  // grading glitch from being scored as a wrong answer.
  let verdict = extractJson((await gradeOnce()).content) ?? {};
  if (typeof verdict.correct !== "boolean") verdict = extractJson((await gradeOnce()).content) ?? {};
  const files = (await engine.store.all()).map((r) => ({ uri: r.uri, scope: r.scope, summary: r.summary, times: r.times }));
  return {
    id: s.id,
    skill: s.skill ?? "",
    correct: verdict.correct === true,
    reason: String(verdict.reason ?? ""),
    exactContain: mustContain.length ? containHits / mustContain.length : null,
    answer,
    gold: s.gold,
    gate: ret.gate,
    rewrite: ret.rewrite,
    recallSource: ret.recallSource,
    recalled: ret.recalled,
    hits: ret.hits.map((h) => [h.record.uri, Number(h.score.toFixed(3))]),
    files,
    ingests,
    ms: { ingest: tIngest, retrieve: tRetrieve },
    judgeName: engine.judge.name,
    recallName: engine.embedder?.name ?? "bm25",
    traceEvents: events.length,
  };
}

async function main() {
  const results: Awaited<ReturnType<typeof runOne>>[] = [];
  const queue = [...scenarios];
  const workers = Array.from({ length: Number(args.concurrency) }, async () => {
    while (queue.length) {
      const s = queue.shift()!;
      try {
        const r = await runOne(s);
        results.push(r);
        console.log(`${r.correct ? "PASS" : "FAIL"} ${s.id} gate=${r.gate?.p ?? "-"} rewrite=${r.rewrite ? JSON.stringify(r.rewrite.query) : "-"} recall=${r.recallSource} passed=${r.hits.length}/${r.recalled.length} retrieve=${r.ms.retrieve}ms :: ${r.reason}`);
      } catch (e) {
        console.log(`ERROR ${s.id}: ${(e as Error).message}`);
        results.push({ id: s.id, skill: s.skill ?? "", correct: false, reason: `error: ${(e as Error).message}` } as any);
      }
    }
  });
  await Promise.all(workers);

  const bySkill: Record<string, { n: number; correct: number }> = {};
  for (const r of results) {
    const k = r.skill || "-";
    bySkill[k] ??= { n: 0, correct: 0 };
    bySkill[k].n++;
    if (r.correct) bySkill[k].correct++;
  }
  const ok = results.filter((r) => r.ms);
  const summary = {
    run: runName,
    judge: ok[0]?.judgeName,
    recall: ok[0]?.recallName,
    retrieval: args.retrieval,
    n: results.length,
    accuracy: results.filter((r) => r.correct).length / Math.max(1, results.length),
    bySkill,
    avgRetrieveMs: ok.reduce((s, r) => s + r.ms.retrieve, 0) / Math.max(1, ok.length),
    avgIngestMsPerTurn:
      ok.reduce((s, r) => s + r.ms.ingest / Math.max(1, r.ingests.length - 1), 0) / Math.max(1, ok.length),
    avgSegments: ok.reduce((s, r) => s + r.ingests.filter((g: any) => g.recorded).length, 0) / Math.max(1, ok.length),
    avgPassed: ok.reduce((s, r) => s + r.hits.length, 0) / Math.max(1, ok.length),
  };
  writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 1));
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  console.log(`→ ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
