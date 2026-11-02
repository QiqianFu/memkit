// Dense recall with BGE-M3: which memory files are worth showing the judge.
//
// BGE only RECALLS. It never decides what reaches the answering model: every
// recalled file still goes through a Jev judgment (see engine.ts). So recall
// matters more than precision here, and a missing or failing embedding
// service degrades to lexical recall (BM25) instead of failing the turn.
//
// The service is any OpenAI-compatible BGE-M3 endpoint:
// POST /v1/embeddings {input: [..], encoding_format: "base64"} → L2-normalised
// 1024-d CLS vectors (cosine = dot product), max 8,192 tokens per input
// (longer inputs are silently truncated server-side), at most 512 inputs per
// request. We cut inputs to a character budget BEFORE sending, so what gets
// embedded is a choice we make (topic + current summary + the newest entries,
// see view.ts) rather than an accident of server-side truncation; an input the
// server still reports truncated is re-embedded shorter.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { postJson } from "./http.ts";
import type { MemoryRecord } from "./types.ts";
import { fileText } from "./view.ts";

export interface Embedder {
  readonly name: string;
  /** One L2-normalised vector per input, same order. */
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

export interface BgeConfig {
  baseUrl: string;
  /** Bearer token; empty = no Authorization header (a local server without auth). */
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /**
   * Characters kept per input. BGE-M3 stops at 8,192 tokens; Chinese runs about
   * one token per character and mixed text a little under, so 6,000 characters
   * stays inside the window with room to spare.
   */
  maxChars?: number;
}

const MAX_BATCH = 64; // the service allows 512; smaller batches keep each request quick

export class BgeEmbedder implements Embedder {
  readonly name: string;
  readonly maxChars: number;
  private cfg: BgeConfig;
  calls = 0;
  /** Inputs the server reported as truncated (re-embedded shorter; should stay 0 with maxChars). */
  truncated = 0;

  constructor(cfg: BgeConfig) {
    this.cfg = cfg;
    this.maxChars = cfg.maxChars ?? 6000;
    this.name = `bge:${cfg.model ?? "bge-m3"}`;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH).map((t) => clip(t, this.maxChars));
      const { vecs, truncated } = await this.request(batch, signal);
      // The character budget should keep every input inside 8,192 tokens; if the
      // server still cut one, embed a shorter cut of it instead, so what is
      // embedded is always the whole text we chose, never a silent server cut.
      for (const j of truncated) {
        let text = batch[j];
        for (let tries = 0; tries < 4; tries++) {
          text = text.slice(0, Math.floor(text.length * 0.75));
          const again = await this.request([text], signal);
          vecs[j] = again.vecs[0];
          if (!again.truncated.length) break;
        }
      }
      out.push(...vecs);
    }
    return out;
  }

  private async request(batch: string[], signal?: AbortSignal): Promise<{ vecs: Float32Array[]; truncated: number[] }> {
    this.calls++;
    const res = await postJson(
      `${this.cfg.baseUrl.replace(/\/$/, "")}/v1/embeddings`,
      { model: this.cfg.model ?? "bge-m3", input: batch, encoding_format: "base64" },
      { headers: this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}, timeoutMs: this.cfg.timeoutMs ?? 20000, signal },
    );
    const truncated: number[] = Array.isArray(res?.truncated) ? res.truncated.map(Number).filter((n: number) => n >= 0 && n < batch.length) : [];
    this.truncated += truncated.length;
    const data: any[] = Array.isArray(res?.data) ? [...res.data] : [];
    data.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
    if (data.length !== batch.length) throw new Error(`bge returned ${data.length} vectors for ${batch.length} inputs`);
    return { vecs: data.map((d) => decodeVector(d.embedding)), truncated };
  }
}

/** Keep the head of a text within the character budget. */
export function clip(text: string, maxChars: number): string {
  const t = (text ?? "").trim();
  return t.length <= maxChars ? t : t.slice(0, maxChars);
}

export function decodeVector(v: unknown): Float32Array {
  if (typeof v === "string") {
    const buf = Buffer.from(v, "base64");
    // Copy into an aligned buffer: little-endian float32, as the service sends.
    const out = new Float32Array(buf.length / 4);
    for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
    return out;
  }
  if (Array.isArray(v)) return Float32Array.from(v.map(Number));
  throw new Error("bge: unexpected embedding encoding");
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** What a memory file is embedded as: topic, current summary, then its newest entries. */
export function docText(r: MemoryRecord, maxChars = 6000): string {
  return fileText(r, maxChars);
}

/**
 * Per-store vector cache (`<root>/.embeddings.json`), keyed by uri and the
 * hash of the exact text embedded, so a file is re-embedded only when it
 * changes (an append rewrites its summary and body). Files no longer in the
 * store are dropped on save.
 */
export class EmbeddingIndex {
  readonly file: string;
  private embedder: Embedder;
  private maxChars: number;
  private cache: Map<string, { hash: string; vec: Float32Array }> | null = null;
  private model: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(root: string, embedder: Embedder, maxChars = 6000) {
    this.file = path.join(root, ".embeddings.json");
    this.embedder = embedder;
    this.maxChars = maxChars;
    this.model = embedder.name;
  }

  private async load(): Promise<Map<string, { hash: string; vec: Float32Array }>> {
    if (this.cache) return this.cache;
    const m = new Map<string, { hash: string; vec: Float32Array }>();
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8"));
      if (raw?.model === this.model)
        for (const [uri, e] of Object.entries<any>(raw.entries ?? {})) m.set(uri, { hash: e.hash, vec: decodeVector(e.v) });
    } catch {
      // no cache yet, or unreadable: rebuild
    }
    this.cache = m;
    return m;
  }

  /** Vectors for these records, embedding only the new or changed ones. */
  vectors(records: MemoryRecord[], signal?: AbortSignal): Promise<Map<string, Float32Array>> {
    // Serialised so two concurrent turns never embed the same file twice or
    // interleave cache writes.
    const run = this.chain.then(async () => {
      const cache = await this.load();
      const want = records.map((r) => {
        const text = docText(r, this.maxChars);
        return { r, text, hash: createHash("sha1").update(text).digest("hex") };
      });
      const stale = want.filter((w) => cache.get(w.r.uri)?.hash !== w.hash);
      if (stale.length) {
        const vecs = await this.embedder.embed(
          stale.map((w) => w.text),
          signal,
        );
        stale.forEach((w, i) => cache.set(w.r.uri, { hash: w.hash, vec: vecs[i] }));
      }
      // `records` may be one scope only. It is not a complete inventory, so it
      // must not evict the other scope's vectors (retain() does that).
      if (stale.length) await this.save(cache);
      return new Map(want.map((w) => [w.r.uri, cache.get(w.r.uri)!.vec]));
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Called with a complete store inventory, never a routing shortlist. */
  retain(uris: string[]): Promise<void> {
    const run = this.chain.then(async () => {
      const cache = await this.load();
      const live = new Set(uris);
      let changed = false;
      for (const uri of cache.keys()) if (!live.has(uri)) { cache.delete(uri); changed = true; }
      if (changed) await this.save(cache);
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async save(cache: Map<string, { hash: string; vec: Float32Array }>): Promise<void> {
    const entries: Record<string, { hash: string; v: string }> = {};
    for (const [uri, e] of cache) entries[uri] = { hash: e.hash, v: Buffer.from(e.vec.buffer, e.vec.byteOffset, e.vec.byteLength).toString("base64") };
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify({ model: this.model, entries }), "utf8");
    await rename(tmp, this.file);
  }
}

/** The service token: inline value, or a file holding it (so it never needs copying into config). */
export function readToken(value?: string, file?: string): string {
  if (value) return value.trim();
  if (!file) return "";
  try {
    return readFileSync(file.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"), "utf8").trim();
  } catch {
    return "";
  }
}
