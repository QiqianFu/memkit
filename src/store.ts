// File-backed memory store: one markdown file per (scope, type, topic).
//
// Layout: <root>/<scope>/<type>/<slug>.md (scope: user | assistant), with a small frontmatter block of
// `key: <json>` lines followed by the body. Files are plain text on purpose —
// a person (or the host agent's own file tools) can read and edit them, and
// the store picks up outside edits on the next refresh() by mtime.
//
// The writer names existing target URIs and new ones. New files never silently merge.
// Journalled writes embed their stable action id in the same atomic rename
// as the body, so a crash before the SQLite receipt cannot duplicate an append.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { MemoryRecord, MemoryScope, MemoryType } from "./types.ts";
import { isMemoryScope, isMemoryType, MEMORY_SCOPES, MEMORY_TYPES, nowIso } from "./types.ts";
import { slug } from "./text.ts";
import { entries } from "./view.ts";
import { Conflict } from "./meta.ts";

export function renderUri(scope: MemoryScope, type: MemoryType, topic: string): string {
  return `${scope}/${type}/${slug(topic)}`;
}

const URI_RE = /^(user|assistant)\/(principle|event)\/[^/]+$/;

const FM_KEYS = ["topic", "type", "summary", "times", "tags", "created", "updated", "entries"] as const;

export function serialize(rec: MemoryRecord): string {
  const fm: Record<string, unknown> = {
    topic: rec.topic,
    type: rec.type,
    summary: rec.summary,
    times: rec.times,
    tags: rec.tags,
    created: rec.createdAt,
    updated: rec.updatedAt,
    entries: rec.entries,
  };
  const lines = FM_KEYS.map((k) => `${k}: ${JSON.stringify(fm[k])}`);
  if (rec.appliedActions?.length) lines.push(`memkit_actions: ${JSON.stringify(rec.appliedActions)}`);
  return `---\n${lines.join("\n")}\n---\n${rec.body.trim()}\n`;
}

export function parse(uri: string, raw: string): MemoryRecord | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const fm: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    try {
      fm[key] = JSON.parse(val);
    } catch {
      fm[key] = val; // hand-edited plain value
    }
  }
  const [scope, dirType, name] = uri.split("/");
  if (!isMemoryScope(scope)) return null;
  const type = isMemoryType(fm.type) ? fm.type : (dirType as MemoryType);
  if (!isMemoryType(type)) return null;
  const body = m[2].trim();
  return {
    ...(Array.isArray(fm.memkit_actions) ? { appliedActions: fm.memkit_actions.map(String) } : {}),
    uri,
    scope,
    type,
    topic: String(fm.topic ?? name ?? ""),
    summary: String(fm.summary ?? ""),
    body,
    times: Array.isArray(fm.times) ? fm.times.map(String) : [],
    tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
    createdAt: String(fm.created ?? ""),
    updatedAt: String(fm.updated ?? ""),
    entries: Number(fm.entries ?? (body.match(/^- /gm)?.length || 1)),
  };
}

/** A record's content identity: what a write-back checks the file still is. */
export function fingerprint(rec: MemoryRecord): string {
  return createHash("sha1").update(serialize(rec)).digest("hex");
}

/** One markdown bullet per non-empty line. */
export function bulletize(body: string): string {
  return body
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => (l.trimStart().startsWith("- ") ? l.trim() : `- ${l.trim()}`))
    .join("\n");
}

export type WriteOp = "new" | "update" | "rewrite" | "delete";

export class MemoryStore {
  readonly root: string;
  private cache = new Map<string, { rec: MemoryRecord; mtimeMs: number }>();
  // Serializes writes: background ingest and explicit tool calls share one root.
  private chain: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private file(uri: string): string {
    return path.join(this.root, `${uri}.md`);
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Re-scan the root, re-parsing only files whose mtime changed. */
  async refresh(): Promise<void> {
    await this.migrateLegacy();
    const seen = new Set<string>();
    for (const scope of MEMORY_SCOPES)
      for (const type of MEMORY_TYPES) {
        const dir = path.join(this.root, scope, type);
        let names: string[] = [];
        try {
          names = await fs.readdir(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.endsWith(".md")) continue;
          const uri = `${scope}/${type}/${name.slice(0, -3)}`;
          seen.add(uri);
          const st = await fs.stat(path.join(dir, name)).catch(() => null);
          if (!st) continue;
          const hit = this.cache.get(uri);
          if (hit && hit.mtimeMs === st.mtimeMs) continue;
          const raw = await fs.readFile(path.join(dir, name), "utf8").catch(() => "");
          const rec = parse(uri, raw);
          if (rec) this.cache.set(uri, { rec, mtimeMs: st.mtimeMs });
        }
      }
    for (const uri of [...this.cache.keys()]) if (!seen.has(uri)) this.cache.delete(uri);
  }

  private migrated = false;

  /**
   * Stores written before the scope level kept files at <root>/<type>/: they
   * were all the user's, so they move to <root>/user/<type>/ (a file already
   * there is left alone and the old copy kept in place).
   */
  private async migrateLegacy(): Promise<void> {
    if (this.migrated) return;
    this.migrated = true;
    for (const type of MEMORY_TYPES) {
      const from = path.join(this.root, type);
      const names = await fs.readdir(from).catch(() => null);
      if (!names) continue;
      const to = path.join(this.root, "user", type);
      await fs.mkdir(to, { recursive: true });
      for (const name of names) {
        if (!name.endsWith(".md")) continue;
        if (await fs.stat(path.join(to, name)).catch(() => null)) continue;
        await fs.rename(path.join(from, name), path.join(to, name)).catch(() => undefined);
      }
      await fs.rmdir(from).catch(() => undefined); // only if now empty
    }
  }

  /**
   * The file as it is on disk right now (bypassing the cache), normalised
   * through parse → serialize so it compares equal to `fingerprint(rec)` of a
   * record read from it. null when the file is gone.
   */
  async diskFingerprint(uri: string): Promise<string | null> {
    if (!URI_RE.test(uri)) return null;
    const raw = await fs.readFile(this.file(uri), "utf8").catch(() => null);
    if (raw === null) return null;
    const rec = parse(uri, raw);
    return rec ? fingerprint(rec) : `unparseable:${raw.length}`;
  }

  async all(): Promise<MemoryRecord[]> {
    await this.refresh();
    return [...this.cache.values()].map((v) => v.rec);
  }

  /** Read one file, re-parsing it if it changed on disk since it was cached. */
  async get(uri: string): Promise<MemoryRecord | null> {
    if (!URI_RE.test(uri)) return null;
    const file = this.file(uri);
    const st = await fs.stat(file).catch(() => null);
    if (!st) {
      this.cache.delete(uri);
      return null;
    }
    const hit = this.cache.get(uri);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.rec;
    const rec = parse(uri, await fs.readFile(file, "utf8").catch(() => ""));
    if (rec) this.cache.set(uri, { rec, mtimeMs: st.mtimeMs });
    return rec;
  }

  private async persist(rec: MemoryRecord): Promise<void> {
    const file = this.file(rec.uri);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const handle = await fs.open(tmp, "w");
    try { await handle.writeFile(serialize(rec), "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(tmp, file);
    const dir = await fs.open(path.dirname(file), "r");
    try { await dir.sync(); } finally { await dir.close(); }
    const st = await fs.stat(file);
    this.cache.set(rec.uri, { rec, mtimeMs: st.mtimeMs });
  }

  /**
   * Create a file, or MERGE into the existing one with the same rendered uri.
   * On merge the entry is appended (history is kept, not overwritten), the
   * time is appended to `times`, and a non-empty summary replaces the old one.
   */
  upsert(input: {
    scope?: MemoryScope;
    type: MemoryType;
    topic: string;
    text: string;
    summary?: string;
    time?: string;
    tags?: string[];
  }): Promise<{ rec: MemoryRecord; op: WriteOp }> {
    return this.locked(async () => {
      const scope = input.scope ?? "user";
      const uri = renderUri(scope, input.type, input.topic);
      const existing = await this.get(uri);
      const ts = nowIso();
      const time = input.time || ts;
      if (existing) {
        const rec: MemoryRecord = {
          ...existing,
          body: `${existing.body}\n- ${input.text.trim()}`.trim(),
          summary: input.summary?.trim() || existing.summary,
          times: [...existing.times, time],
          tags: [...new Set([...existing.tags, ...(input.tags ?? [])])].sort(),
          updatedAt: ts,
          entries: existing.entries + 1,
        };
        await this.persist(rec);
        return { rec, op: "update" as WriteOp };
      }
      const rec: MemoryRecord = {
        uri,
        scope,
        type: input.type,
        topic: input.topic.trim(),
        summary: (input.summary ?? "").trim(),
        body: `- ${input.text.trim()}`,
        times: [time],
        tags: [...new Set(input.tags ?? [])].sort(),
        createdAt: ts,
        updatedAt: ts,
        entries: 1,
      };
      await this.persist(rec);
      return { rec, op: "new" as WriteOp };
    });
  }

  /**
   * Write a file as the writer produced it.
   *   create  — a NEW file at `uri` (the writer's, validated by the engine;
   *             else rendered from the topic). It never merges into an existing
   *             one (that would land a new file in a file the writer never saw)
   *             and no longer suffixes (`<slug>_2`, … fragmented one topic into
   *             several files): a taken uri throws Conflict, and the engine
   *             shows the writer that file instead. Old `_N` files still load.
   *   append  — `body` (this turn's new lines) goes after the old body of `uri`.
   *   replace — `body` is the whole new body of `uri`.
   * Updates replace topic and summary too; the uri stays put even if the topic
   * was renamed.
   */
  write(input: {
    /** Stable id from a persisted segment plan. Repeating it never applies the write twice. */
    actionId?: string;
    expectedFingerprint?: string;
    mode: "create" | "append" | "replace";
    uri?: string;
    /** create: which side the new file belongs to. */
    scope?: MemoryScope;
    type: MemoryType;
    topic: string;
    summary: string;
    body: string;
    time?: string;
  }, opts: { retainActions?: (ids: string[]) => string[] } = {}): Promise<{ rec: MemoryRecord; op: "new" | "update" }> {
    return this.locked(async () => {
      const ts = nowIso();
      const time = input.time || ts;
      const body = bulletize(input.body);
      if (input.mode === "create") {
        // Covers a crash after rename but before the SQLite receipt was saved.
        if (input.actionId) {
          const applied = (await this.all()).find((r) => r.appliedActions?.includes(input.actionId!));
          if (applied) return { rec: applied, op: "new" as const };
        }
        const scope = input.scope ?? "user";
        const uri = input.uri ?? renderUri(scope, input.type, input.topic);
        if (await this.exists(uri)) throw new Conflict(uri);
        const rec: MemoryRecord = {
          ...(input.actionId ? { appliedActions: [input.actionId] } : {}),
          uri,
          scope,
          type: input.type,
          topic: input.topic.trim(),
          summary: input.summary.trim(),
          body,
          times: [time],
          tags: [],
          createdAt: ts,
          updatedAt: ts,
          entries: entries(body).length || 1,
        };
        await this.persist(rec);
        return { rec, op: "new" as const };
      }
      const existing = input.uri ? await this.get(input.uri) : null;
      if (!existing) throw new Error(`no such memory: ${input.uri}`);
      if (input.actionId && existing.appliedActions?.includes(input.actionId)) return { rec: existing, op: "update" as const };
      if (input.expectedFingerprint && await this.diskFingerprint(existing.uri) !== input.expectedFingerprint) throw new Conflict(existing.uri);
      const merged = input.mode === "replace" ? body : `${existing.body}\n${body}`.trim();
      const rec: MemoryRecord = {
        ...existing,
        ...(input.actionId ? { appliedActions: [...(existing.appliedActions ?? []), input.actionId] } : {}),
        topic: input.topic.trim() || existing.topic,
        summary: input.summary.trim() || existing.summary,
        body: merged,
        times: [...existing.times, time],
        updatedAt: ts,
        entries: entries(merged).length || 1,
      };
      // Only the transaction owner knows which old markers have committed
      // SQLite receipts. Unconfirmed markers must survive even outside the window.
      if (rec.appliedActions && opts.retainActions) rec.appliedActions = opts.retainActions(rec.appliedActions);
      await this.persist(rec);
      return { rec, op: "update" as const };
    });
  }

  private async exists(uri: string): Promise<boolean> {
    return (await fs.stat(this.file(uri)).catch(() => null)) !== null;
  }

  /** Replace a file's whole body (and optionally its summary). For corrections, not updates. */
  rewrite(uri: string, input: { body: string; summary?: string; time?: string }): Promise<MemoryRecord> {
    return this.locked(async () => {
      const existing = await this.get(uri);
      if (!existing) throw new Error(`no such memory: ${uri}`);
      const body = bulletize(input.body);
      const ts = nowIso();
      const rec: MemoryRecord = {
        ...existing,
        body,
        summary: input.summary?.trim() || existing.summary,
        times: [...existing.times, input.time || ts],
        updatedAt: ts,
        entries: body.match(/^- /gm)?.length || 1,
      };
      await this.persist(rec);
      return rec;
    });
  }

  remove(uri: string): Promise<boolean> {
    return this.locked(async () => {
      const existed = (await this.get(uri)) !== null;
      await fs.rm(this.file(uri), { force: true });
      this.cache.delete(uri);
      return existed;
    });
  }
}
