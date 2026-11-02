// Core domain types for memkit.
//
// The mechanism is ported from the Paimon agent's three-stage pipeline
// (ingest → retrieve → answer). The one rule carried over unchanged: the
// answering model only ever sees memory that a retrieval actually returned —
// it never "remembers" anything on its own. Everything here is plain data so
// a trace of every decision can be written out and inspected later.

export type MemoryType = "principle" | "event";
export const MEMORY_TYPES: readonly MemoryType[] = ["principle", "event"];

export function isMemoryType(v: unknown): v is MemoryType {
  return v === "principle" || v === "event";
}

/**
 * Whose memory a file is — the first level of the store. `user`: about the
 * user (their facts, preferences, plans, what they told about others).
 * `assistant`: about the assistant / the character itself (its own
 * experiences, what it promised, how it was told to behave). Jev classifies
 * every turn into user / assistant / both / neither, at ingest (where to
 * write) and at retrieve (where to look). The split will carry more meaning
 * later; for now it only routes reads and writes.
 */
export type MemoryScope = "user" | "assistant";
export const MEMORY_SCOPES: readonly MemoryScope[] = ["user", "assistant"];

export function isMemoryScope(v: unknown): v is MemoryScope {
  return v === "user" || v === "assistant";
}

/** One memory FILE. Entries merged into the same (type, topic) accumulate in `body`. */
export interface MemoryRecord {
  /** Durable action receipts, atomically written with the body (never sent to a model). */
  appliedActions?: string[];
  /** `<scope>/<type>/<slug>` — the stable id, also the path relative to the store root (minus `.md`). */
  uri: string;
  /** Taken from the path, not stored in the file. */
  scope: MemoryScope;
  type: MemoryType;
  topic: string;
  /**
   * Model-written précis of the WHOLE file, rewritten on every merge. Retrieval
   * candidates are found by topic + summary; a file without one is hard to find.
   */
  summary: string;
  /** Accumulated entries, one markdown bullet per write. */
  body: string;
  /** Every write's conversation time, oldest first (the recency signal for updates). */
  times: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
  entries: number;
}

export interface ScoredMemory {
  record: MemoryRecord;
  score: number;
  /** Which stage produced the score: a lexical prefilter, or the discriminator. */
  source: "bm25" | "judge";
}

/** One row of the decision trace (the trajectory, in the original project's terms). */
export interface TraceEvent {
  at: string;
  stage: "ingest" | "retrieve" | "tool";
  step: string;
  detail: Record<string, unknown>;
}

export type TraceSink = (ev: TraceEvent) => void;

export function nowIso(): string {
  return new Date().toISOString();
}
