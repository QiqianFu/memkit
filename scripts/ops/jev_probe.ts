// Re-ask the real Jev with recorded/reconstructed requests, optionally
// transformed by named variants, and print the answers side by side. For
// finding out WHY a judgment came out the way it did: vary one thing at a
// time (question wording, how much conversation, how a file is shown, ...).
//
//   node scripts/ops/jev_probe.ts [--env ~/.openclaw-memtest/.env] \
//        [--variants variants.mjs] [--only base,g1,...] [--repeat 1] \
//        [--out results.jsonl] request.json [request.json ...]
//
// A request file is {"meta": {...}, "request": {"model", "state", "questions"}}
// (rebuilt from a run's .meta.sqlite, or captured with scripts/request_log_proxy.mjs),
// or a bare {"state", "questions"}. A variants module default-exports
// { <name>: (request, meta) => request | null } — null skips that request
// for that variant; "base" (the request unchanged) is always available.
//
// The key is read from JEV_API_KEY / TYPESAFE_API_KEY in the environment or
// the --env file, and is never printed, logged or written anywhere. Requests
// run a few at a time; keep the number of calls modest.

import { readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { postJson } from "../../src/http.ts";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: "string", default: path.join(homedir(), ".openclaw-memtest/.env") },
    variants: { type: "string" },
    only: { type: "string" },
    repeat: { type: "string", default: "1" },
    out: { type: "string" },
    concurrency: { type: "string", default: "4" },
  },
});

function keyFrom(envFile: string): string {
  const fromEnv = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY;
  if (fromEnv) return fromEnv;
  let text = "";
  try { text = readFileSync(envFile.replace(/^~(?=\/)/, homedir()), "utf8"); } catch { /* reported below */ }
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?(JEV_API_KEY|TYPESAFE_API_KEY)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[2]) return m[2].replace(/^["']|["']$/g, "");
  }
  throw new Error(`no JEV_API_KEY in the environment or ${envFile}`);
}

const key = keyFrom(args.env!);
const baseUrl = (process.env.JEV_BASE_URL ?? "https://api.typesafe.ai").replace(/\/$/, "");
type Req = { model?: string; state: unknown; questions: Record<string, any> };
type Variant = (req: Req, meta: any) => Req | null;
const variants: Record<string, Variant> = { base: (r) => r };
if (args.variants) Object.assign(variants, (await import(pathToFileURL(path.resolve(args.variants)).href)).default);
const names = args.only ? args.only.split(",").map((s) => s.trim()).filter(Boolean) : Object.keys(variants);
for (const n of names) if (!variants[n]) throw new Error(`unknown variant ${n}`);

const jobs: { file: string; meta: any; variant: string; req: Req; rep: number }[] = [];
for (const file of positionals) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const meta = raw.meta ?? {};
  const req: Req = raw.request ?? raw;
  for (const v of names) {
    const out = variants[v](structuredClone(req), meta);
    if (!out) continue;
    for (let rep = 0; rep < Number(args.repeat); rep++) jobs.push({ file: path.basename(file), meta, variant: v, req: out, rep });
  }
}
console.error(`${jobs.length} Jev calls`);

const results: any[] = [];
let next = 0;
async function worker(): Promise<void> {
  while (next < jobs.length) {
    const j = jobs[next++];
    const t0 = performance.now();
    let answers: Record<string, number | string> = {};
    let error: string | undefined;
    try {
      const res = await postJson(`${baseUrl}/v1/systemone`, { model: j.req.model ?? "jev-latest", state: j.req.state, questions: j.req.questions }, {
        headers: { Authorization: `Bearer ${key}` }, timeoutMs: 30000,
      });
      for (const [q, a] of Object.entries<any>(res?.answers ?? {})) answers[q] = a?.noul ?? a?.choice;
    } catch (e) {
      // HttpError messages carry the status and a short body prefix, never the key.
      error = String((e as Error).message ?? e).slice(0, 200);
    }
    const chars = JSON.stringify({ state: j.req.state, questions: j.req.questions }).length;
    results.push({ file: j.file, variant: j.variant, rep: j.rep, answers, error, chars, ms: Math.round(performance.now() - t0), observed: j.meta.observed ?? null });
  }
}
await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency)) }, worker));

results.sort((a, b) => a.file.localeCompare(b.file) || names.indexOf(a.variant) - names.indexOf(b.variant) || a.rep - b.rep);
if (args.out) for (const r of results) appendFileSync(args.out, JSON.stringify(r) + "\n");
const fmt = (a: Record<string, number | string>) => Object.entries(a).map(([q, v]) => `${q}=${typeof v === "number" ? v.toFixed(2) : v}`).join(" ");
for (const r of results) {
  const obs = r.observed ? ` (run: ${fmt(Object.fromEntries(Object.entries(r.observed).filter(([, v]) => typeof v === "number")) as any)})` : "";
  console.log(`${r.file.padEnd(48)} ${r.variant.padEnd(14)} ${r.error ? `ERROR ${r.error}` : fmt(r.answers)}${obs}  [${r.chars} ch]`);
}
