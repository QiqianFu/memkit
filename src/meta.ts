// File ranking metadata and the durable ingest journal.
//
// One row per memory file (<root>/.meta.sqlite): when it was created, when it
// was last written, and how important it is (0..1, 0.5 on creation; the writer
// re-rates it on every update). The markdown stays the user-readable memory;
// these numbers only steer recall order (see engine.ts), so they live where a
// person editing a file will not trip over them.
//
// Files that exist without a row (written before this table, or by hand) get
// one on first sight: times from the file's own frontmatter, importance 0.5.
// Rows whose file is gone are dropped.
//
// Its connection is also the cross-process write lock: an ingest writes back
// inside `transaction()` (BEGIN IMMEDIATE), so no other process's write can
// land between the ingest's last check that its files are unchanged and its
// own write (see engine.ts).

import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemoryRecord } from "./types.ts";

export const DEFAULT_IMPORTANCE = 0.5;

/** One user turn and the reply to it, as kept in a session's segment buffer. */
export interface SegmentTurn {
  /** Host run id, when available. Kept across retries and restarts. */
  id?: string;
  receivedAt?: number;
  user: string;
  assistant?: string;
  time?: string;
}

/**
 * A session's ingest state: uncommitted turns (`pending`, including sealed
 * jobs when read through segment()) and the last committed turns (`tail`,
 * only to resolve references). Kept here rather than as a position in the
 * host's transcript, which compaction and clean-up rewrite.
 */
export interface Segment {
  pending: SegmentTurn[];
  tail: SegmentTurn[];
  updatedAt: number;
}

export interface SegmentJob {
  id: string;
  session: string;
  turns: SegmentTurn[];
  earlier: SegmentTurn[];
  continuationOf: string | null;
  status: "sealed" | "quarantined" | "committed" | "skipped";
  attempts: number;
  lastError: string | null;
  /** Epoch ms of the last attempt (idle retries wait a full idle window after it). */
  attemptedAt: number | null;
  decision: { gate: number; scope: "user" | "assistant" | "both" | "empty" } | null;
}

export interface FileMeta {
  uri: string;
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
  /** 0..1. */
  importance: number;
}

export function clampImportance(x: unknown, fallback = DEFAULT_IMPORTANCE): number {
  const n = Number(x);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

export class Conflict extends Error {
  readonly uri: string;
  constructor(uri: string) {
    super(`memory file changed while this write was being prepared: ${uri}`);
    this.uri = uri;
  }
}

const ROW = "SELECT uri, created_at, updated_at, importance FROM meta";
const toMeta = (r: any): FileMeta => ({
  uri: r.uri,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  importance: Number(r.importance),
});

export class MetaStore {
  readonly file: string;
  private db: DatabaseSync | null = null;

  /**
   * One instance (one connection) per store per process: plugin re-registration
   * builds new engines on the same root, and two connections in one process
   * would block each other synchronously while a commit is open.
   */
  static for(root: string): MetaStore {
    const k = Symbol.for("memkit.metaStores.v1");
    const reg: Map<string, MetaStore> = ((globalThis as any)[k] ??= new Map());
    const file = path.resolve(root, ".meta.sqlite");
    let m = reg.get(file);
    if (!m) reg.set(file, (m = new MetaStore(root)));
    return m;
  }

  constructor(root: string) {
    this.file = path.resolve(root, ".meta.sqlite");
  }

  private open(): DatabaseSync {
    if (this.db) return this.db;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(
      "CREATE TABLE IF NOT EXISTS meta (" +
        "uri TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, " +
        "importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1))",
    );
    db.exec("CREATE TABLE IF NOT EXISTS segments (session TEXT PRIMARY KEY, pending TEXT NOT NULL, tail TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    // Mid-term memory: the recall blocks of the open segment's turns, by turn
    // (run) id. They stay in the conversation until their segment is sealed.
    db.exec("CREATE TABLE IF NOT EXISTS recall_blocks (session TEXT NOT NULL, turn_id TEXT NOT NULL, uris TEXT NOT NULL, chars INTEGER NOT NULL, PRIMARY KEY (session, turn_id))");
    // The topic boundary decided for a turn before it was answered (at the
    // host's context assembly, keyed by the prompt; claimed by run id in the
    // prompt hook); observe() takes it instead of asking Jev again.
    db.exec("CREATE TABLE IF NOT EXISTS turn_decisions (session TEXT PRIMARY KEY, turn_id TEXT NOT NULL, shift TEXT, prompt TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL DEFAULT 0)");
    const decisionColumns = new Set((db.prepare("PRAGMA table_info(turn_decisions)").all() as any[]).map((c) => String(c.name)));
    if (!decisionColumns.has("prompt")) db.exec("ALTER TABLE turn_decisions ADD COLUMN prompt TEXT NOT NULL DEFAULT ''");
    if (!decisionColumns.has("at")) db.exec("ALTER TABLE turn_decisions ADD COLUMN at INTEGER NOT NULL DEFAULT 0");
    db.exec(`
      CREATE TABLE IF NOT EXISTS segment_jobs (
        id TEXT PRIMARY KEY, session TEXT NOT NULL, turns TEXT NOT NULL, earlier TEXT NOT NULL,
        continuation_of TEXT, status TEXT NOT NULL DEFAULT 'sealed', decision TEXT
      );
      CREATE INDEX IF NOT EXISTS segment_jobs_session ON segment_jobs(session, status);
      CREATE TABLE IF NOT EXISTS segment_links (session TEXT PRIMARY KEY, job_id TEXT);
      CREATE TABLE IF NOT EXISTS received_turns (session TEXT NOT NULL, turn_id TEXT NOT NULL, PRIMARY KEY(session, turn_id));
      CREATE TABLE IF NOT EXISTS write_plans (job_id TEXT NOT NULL, side TEXT NOT NULL, plan TEXT NOT NULL, PRIMARY KEY(job_id, side));
      CREATE TABLE IF NOT EXISTS write_receipts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, side TEXT NOT NULL, result TEXT NOT NULL);
    `);
    // Additive migration for stores created before bounded retries.
    db.exec("BEGIN IMMEDIATE");
    try {
      const jobColumns = new Set((db.prepare("PRAGMA table_info(segment_jobs)").all() as any[]).map((r) => r.name));
      if (!jobColumns.has("attempts")) db.exec("ALTER TABLE segment_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
      if (!jobColumns.has("last_error")) db.exec("ALTER TABLE segment_jobs ADD COLUMN last_error TEXT");
      if (!jobColumns.has("attempted_at")) db.exec("ALTER TABLE segment_jobs ADD COLUMN attempted_at INTEGER");
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); db.close(); throw e; }
    // Rows from before the scope level (uri "<type>/<slug>"): those files moved to user/.
    db.exec("UPDATE OR IGNORE meta SET uri = 'user/' || uri WHERE uri NOT LIKE 'user/%' AND uri NOT LIKE 'assistant/%'");
    this.db = db;
    return db;
  }

  get(uri: string): FileMeta | null {
    const r = this.open().prepare(`${ROW} WHERE uri = ?`).get(uri) as any;
    return r ? toMeta(r) : null;
  }

  /** A new file was created now. An existing row (same uri written again) is left alone. */
  created(uri: string, now: number, importance = DEFAULT_IMPORTANCE): void {
    this.open()
      .prepare("INSERT OR IGNORE INTO meta (uri, created_at, updated_at, importance) VALUES (?, ?, ?, ?)")
      .run(uri, now, now, clampImportance(importance));
  }

  /** A file was written now; `importance` replaces the old rating when given. */
  updated(uri: string, now: number, importance?: number): void {
    const db = this.open();
    const prev = this.get(uri);
    if (!prev) return this.created(uri, now, importance ?? DEFAULT_IMPORTANCE);
    db.prepare("UPDATE meta SET updated_at = ?, importance = ? WHERE uri = ?").run(
      now,
      importance === undefined ? prev.importance : clampImportance(importance, prev.importance),
      uri,
    );
  }

  /** All uncommitted input, including sealed jobs waiting for retry. */
  segment(session: string): Segment {
    const open = this.openSegment(session);
    return { ...open, pending: [...this.jobs(session, true).flatMap((j) => j.turns), ...open.pending] };
  }

  openSegment(session: string): Segment {
    const r = this.open().prepare("SELECT pending, tail, updated_at FROM segments WHERE session = ?").get(session) as any;
    if (!r) return { pending: [], tail: [], updatedAt: 0 };
    const parse = (t: string) => {
      try {
        const v = JSON.parse(t);
        return Array.isArray(v) ? (v as SegmentTurn[]) : [];
      } catch {
        return [];
      }
    };
    return { pending: parse(r.pending), tail: parse(r.tail), updatedAt: Number(r.updated_at) };
  }

  saveSegment(session: string, seg: Segment): void {
    this.open()
      .prepare("INSERT INTO segments (session, pending, tail, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session) DO UPDATE SET pending = excluded.pending, tail = excluded.tail, updated_at = excluded.updated_at")
      .run(session, JSON.stringify(seg.pending), JSON.stringify(seg.tail), seg.updatedAt);
  }

  /** Sessions that still hold unrecorded turns. */
  pendingSessions(): string[] {
    return (this.open().prepare("SELECT session FROM segments WHERE pending != '[]' UNION SELECT session FROM segment_jobs WHERE status IN ('sealed', 'quarantined')").all() as any[]).map((r) => String(r.session));
  }

  /** Serialize short DB/file operations on the shared connection, never model calls. */
  exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const key = Symbol.for("memkit.metaLocks.v1");
    const locks: Map<string, Promise<unknown>> = ((globalThis as any)[key] ??= new Map());
    const previous = locks.get(this.file) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    locks.set(this.file, tail);
    void tail.then(() => { if (locks.get(this.file) === tail) locks.delete(this.file); });
    return run;
  }

  /** Short, synchronous state transitions. No model or filesystem awaits in these transactions. */
  private atomic<T>(fn: () => T): T {
    const db = this.open();
    db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); db.exec("COMMIT"); return value; }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  }

  receive(session: string, turn: SegmentTurn, now: number): { previous: Segment; added: boolean } {
    return this.atomic(() => {
      const previous = this.openSegment(session);
      const id = turn.id || randomUUID();
      const added = this.open().prepare("INSERT OR IGNORE INTO received_turns VALUES (?, ?)").run(session, id).changes !== 0;
      if (added) this.saveSegment(session, { ...previous, pending: [...previous.pending, { ...turn, id, receivedAt: turn.receivedAt ?? now }], updatedAt: now });
      return { previous, added };
    });
  }

  /** Move a persisted prefix to an immutable job. A size split links its next segment to this job. */
  seal(session: string, prefix: SegmentTurn[], continuing: boolean, tailTurns: number): SegmentJob | null {
    return this.atomic(() => {
      const seg = this.openSegment(session);
      if (!prefix.length || JSON.stringify(seg.pending.slice(0, prefix.length)) !== JSON.stringify(prefix)) return null;
      const id = randomUUID();
      const link = this.continuation(session);
      const queued = this.jobs(session, true);
      const earlier = recentTurns([...seg.tail, ...queued.flatMap((j) => j.turns)], tailTurns);
      this.open().prepare("INSERT INTO segment_jobs (id, session, turns, earlier, continuation_of) VALUES (?, ?, ?, ?, ?)")
        .run(id, session, JSON.stringify(prefix), JSON.stringify(earlier), link);
      this.saveSegment(session, { ...seg, pending: seg.pending.slice(prefix.length) });
      this.open().prepare("INSERT INTO segment_links VALUES (?, ?) ON CONFLICT(session) DO UPDATE SET job_id = excluded.job_id")
        .run(session, continuing ? id : null);
      this.pruneRecall(session);
      return this.job(id)!;
    });
  }

  /** Mid-term memory of `session`: the open segment's recall blocks, oldest first. */
  recallBlocks(session: string): { turn: string; uris: string[]; chars: number }[] {
    return (this.open().prepare("SELECT turn_id, uris, chars FROM recall_blocks WHERE session = ? ORDER BY rowid").all(session) as any[])
      .map((r) => ({ turn: String(r.turn_id), uris: JSON.parse(r.uris) as string[], chars: Number(r.chars) }));
  }

  saveRecall(session: string, turn: string, uris: string[], chars: number): void {
    this.open().prepare("INSERT INTO recall_blocks VALUES (?, ?, ?, ?) ON CONFLICT(session, turn_id) DO UPDATE SET uris = excluded.uris, chars = excluded.chars")
      .run(session, turn, JSON.stringify(uris), chars);
  }

  /**
   * Keep only blocks of turns still in the open segment (or the turn being
   * answered): a sealed segment's topic is over, and so is its mid-term memory.
   */
  pruneRecall(session: string): void {
    const live = new Set(this.openSegment(session).pending.map((t) => t.id));
    const decided = this.turnDecision(session)?.turn;
    if (decided) live.add(decided);
    for (const b of this.recallBlocks(session))
      if (!live.has(b.turn)) this.open().prepare("DELETE FROM recall_blocks WHERE session = ? AND turn_id = ?").run(session, b.turn);
  }

  /** One decision per session: the boundary for the turn whose prompt is `prompt` (turn id "" until a run claims it). */
  decideTurn(session: string, d: { turn: string; prompt: string; shift: unknown; at: number }): void {
    this.open().prepare("INSERT INTO turn_decisions (session, turn_id, shift, prompt, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session) DO UPDATE SET turn_id = excluded.turn_id, shift = excluded.shift, prompt = excluded.prompt, at = excluded.at")
      .run(session, d.turn, JSON.stringify(d.shift ?? null), d.prompt, d.at);
  }

  turnDecision<T = unknown>(session: string): { turn: string; prompt: string; shift: T; at: number } | null {
    const r = this.open().prepare("SELECT turn_id, shift, prompt, at FROM turn_decisions WHERE session = ?").get(session) as any;
    return r ? { turn: String(r.turn_id), prompt: String(r.prompt ?? ""), shift: JSON.parse(r.shift) as T, at: Number(r.at) } : null;
  }

  /** A run takes over the decision made at assembly for its prompt. */
  claimTurnDecision(session: string, turn: string): void {
    this.open().prepare("UPDATE turn_decisions SET turn_id = ? WHERE session = ?").run(turn, session);
  }

  clearTurnDecision(session: string): void {
    this.open().prepare("DELETE FROM turn_decisions WHERE session = ?").run(session);
  }

  continuation(session: string): string | null {
    return (this.open().prepare("SELECT job_id FROM segment_links WHERE session = ?").get(session) as any)?.job_id ?? null;
  }

  job(id: string): SegmentJob | null {
    const r = this.open().prepare("SELECT * FROM segment_jobs WHERE id = ?").get(id) as any;
    return r ? this.decodeJob(r) : null;
  }

  jobs(session: string, includeQuarantined = false): SegmentJob[] {
    const statuses = includeQuarantined ? "('sealed', 'quarantined')" : "('sealed')";
    return (this.open().prepare(`SELECT * FROM segment_jobs WHERE session = ? AND status IN ${statuses} ORDER BY rowid`).all(session) as any[]).map((r) => this.decodeJob(r));
  }

  private decodeJob(r: any): SegmentJob {
    return { id: r.id, session: r.session, turns: JSON.parse(r.turns), earlier: JSON.parse(r.earlier), continuationOf: r.continuation_of,
      status: r.status, attempts: Number(r.attempts), lastError: r.last_error ?? null,
      attemptedAt: r.attempted_at == null ? null : Number(r.attempted_at), decision: r.decision ? JSON.parse(r.decision) : null };
  }

  /** Reserve a persistent attempt before spending any model tokens. */
  beginAttempt(id: string, maxAttempts: number, now = Date.now()): boolean {
    return this.atomic(() => {
      const job = this.job(id);
      if (!job || job.status !== "sealed") return false;
      if (job.attempts >= maxAttempts) {
        this.open().prepare("UPDATE segment_jobs SET status = 'quarantined', last_error = COALESCE(last_error, 'attempt budget exhausted') WHERE id = ?").run(id);
        return false;
      }
      this.open().prepare("UPDATE segment_jobs SET attempts = attempts + 1, attempted_at = ? WHERE id = ?").run(now, id);
      return true;
    });
  }

  fail(id: string, error: string, maxAttempts: number): boolean {
    this.open().prepare("UPDATE segment_jobs SET last_error = ?, status = CASE WHEN attempts >= ? THEN 'quarantined' ELSE 'sealed' END WHERE id = ? AND status = 'sealed'")
      .run(error, maxAttempts, id);
    return this.job(id)?.status === "quarantined";
  }

  /** Explicit operator retry; completed plans and action receipts remain intact. */
  requeue(id: string): void {
    this.open().prepare("UPDATE segment_jobs SET status = 'sealed', attempts = 0, last_error = NULL WHERE id = ? AND status = 'quarantined'").run(id);
  }

  decide(id: string, decision: NonNullable<SegmentJob["decision"]>): NonNullable<SegmentJob["decision"]> {
    this.open().prepare("UPDATE segment_jobs SET decision = ? WHERE id = ? AND decision IS NULL").run(JSON.stringify(decision), id);
    return this.job(id)!.decision!;
  }

  plan<T>(jobId: string, side: string): T | null {
    const r = this.open().prepare("SELECT plan FROM write_plans WHERE job_id = ? AND side = ?").get(jobId, side) as any;
    return r ? JSON.parse(r.plan) as T : null;
  }

  savePlan<T>(jobId: string, side: string, plan: T): T {
    this.open().prepare("INSERT OR IGNORE INTO write_plans VALUES (?, ?, ?)").run(jobId, side, JSON.stringify(plan));
    return this.plan<T>(jobId, side)!;
  }

  revisePlan<T>(jobId: string, side: string, before: T, after: T): T {
    this.open().prepare("UPDATE write_plans SET plan = ? WHERE job_id = ? AND side = ? AND plan = ?")
      .run(JSON.stringify(after), jobId, side, JSON.stringify(before));
    return this.plan<T>(jobId, side)!;
  }

  receipt<T>(id: string): T | null {
    const r = this.open().prepare("SELECT result FROM write_receipts WHERE id = ?").get(id) as any;
    return r ? JSON.parse(r.result) as T : null;
  }

  saveReceipt(id: string, jobId: string, side: string, result: unknown): void {
    this.open().prepare("INSERT OR IGNORE INTO write_receipts VALUES (?, ?, ?, ?)").run(id, jobId, side, JSON.stringify(result));
  }

  /** Ids of the session's most recently finished segments (committed or skipped), newest first. */
  recentJobs(session: string, limit: number): string[] {
    if (limit <= 0) return [];
    return (this.open().prepare("SELECT id FROM segment_jobs WHERE session = ? AND status IN ('committed', 'skipped') ORDER BY rowid DESC LIMIT ?")
      .all(session, limit) as any[]).map((r) => String(r.id));
  }

  receipts<T>(jobId: string): T[] {
    return (this.open().prepare("SELECT result FROM write_receipts WHERE job_id = ? ORDER BY rowid").all(jobId) as any[]).map((r) => JSON.parse(r.result));
  }

  /** Keep a small recent window plus every marker not yet protected by a DB receipt. */
  retainActionMarkers(ids: string[], keep = 20): string[] {
    const cutoff = Math.max(0, ids.length - keep);
    return ids.filter((id, i) => i >= cutoff || !this.receipt(id));
  }

  complete(id: string, skipped: boolean, tailTurns: number): void {
    this.atomic(() => {
      const job = this.job(id)!;
      if (job.status !== "sealed" && job.status !== "quarantined") return;
      const seg = this.openSegment(job.session);
      this.open().prepare("UPDATE segment_jobs SET status = ?, last_error = NULL WHERE id = ?").run(skipped ? "skipped" : "committed", id);
      // An explicitly retried older job must not move the recent context backwards.
      this.saveSegment(job.session, { ...seg, tail: recentTurns([...seg.tail, ...job.turns], tailTurns) });
    });
  }

  remove(uri: string): void {
    this.open().prepare("DELETE FROM meta WHERE uri = ?").run(uri);
  }

  /**
   * Back-fill metadata. Prune only when the caller holds a stable complete
   * inventory; concurrent planning passes prune=false.
   */
  sync(records: MemoryRecord[], now: number, prune = true): Map<string, FileMeta> {
    const db = this.open();
    const rows = db.prepare(ROW).all() as any[];
    const have = new Map<string, FileMeta>(rows.map((r) => [r.uri, toMeta(r)]));
    const live = new Set(records.map((r) => r.uri));
    for (const uri of have.keys())
      if (prune && !live.has(uri)) {
        db.prepare("DELETE FROM meta WHERE uri = ?").run(uri);
        have.delete(uri);
      }
    for (const r of records) {
      if (have.has(r.uri)) continue;
      const created = parseTime(r.createdAt) ?? now;
      const updated = parseTime(r.updatedAt) ?? created;
      db.prepare("INSERT OR IGNORE INTO meta (uri, created_at, updated_at, importance) VALUES (?, ?, ?, ?)").run(r.uri, created, updated, DEFAULT_IMPORTANCE);
      have.set(r.uri, { uri: r.uri, createdAt: created, updatedAt: updated, importance: DEFAULT_IMPORTANCE });
    }
    return have;
  }

  /**
   * Run `fn` inside one write transaction (BEGIN IMMEDIATE: a lock across
   * processes). Whatever `fn` checks and writes — files and metadata — no
   * other process's transaction can interleave with it. Throwing rolls the
   * metadata back.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.exclusive(() => this.runTransaction(fn));
  }

  private async runTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const db = this.open();
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = await fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw e;
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

function recentTurns(turns: SegmentTurn[], count: number): SegmentTurn[] {
  const time = (t: SegmentTurn) => t.receivedAt ?? parseTime(t.time ?? "") ?? 0;
  return count > 0 ? [...turns].sort((a, b) => time(a) - time(b)).slice(-count) : [];
}

function parseTime(s: string): number | null {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
