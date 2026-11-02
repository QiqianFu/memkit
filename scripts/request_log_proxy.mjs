// Debug-only logging proxy: records every request body an OpenAI-compatible
// client sends, then forwards it unchanged to the real upstream and streams the
// response back. Used to see exactly what OpenClaw submits to the model
// (tools, system prompt, messages). Request headers are NOT logged, so API keys
// never reach the log file.
//
// Each row also carries timing (added fields; older readers ignore them):
// `ms` from receiving the request to the end of the upstream response (the
// main model's latency as OpenClaw sees it, minus OpenClaw's own overhead),
// `ttfbMs` to the upstream's response headers, and `status`. Because `ms` is
// only known at the end, a row is appended when its response finishes; `at`
// is still the time the request arrived.
//
// Fault injection for retry tests: `touch <log>.fail-next` makes the next
// request fail with a retryable 503 (the marker is consumed).
//
//   node scripts/request_log_proxy.mjs --port 18990 --upstream https://api.deepseek.com --log /tmp/requests.jsonl

import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "18990" },
    upstream: { type: "string", default: "https://api.deepseek.com" },
    log: { type: "string", default: "/tmp/model-requests.jsonl" },
  },
});

const HOP_BY_HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "accept-encoding"]);

createServer(async (req, res) => {
  const t0 = performance.now();
  const at = new Date().toISOString();
  const since = () => Math.round(performance.now() - t0);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  let body = null;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    body = { unparsed: raw.toString("utf8").slice(0, 2000) };
  }
  const failNext = `${args.log}.fail-next`;
  const injected = existsSync(failNext);
  if (injected) unlinkSync(failNext);
  const row = { at, method: req.method, path: req.url, injected503: injected || undefined, body };
  const log = (extra) => appendFileSync(args.log, JSON.stringify({ ...row, ...extra, ms: since() }) + "\n");
  if (injected) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "injected: server overloaded, please retry", type: "overloaded_error" } }));
    log({ status: 503 });
    return;
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
  try {
    const up = await fetch(new URL(req.url, args.upstream), {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : raw,
    });
    const out = {};
    up.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k) && k !== "content-encoding") out[k] = v;
    });
    const ttfbMs = since();
    res.writeHead(up.status, out);
    if (up.body) for await (const c of up.body) res.write(c);
    res.end();
    log({ status: up.status, ttfbMs });
  } catch (e) {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `proxy upstream error: ${e.message}` } }));
    log({ status: 502, error: String(e.message).slice(0, 200) });
  }
}).listen(Number(args.port), "127.0.0.1", () => console.log(`proxy :${args.port} -> ${args.upstream}, log ${args.log}`));
