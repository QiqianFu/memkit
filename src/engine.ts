// The memory engine: ingest (write path) and retrieve (read path).
//
// Division of labor:
//   * Embedder (BGE-M3) — RECALL only: which few files are worth judging. It
//                    never lets anything through on its own.
//   * Judge (Jev)  — every discriminative call: whose memory a segment is
//                    (user / assistant / both / empty), is it worth storing,
//                    and, file by file, does a
//                    recalled file bear on what is being recorded (ingest) or
//                    on this conversation (retrieve) — one request per file,
//                    state = the conversation, question = the file.
//   * Llm (DeepSeek) — every generative call: given the related files, it
//                    decides per file how to write (JSON: append the new
//                    lines, edit = the whole corrected body, or new files)
//                    and re-rates an updated file's importance; in retrieval
//                    it may rewrite the recall query after seeing what the
//                    first recall found. It never decides what passes.
//   * MetaStore    — per-file created / updated time and importance (SQLite),
//                    which order retrieval recall: similarity × (1 + importance)
//                    × forgetting.
//   * Code         — thresholds, recall size, file routing, limits.
//
// Without an embedder (or when the embedding service fails) recall falls back
// to BM25; the Jev judgment after it is the same.
//
// The answer step is NOT here: inside OpenClaw the host agent answers, with
// the retrieved evidence injected into its prompt. `answer()` exists only for
// the offline harness.

import type { Answer, Judge } from "./judge.ts";
import type { ChatMessage, Llm } from "./llm.ts";
import { extractJson } from "./llm.ts";
import { fingerprint, MemoryStore } from "./store.ts";
import { clampImportance, Conflict, DEFAULT_IMPORTANCE, MetaStore } from "./meta.ts";
import type { SegmentTurn, SegmentJob } from "./meta.ts";
import { clipText, recentEntries } from "./view.ts";
import type { FileMeta } from "./meta.ts";
import { dot, EmbeddingIndex } from "./embed.ts";
import type { Embedder } from "./embed.ts";
import { bm25Rank, slug, tokenize, truncate } from "./text.ts";
import { markMonologue, stripRecallMarkup } from "./monologue.ts";
import { dateHits, describeMoment, envelopeOf, localDay, mergeCandidates, relativeWithoutDate, resolveMentions, timeWordsIn, turnMoment, weekdayName, weekdayProblems, withoutTimeWords } from "./dates.ts";
import type { DateMention } from "./dates.ts";
import type { MemoryRecord, MemoryScope, ScoredMemory, TraceSink } from "./types.ts";
import { isMemoryType, nowIso } from "./types.ts";
import {
  ANSWER_RULES,
  GATE_CRITERIA,
  GATE_QUESTION,
  INGEST_SCOPE_CRITERIA,
  INGEST_BACKGROUND,
  INGEST_SCOPE_QUESTION,
  INGEST_SYSTEM,
  RECORD_MARK,
  TOPIC_SHIFT_CRITERIA,
  TOPIC_SHIFT_QUESTION,
  NEED_RECALL_CRITERIA,
  NEED_RECALL_QUESTION,
  RELATED_CRITERIA,
  RELATED_QUESTION,
  REWRITE_SYSTEM,
  RELEVANT_CRITERIA,
  RELEVANT_QUESTION,
  RETRIEVAL_BACKGROUND,
  TIME_RELATED_CRITERIA,
  TIME_RELATED_QUESTION,
  ingestUserPrompt,
  localMoment,
  rewriteUserPrompt,
  renderEvidence,
  renderEvidenceParts,
} from "./prompts.ts";
import type { WriteTarget } from "./prompts.ts";

export interface EngineOptions {
  /** Ingest: skip the turn when P(worth storing) is below this. */
  gateAt: number;
  /** Ingest: most similar files of the side (BGE), each judged by Jev on its own: related to what is being recorded? */
  ingestCandidates: number;
  /**
   * Ingest: at most this many more candidates beyond BGE's `ingestCandidates`:
   * files this session's recent segments wrote, and files whose topic/summary
   * share key terms with the segment (BGE's shortlist often missed the file
   * of the very same topic, and the writer created it again). A size
   * continuation's own files come on top (as before; bounded by the writer's
   * per-segment limits).
   */
  extraCandidates: number;
  /** Ingest: the P(related) a candidate needs to be handed to the writer. */
  relatedAt: number;
  /** Ingest: at most this many related files (most similar first) go to the writer. */
  writeFiles: number;
  /** Segments: P(topic changed) at which the pending turns are recorded. */
  topicShiftAt: number;
  /**
   * Segments: a pending segment longer than this many characters is recorded
   * without waiting for a topic change. No turn limit: role-play lines are
   * short, and the characters are what bound Jev's input.
   */
  segmentChars: number;
  /** Maximum automatic attempts per sealed segment before it is quarantined. */
  maxAttempts: number;
  /** Segments: recorded turns kept for the next judgment, to resolve references. */
  tailTurns: number;
  /**
   * Characters one Jev request may carry (state + questions). Jev handles
   * ~10K tokens reliably; at ~0.8 tokens per character 11,000 characters is
   * ~8.8K. With a full segment (6,000) in the state, a candidate file in
   * the related-or-not question still gets about 4,500.
   */
  jevChars: number;
  /**
   * Retrieve: ask Jev first whether this message needs memory that is not
   * already in the conversation (its history and the topic's recall blocks);
   * below `recallAt` nothing is recalled this turn.
   */
  recallGate: boolean;
  recallAt: number;
  /**
   * Retrieve: ask, in the gate's request, whether the turn is about time
   * (time_related). At P ≥ `timeAt` the dates it names are resolved by rule
   * (src/dates.ts) and up to `timeFiles` files that mention those dates take
   * the first places of the `recall` candidates; BGE fills the rest.
   */
  timeAware: boolean;
  timeAt: number;
  timeFiles: number;
  /** Retrieve: DeepSeek looks at the first recall's summaries and may rewrite the query for a second recall. */
  queryRewrite: boolean;
  /** Retrieve: files recalled per turn (each then judged on its own). */
  recall: number;
  /** Retrieve: forgetting half-life — a file untouched this long counts half as much in recall order. */
  halfLifeDays: number;
  /** Retrieve: the P(relevant) a recalled file needs, and how many may pass. */
  minScore: number;
  k: number;
  /** Retrieve: characters of conversation history the judge sees (earliest dropped first). */
  historyChars: number;
  /** Characters of the current message in a Jev state (ingest: twice this). */
  messageChars: number;
  /** Retrieve: characters of conversation (current message first) the recall query is built from. */
  queryChars: number;
  /**
   * Characters of one file in a retrieval judgment: summary + newest entries.
   * Same as BGE's input budget. With the history and message budgets a
   * request stays under ~10K characters, inside Jev's 10K-token window
   * (measured ~0.8 tokens per character).
   */
  fileChars: number;
  /** Retrieve: characters of evidence injected into the answering request, all files together. */
  evidenceChars: number;
  /** "judge" = Jev judges what was recalled; "bm25" = lexical recall only, no judge (a baseline). */
  retrieval: "judge" | "bm25";
}

export const DEFAULT_OPTIONS: EngineOptions = {
  gateAt: 0.5,
  ingestCandidates: 10,
  extraCandidates: 5,
  relatedAt: 0.5,
  writeFiles: 3,
  topicShiftAt: 0.5,
  segmentChars: 6000,
  maxAttempts: 3,
  tailTurns: 3,
  jevChars: 11000,
  recallGate: true,
  recallAt: 0.5,
  timeAware: true,
  timeAt: 0.5,
  timeFiles: 3,
  queryRewrite: true,
  recall: 10,
  halfLifeDays: 30,
  minScore: 0.5,
  k: 10,
  historyChars: 2000,
  messageChars: 1000,
  queryChars: 1500,
  fileChars: 6000,
  evidenceChars: 2000,
  retrieval: "judge",
};

export interface Turn {
  user: string;
  assistant?: string;
  /**
   * The user's earlier messages in this conversation, oldest first. Lets the
   * judge resolve "那是他自己的事儿" / "算了，先放一放" to what they refer to.
   */
  context?: string[];
  /** Conversation time stamped on what gets written (the recency anchor). */
  time?: string;
}

export interface ObserveResult {
  /** The topic-shift judgment, when turns were pending: P, and why the segment was (not) recorded. */
  shift: { p: number; reason: "topic" | "size" | "same" } | null;
  /** The recorded segment's ingest, when one was recorded. */
  recorded: IngestResult | null;
  /** Recording failed: the turns stay pending. */
  error?: string;
}

export interface CaptureOptions {
  /** Starts after the session queue and durable receipt, not while waiting for another turn. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface IngestAction {
  id?: string;
  op: "new" | "update" | "skip";
  uri?: string;
  reason?: string;
  ok: boolean;
  error?: string;
}

/**
 * Why a file was among the ingest candidates: BGE's shortlist, the size
 * continuation's files, a file this session's recent segments wrote, or a
 * lexical match on its topic/summary.
 */
export type CandidateSource = "bge" | "continuation" | "recent" | "lexical";

/** The reason on the skip action of a segment whose related files already held everything (the writer wrote nothing). */
export const NOTHING_NEW = "nothing new";

/** Jev's answer to "whose memory" at ingest: the sides to write, or none. */
export type ScopeChoice = MemoryScope | "both" | "empty";

export interface IngestResult {
  gate: number | null;
  /** Whose memory Jev said this turn is ("both" wrote each side separately). */
  scope: ScopeChoice | null;
  /** The related files handed to the writer, per side (most similar first, at most `writeFiles`). */
  targets: string[];
  /** Every candidate Jev judged, with its side, similarity, P(related) and where the candidate came from. */
  options: { side: MemoryScope; option: string; uri: string | null; similarity?: number; p: number; source?: CandidateSource }[];
  actions: IngestAction[];
}

export interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
}

/** One recalled file and what the judge said about it. */
export interface Recalled {
  uri: string;
  /** Raw recall score: cosine similarity (bge) or BM25 score. */
  similarity: number;
  /** Recall order: similarity × (1 + importance) × forgetting. */
  rank: number;
  importance: number;
  forgetting: number;
  /** P(relevant) from the judge (undefined for the bm25 baseline). */
  p?: number;
  passed: boolean;
  /** Present when the date search put this file in the candidates: its date hits. */
  dated?: { text: number; times: number };
}

/** The time-awareness side of a retrieval (null when `timeAware` is off). */
export interface TimeInfo {
  /** P(time_related) from the gate request. */
  p: number;
  /** p ≥ timeAt: the dates were resolved and the store searched. */
  fired: boolean;
  /** The day the message was said (envelope, else host local date); set when fired. */
  today?: string;
  /** What was resolved, expression by expression (empty: nothing resolvable → normal recall). */
  mentions?: DateMention[];
  /** Files the date search put in the candidates, best first. */
  dated?: string[];
}

export interface RetrieveResult {
  /** The need-recall judgment (null when the gate is off); recall: false = nothing was recalled. */
  gate: { p: number; recall: boolean } | null;
  /** The rewritten query when DeepSeek rewrote it (the second recall merged with the first). */
  rewrite: { query: string } | null;
  /** Time awareness: P(time_related), the dates resolved, the files found by date. */
  time?: TimeInfo | null;
  hits: ScoredMemory[];
  /** Which recall ran: dense (bge), or the lexical fallback. */
  recallSource: "bge" | "bm25" | null;
  recalled: Recalled[];
  evidence: string;
  /** Wall-clock ms per retrieval step (0 = the step did not run). */
  timings?: RetrieveTimings;
}

/**
 * Where a retrieval's time went, in wall-clock ms (0 = the step did not run).
 * Measured with performance.now(), not the injectable `now` (which tests fake
 * for forgetting): these are real durations, for attributing turn latency.
 */
export interface RetrieveTimings {
  /** Jev need-recall gate (one request). */
  gate: number;
  /** BGE recall: query embedding + file vectors, both recalls when rewritten. */
  bge: number;
  /** DeepSeek query rewrite. */
  rewrite: number;
  /** Per-file Jev judgments: wall time of the whole parallel fan-out. */
  judge: number;
  /** All of retrieve(). */
  total: number;
}

/** recallTurn()'s timings: retrieval's, plus the topic boundary. */
export interface TurnTimings extends RetrieveTimings {
  /**
   * The topic-boundary decision (Jev topic_shift), wherever it ran — usually
   * at the host's context assembly, i.e. BEFORE recallTurn, so it is not part
   * of `total`. 0 when there was nothing to decide.
   */
  boundary: number;
}

/** Whole ms since `t0` (a performance.now() reading). */
function msSince(t0: number): number {
  return Math.round(performance.now() - t0);
}

export class MemoryEngine {
  readonly store: MemoryStore;
  readonly judge: Judge;
  readonly llm: Llm;
  readonly embedder: Embedder | null;
  readonly opts: EngineOptions;
  readonly meta: MetaStore;
  private index: EmbeddingIndex | null;
  private trace: TraceSink;
  private now: () => number;
  /**
   * ms the last computed topic-boundary decision took, per session. The
   * boundary usually runs at context assembly, before the prompt hook's
   * recallTurn; this hands its duration over so the turn's timings can
   * report it. Taken (deleted) by recallTurn.
   */
  private boundaryMs = new Map<string, number>();

  constructor(args: {
    store: MemoryStore;
    judge: Judge;
    llm: Llm;
    embedder?: Embedder | null;
    opts?: Partial<EngineOptions>;
    trace?: TraceSink;
    /** Epoch ms; injectable so forgetting can be tested. */
    now?: () => number;
  }) {
    this.store = args.store;
    this.judge = args.judge;
    this.llm = args.llm;
    this.embedder = args.embedder ?? null;
    this.index = this.embedder ? new EmbeddingIndex(args.store.root, this.embedder, (this.embedder as { maxChars?: number }).maxChars ?? 6000) : null;
    this.opts = { ...DEFAULT_OPTIONS, ...(args.opts ?? {}) };
    this.trace = args.trace ?? (() => {});
    this.meta = MetaStore.for(args.store.root);
    this.now = args.now ?? Date.now;
  }

  private emit(stage: "ingest" | "retrieve", step: string, detail: Record<string, unknown>): void {
    try {
      this.trace({ at: nowIso(), stage, step, detail });
    } catch {
      // tracing must never break the memory path
    }
  }

  // ------------------------------------------------------------------ ingest
  //
  // Receive → seal → persist a write plan → commit each action → advance tail.
  // Model failures leave the immutable job and its completed actions available
  // for retry. Incoming turns never join a job whose writing has already begun.

  async observe(session: string, turn: SegmentTurn, timing?: AbortSignal | CaptureOptions): Promise<ObserveResult> {
    // Recall markup the model wrote into its reply is persisted away: it is
    // neither memory nor the character's words (src/monologue.ts).
    const assistant = turn.assistant ? stripRecallMarkup(turn.assistant).text : "";
    const t: SegmentTurn = {
      ...(turn.id ? { id: turn.id } : {}),
      user: turn.user.trim(),
      ...(assistant ? { assistant } : {}),
      ...(turn.time ? { time: turn.time } : {}),
    };
    if (!t.user) return { shift: null, recorded: null };
    return sessionLock(this.store.root, session, async () => {
      // Persist the complete source, including speaker and host run id, BEFORE any model call.
      const { previous: seg, added, decided, recallChars } = await this.meta.exclusive(() => {
        const r = this.meta.receive(session, t, this.now());
        // The boundary may already have been decided before this turn was answered (recallTurn).
        const d = this.meta.turnDecision<ObserveResult["shift"]>(session);
        const decided = d && samePrompt(d, t.user, t.id, this.now()) ? d : null;
        if (decided) this.meta.clearTurnDecision(session);
        return { ...r, decided, recallChars: this.recallChars(session) };
      });
      const signal = captureSignal(timing);
      let shift: ObserveResult["shift"] = decided ? decided.shift : null;
      let recorded: IngestResult | null = null;
      let error: string | undefined;
      if (added && !decided && seg.pending.length) {
        const over = turnsChars([...seg.pending, t]) + recallChars > this.opts.segmentChars;
        if (over) shift = { p: 1, reason: "size" };
        else {
          try {
            const p = await this.topicShift(seg.tail, seg.pending, t.user, signal);
            shift = { p, reason: p >= this.opts.topicShiftAt ? "topic" : "same" };
          } catch (e) {
            // We cannot decide a boundary, but the new turn is already safe.
            return { shift: null, recorded: null, error: String((e as Error).message ?? e) };
          }
        }
        if (shift.reason !== "same") {
          await this.meta.exclusive(() => this.meta.seal(session, seg.pending, shift.reason === "size", this.opts.tailTurns));
        }
      }
      try { recorded = await this.drain(session, signal); }
      catch (e) { error = String((e as Error).message ?? e); }
      if (recorded?.actions.some((a) => !a.ok)) error = recorded.actions.filter((a) => !a.ok).map((a) => a.error).join("; ");
      return { shift, recorded, ...(error ? { error } : {}) };
    });
  }

  /**
   * Before a turn is answered: its topic boundary (decided at context
   * assembly when the host passed the prompt there, else decided here, as
   * observe() would afterwards) in parallel with retrieval; returns only the
   * evidence that is not already in the conversation.
   *
   * Mid-term memory: a turn's recall block stays in the conversation, at the
   * turn it was recalled for, for as long as its segment (topic) is open —
   * the context engine keeps blocks whose id is in recallIds(). When the
   * current message starts a new topic, or the segment with its blocks grows
   * past `segmentChars`, the previous segment is sealed here, before the
   * answer, and its blocks are dropped from the conversation.
   */
  /**
   * The topic boundary for the turn whose user text is `user`: null when
   * nothing is pending, else "same", or "topic" / "size" — in which case the
   * previous segment is sealed right here and its recall blocks (mid-term
   * memory) are dropped. The decision is stored for the session, keyed by the
   * prompt, so the prompt hook and observe() reuse it instead of asking Jev
   * again. Meant to run at the host's context assembly, which happens BEFORE
   * the prompt hook: only then does the assembled history already lack the
   * ended topic's blocks. A second call for the same pending prompt is a no-op.
   */
  async decideBoundary(session: string, user: string, opts: { id?: string; signal?: AbortSignal } = {}): Promise<ObserveResult["shift"]> {
    user = user.trim();
    const t0 = performance.now();
    const { seg, decided, recallChars } = await this.meta.exclusive(() => ({
      seg: this.meta.openSegment(session),
      decided: this.meta.turnDecision<ObserveResult["shift"]>(session),
      recallChars: this.recallChars(session, opts.id),
    }));
    if (decided && samePrompt(decided, user, opts.id, this.now())) {
      if (opts.id && decided.turn !== opts.id) await this.meta.exclusive(() => this.meta.claimTurnDecision(session, opts.id!));
      return decided.shift;
    }
    let shift: ObserveResult["shift"] = null;
    if (seg.pending.length) {
      if (turnsChars([...seg.pending, { user }]) + recallChars > this.opts.segmentChars) shift = { p: 1, reason: "size" };
      else {
        try {
          const p = await this.topicShift(seg.tail, seg.pending, user, opts.signal);
          shift = { p, reason: p >= this.opts.topicShiftAt ? "topic" : "same" };
        } catch (e) {
          // Undecided: observe() asks again after the answer.
          this.emit("ingest", "topic_shift_failed", { error: truncate(String((e as Error).message ?? e), 200), ms: msSince(t0) });
          this.boundaryMs.set(session, msSince(t0));
          return null;
        }
      }
    }
    // Nothing pending = nothing was decided: 0, not the few ms of bookkeeping.
    this.boundaryMs.set(session, seg.pending.length ? msSince(t0) : 0);
    await this.meta.exclusive(() => {
      if (shift && shift.reason !== "same") {
        // Turns may have arrived since the snapshot; then observe() decides.
        if (!this.meta.seal(session, seg.pending, shift.reason === "size", this.opts.tailTurns)) return;
      }
      this.meta.decideTurn(session, { turn: opts.id ?? "", prompt: user, shift, at: this.now() });
      this.meta.pruneRecall(session);
    });
    return shift;
  }

  async recallTurn(
    session: string,
    turn: { id: string; user: string },
    opts: { history?: HistoryTurn[]; signal?: AbortSignal } = {},
  ): Promise<{ shift: ObserveResult["shift"]; hits: ScoredMemory[]; evidence: string | null; timings: TurnTimings }> {
    const t0 = performance.now();
    const user = turn.user.trim();
    const boundary = () => this.decideBoundary(session, user, { id: turn.id, signal: opts.signal });
    // Boundary and retrieval in parallel. The recall gate counts the topic's
    // blocks as already known; if the boundary then ends the topic (dropping
    // those blocks) and the gate had declined BECAUSE of them, it is asked
    // again without them. Rare, and the only case where the order matters.
    const seen = await this.meta.exclusive(() => this.blockUris(session, turn.id));
    let [shift, r] = await Promise.all([boundary(), this.retrieve(user, { ...opts, recalled: seen })]);
    const left = await this.meta.exclusive(() => this.blockUris(session, turn.id));
    // A redone gate's retrieval adds to the first one's time: both were waited for.
    const first = r.timings;
    if (r.gate && !r.gate.recall && seen.length && left.length < seen.length) {
      this.emit("retrieve", "gate_redo", { dropped: seen.filter((u) => !left.includes(u)) });
      r = await this.retrieve(user, { ...opts, recalled: left });
    }
    const steps = (k: keyof RetrieveTimings) => (r.timings?.[k] ?? 0) + (first && first !== r.timings ? first[k] : 0);
    const boundaryMs = this.boundaryMs.get(session) ?? 0;
    this.boundaryMs.delete(session);
    return this.meta.exclusive(() => {
      // Files already shown earlier in this topic stay where they are; only new ones are injected.
      const shown = new Set(this.meta.recallBlocks(session).filter((b) => b.turn !== turn.id).flatMap((b) => b.uris));
      const hits = r.hits.filter((h) => !shown.has(h.record.uri));
      const timings: TurnTimings = {
        boundary: boundaryMs, gate: steps("gate"), bge: steps("bge"), rewrite: steps("rewrite"), judge: steps("judge"), total: msSince(t0),
      };
      this.emit("retrieve", "mid_term", { turn: turn.id, shift, shown: [...shown], fresh: hits.map((h) => h.record.uri), ms: timings.total, timings });
      if (!hits.length) return { shift, hits, evidence: null, timings };
      // Only files that fit in the block count as shown: one cut for budget
      // can come back in a later turn of the topic.
      const { text: evidence, shown: fit } = renderEvidenceParts(hits, this.opts.evidenceChars);
      if (!fit.length) return { shift, hits: [], evidence: null, timings };
      this.meta.saveRecall(session, turn.id, fit, evidence.length);
      return { shift, hits: hits.filter((h) => fit.includes(h.record.uri)), evidence, timings };
    });
  }

  /** Ids (turn run ids) of the recall blocks that are mid-term memory of `session` right now. */
  async recallIds(session: string): Promise<Set<string>> {
    return this.meta.exclusive(() => new Set(this.meta.recallBlocks(session).map((b) => b.turn)));
  }

  /** Called under meta.exclusive: files in the topic's blocks, other than `except`'s. */
  private blockUris(session: string, except: string): string[] {
    return this.meta.recallBlocks(session).filter((b) => b.turn !== except).flatMap((b) => b.uris);
  }

  /** Called under meta.exclusive: characters of the open segment's recall blocks (they count toward its size). */
  private recallChars(session: string, except?: string): number {
    return this.meta.recallBlocks(session).filter((b) => b.turn !== except).reduce((n, b) => n + b.chars, 0);
  }

  /** Record whatever is pending for `session` (idle, reset, session end, end of an offline run), without a topic judgment. */
  async flush(session: string, timing?: AbortSignal | CaptureOptions): Promise<IngestResult | null> {
    return sessionLock(this.store.root, session, async () => {
      await this.meta.exclusive(() => {
        const seg = this.meta.openSegment(session);
        if (seg.pending.length) this.meta.seal(session, seg.pending, false, this.opts.tailTurns);
      });
      return this.drain(session, captureSignal(timing));
    });
  }

  /**
   * Sessions that still hold unrecorded turns and have had no new turn for
   * `idleMs`. Their open buffer is recorded by `flush()` as one segment —
   * nothing came after it, so there is no topic change to ask Jev about.
   * A sealed segment that failed is retried only a full window after its
   * last attempt, so a short model outage cannot burn its whole retry budget
   * on consecutive ticks. Quarantined segments are not waiting on time and are
   * left out.
   */
  async idleSessions(idleMs: number): Promise<string[]> {
    return this.meta.exclusive(() =>
      this.meta.pendingSessions().filter((s) => {
        const seg = this.meta.openSegment(s);
        if (this.now() - seg.updatedAt < idleMs) return false;
        if (seg.pending.length) return true;
        return this.meta.jobs(s).some((j) => this.now() - (j.attemptedAt ?? 0) >= idleMs);
      }),
    );
  }

  /** Explicit retry after an operator fixes a quarantined segment's cause. */
  async retrySegment(id: string, timing?: AbortSignal | CaptureOptions): Promise<IngestResult | null> {
    const job = await this.meta.exclusive(() => this.meta.job(id));
    if (!job) throw new Error(`no such segment: ${id}`);
    return sessionLock(this.store.root, job.session, async () => {
      await this.meta.exclusive(() => this.meta.requeue(id));
      return this.drain(job.session, captureSignal(timing));
    });
  }

  /** Failed jobs block only until their persistent budget is exhausted; quarantined source stays in meta for retrySegment(). */
  private async drain(session: string, signal?: AbortSignal): Promise<IngestResult | null> {
    let combined: IngestResult | null = null;
    const maxAttempts = Math.max(1, Math.floor(this.opts.maxAttempts));
    const appendResult = (r: IngestResult) => {
      if (!combined) combined = { ...r, targets: [], options: [], actions: [] };
      combined.targets.push(...r.targets); combined.options.push(...r.options); combined.actions.push(...r.actions);
    };
    for (const job of await this.meta.exclusive(() => this.meta.jobs(session))) {
      signal?.throwIfAborted();
      // A crash after all receipts but before the tail update needs no model
      // attempt at all, including when the last attempt exhausted the budget.
      const recovered = await this.meta.exclusive(() => this.completedResult(job));
      if (recovered) {
        await this.meta.exclusive(() => this.meta.complete(job.id, recovered.actions.every((a) => a.op === "skip"), this.opts.tailTurns));
        appendResult(recovered);
        continue;
      }
      const started = await this.meta.exclusive(() => this.meta.beginAttempt(job.id, maxAttempts, this.now()));
      if (!started) continue;
      let r: IngestResult;
      // The whole attempt (gate, recall, related judgments, writer, commit):
      // what an agent_end that records this segment spends in models.
      const tSeg = performance.now();
      try {
        r = await this.ingestSegment(job.turns, job.earlier, signal, job);
        const nothingNew = r.actions.some((a) => a.reason === NOTHING_NEW) && r.actions.every((a) => a.op === "skip");
        this.emit("ingest", "segment_done", { segment: job.id, turns: job.turns.length, ok: r.actions.every((a) => a.ok), ...(nothingNew ? { nothingNew } : {}), ms: msSince(tSeg) });
      } catch (e) {
        const error = String((e as Error).message ?? e);
        const parked = await this.meta.exclusive(() => this.meta.fail(job.id, error, maxAttempts));
        this.emit("ingest", parked ? "quarantined" : "attempt_failed", { segment: job.id, error, ms: msSince(tSeg) });
        if (!parked) throw e;
        appendResult({ gate: job.decision?.gate ?? null, scope: job.decision?.scope ?? null, targets: [], options: [], actions: [{ op: "skip", ok: false, error }] });
        continue;
      }
      appendResult(r);
      if (!r.actions.length || r.actions.some((a) => !a.ok)) {
        const error = r.actions.filter((a) => !a.ok).map((a) => a.error || "write failed").join("; ") || "no actions";
        const parked = await this.meta.exclusive(() => this.meta.fail(job.id, error, maxAttempts));
        this.emit("ingest", parked ? "quarantined" : "attempt_failed", { segment: job.id, error });
        if (parked) continue;
        break;
      }
      await this.meta.exclusive(() => this.meta.complete(job.id, r.actions.every((a) => a.op === "skip"), this.opts.tailTurns));
    }
    return combined;
  }

  /** Called under meta.exclusive. Completion recovery never invokes a model. */
  private completedResult(job: SegmentJob): IngestResult | null {
    if (!job.decision) return null;
    const { gate, scope } = job.decision;
    const result: IngestResult = { gate, scope, targets: [], options: [], actions: [] };
    if (gate < this.opts.gateAt || scope === "empty") return { ...result, actions: [{ op: "skip", ok: true, reason: "persisted skip decision" }] };
    for (const side of scope === "both" ? ["user", "assistant"] : [scope]) {
      const plan = this.meta.plan<WritePlan>(job.id, side);
      if (!plan) return null;
      // An empty plan is the writer's "nothing new": complete with nothing to replay.
      if (!plan.steps.length) result.actions.push(nothingNew());
      for (const step of plan.steps) {
        const receipt = this.meta.receipt<IngestAction>(`${job.id}:${side}:${step.key}`);
        if (!receipt?.ok) return null;
        result.actions.push(receipt);
      }
      result.targets.push(...plan.targets); result.options.push(...plan.options);
    }
    return result;
  }

  /** P(the current message changed the topic of the pending turns). */
  private async topicShift(tail: SegmentTurn[], pending: SegmentTurn[], current: string, signal?: AbortSignal): Promise<number> {
    const state: Record<string, unknown> = {};
    if (tail.length) state.recorded_before = this.turnsView(tail, 1200);
    // The mark sits between what was recorded and what was not, in the state's own order.
    state.mark = RECORD_MARK;
    state.since_last_record = this.turnsView(pending, this.opts.segmentChars);
    state.current_user_message = clipText(current, this.opts.messageChars);
    const t0 = performance.now();
    const ans = await this.judge.ask(state, { topic_shift: { type: "noul", instructions: TOPIC_SHIFT_QUESTION, criteria: TOPIC_SHIFT_CRITERIA } }, signal);
    const a = ans.topic_shift;
    const p = a?.type === "noul" ? a.noul : 1;
    this.emit("ingest", "topic_shift", { pending: pending.length, current: truncate(current, 200), p: round3(p), ms: msSince(t0) });
    return p;
  }

  /** Turns as Jev sees them: [{role, text}], newest kept within `chars`. */
  private turnsView(turns: SegmentTurn[], chars: number): { role: "user" | "assistant"; text: string; time?: string }[] {
    const flat: { role: "user" | "assistant"; text: string; time?: string }[] = [];
    for (const t of turns) {
      // When it was said (local date, weekday, clock): Jev cannot tell one
      // 「周日」 from another without it.
      const m = turnMoment(t.user, t.time);
      flat.push({ role: "user", text: balancedClip(t.user, this.opts.messageChars * 2), ...(m ? { time: describeMoment(m) } : {}) });
      // The hidden monologue labelled as unspoken, as the writer sees it
      // (renderTurns): mood and decisions, not things the character said.
      if (t.assistant) flat.push({ role: "assistant", text: balancedClip(markMonologue(t.assistant), 800) });
    }
    const out: typeof flat = [];
    let used = 0;
    for (let i = flat.length - 1; i >= 0; i--) {
      if (used + flat[i].text.length > chars && out.length) break;
      used += flat[i].text.length;
      out.unshift(flat[i]);
    }
    return out;
  }

  /**
   * Files this session's recently finished segments (not `job` itself)
   * wrote on `side` and that still exist, newest segment first. A topic that
   * comes back a few segments later most likely belongs in the file it was
   * written to then, even when BGE ranks that file low. Called under meta.exclusive.
   */
  private recentFiles(job: SegmentJob, side: MemoryScope, all: MemoryRecord[]): string[] {
    const uris: string[] = [];
    for (const id of this.meta.recentJobs(job.session, RECENT_SEGMENTS + 1)) {
      if (id === job.id) continue;
      for (const a of this.meta.receipts<IngestAction>(id))
        if (a.ok && a.op !== "skip" && a.uri?.startsWith(`${side}/`) && !uris.includes(a.uri) && all.some((r) => r.uri === a.uri)) uris.push(a.uri);
    }
    return uris;
  }

  /** One turn as a segment of its own, its `context` as the recorded tail (direct use and tests). */
  ingest(turn: Turn, signal?: AbortSignal): Promise<IngestResult> {
    const earlier = (turn.context ?? []).map((u) => u.trim()).filter(Boolean).slice(-3).map((u) => ({ user: u }));
    return this.ingestSegment([{ user: turn.user.trim(), ...(turn.assistant ? { assistant: turn.assistant } : {}), ...(turn.time ? { time: turn.time } : {}) }], earlier, signal);
  }

  /** Record one finished segment: gate + scope, then per side recall → related-or-not per file → write. */
  async ingestSegment(turns: SegmentTurn[], earlier: SegmentTurn[], signal?: AbortSignal, job?: SegmentJob): Promise<IngestResult> {
    // Recall markup in a reply is cleaned here too: segments persisted before
    // observe() stripped it, and turns passed in directly.
    turns = turns.filter((t) => t.user?.trim()).map(withoutRecallMarkup);
    earlier = earlier.map(withoutRecallMarkup);
    if (!turns.length) return { gate: null, scope: null, targets: [], options: [], actions: [] };
    // Jev's view of the segment; the recorded turns before it only resolve references.
    const state: Record<string, unknown> = {};
    if (earlier.length) state.earlier_conversation = this.turnsView(earlier, 1200);
    // When the segment was said, for every ingest judgment (gate/scope here,
    // the per-file related judge through judgeState): 「周日」 said on
    // 2026-11-02 and 「周日」 said a week later are different days.
    const spoken = segmentSpan(turns);
    if (spoken) state.spoken_at = `这段对话说于 ${spoken}；对话里的「今天」「周日」「九点」都以说话的时间为准`;
    state.conversation = this.turnsView(turns, this.opts.segmentChars);
    // One request, two questions: is it worth storing, and whose memory is it
    // (user / assistant / both / empty — empty is a second gate).
    const tGate = performance.now();
    const gateAns = job?.decision ? null : await this.judge.ask(
      state,
      {
        worth_storing: { type: "noul", instructions: GATE_QUESTION, criteria: GATE_CRITERIA },
        scope: { type: "choice", instructions: INGEST_SCOPE_QUESTION, criteria: INGEST_SCOPE_CRITERIA },
      },
      signal,
    );
    const gateMs = gateAns ? msSince(tGate) : 0;
    let gate = gateAns?.worth_storing?.type === "noul" ? gateAns.worth_storing.noul : 1;
    let scope = scopeOf(gateAns?.scope, "user");
    if (job) {
      const d = job.decision ?? await this.meta.exclusive(() => this.meta.decide(job.id, { gate, scope }));
      gate = d.gate; scope = d.scope;
    }
    const said = turns.map((t) => t.user).join(" / ");
    if (gate < this.opts.gateAt || scope === "empty") {
      this.emit("ingest", "judge", { turns: turns.length, user: truncate(said, 400), gate, scope, gateMs });
      const reason = gate < this.opts.gateAt ? `gate=${gate.toFixed(2)}` : "scope=empty";
      return { gate, scope, targets: [], options: [], actions: [{ op: "skip", ok: true, reason }] };
    }
    // "both": the whole write path runs once per side — recall within that
    // side, Jev's related-or-not per file, the writer writing that side's own version.
    const sides: MemoryScope[] = scope === "both" ? ["user", "assistant"] : [scope];
    const result: IngestResult = { gate, scope, targets: [], options: [], actions: [] };
    for (const side of sides) {
      // Models run outside the store lock. Write-back checks the file snapshot
      // inside a short transaction; concurrent changes trigger a bounded rebase.
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await this.placeAndWrite(turns, earlier, state, side, sides.length > 1, signal, job);
          result.targets.push(...r.targets);
          result.options.push(...r.options);
          result.actions.push(...r.actions);
          if (r.actions.some((a) => !a.ok)) return result;
          break;
        } catch (e) {
          if (!(e instanceof Conflict) || attempt >= 3) throw e;
          this.emit("ingest", "conflict", { uri: e.uri, side, attempt });
        }
      }
    }
    return result;
  }

  private async placeAndWrite(
    turns: SegmentTurn[],
    earlier: SegmentTurn[],
    state: Record<string, unknown>,
    side: MemoryScope,
    bothSides: boolean,
    signal?: AbortSignal,
    job?: SegmentJob,
  ): Promise<Pick<IngestResult, "targets" | "options" | "actions">> {
    const saved = job ? await this.meta.exclusive(() => this.meta.plan<WritePlan>(job.id, side)) : null;
    if (saved) return { targets: saved.targets, options: saved.options, actions: saved.steps.length ? await this.commitPlan(saved, job!, side, signal) : [nothingNew()] };
    // Candidates: the most similar files of this side by plain similarity (no
    // importance or forgetting here — an old, minor file is still where its
    // own update belongs). Jev judges each on its own: is it related to what
    // this segment records? There is no "new" option: whether to update a
    // related file or start a new one is the writer's call.
    const everything = await this.store.all();
    // The scan may overlap another session's commit; never prune metadata
    // based on this potentially older inventory.
    const metas = await this.meta.exclusive(() => this.meta.sync(everything, this.now(), false));
    const all = everything.filter((r) => r.scope === side);
    const query = segmentQuery(turns, this.opts.queryChars);
    const { items: ranked, source, ms: bgeMs } = await this.recallFiles(all, query, all.length, { weighted: false, signal });
    const items: Candidate[] = ranked.slice(0, Math.max(0, this.opts.ingestCandidates)).map((i) => ({ ...i, source: "bge" as const }));
    // A file outside the shortlist joins at its real similarity when it has one.
    const candidate = (uri: string, from: CandidateSource): Candidate | null => {
      if (items.some((i) => i.record.uri === uri)) return null;
      const hit = ranked.find((i) => i.record.uri === uri);
      const rec = all.find((r) => r.uri === uri);
      if (hit) return { ...hit, source: from };
      return rec ? { record: rec, similarity: 0, rank: 0, importance: DEFAULT_IMPORTANCE, forgetting: 1, source: from } : null;
    };
    // A cap creates a continuation, not a new topic. Keep its successfully
    // written files in the candidate set even when an elliptical query misses them.
    const linked = await this.meta.exclusive(() => {
      const uris: string[] = [];
      let previous = job?.continuationOf;
      while (previous && !uris.length) {
        uris.push(...this.meta.receipts<IngestAction>(previous)
          .filter((a) => a.ok && a.uri?.startsWith(`${side}/`) && all.some((r) => r.uri === a.uri)).map((a) => a.uri!));
        previous = this.meta.job(previous)?.continuationOf;
      }
      return uris;
    });
    for (const uri of linked) {
      const c = candidate(uri, "continuation");
      if (c) items.push(c);
    }
    // Beyond BGE's shortlist, up to `extraCandidates` more: files this
    // session's recent segments wrote, and lexical matches on topic/summary,
    // taken in turn. In a 354-turn role-play run the shortlist often lacked
    // the file of the very same topic (`虾饺` vs `虾饺请客` / `虾饺食量`), Jev never
    // saw it and the writer created the topic again; 125 files in an hour.
    const recent = job ? await this.meta.exclusive(() => this.recentFiles(job, side, all)) : [];
    const lexical = lexicalMatches(all, query);
    for (let i = 0, extra = 0; extra < Math.max(0, this.opts.extraCandidates) && (i < recent.length || i < lexical.length); i++) {
      for (const [uri, from] of [[recent[i], "recent"], [lexical[i], "lexical"]] as const) {
        if (!uri || extra >= this.opts.extraCandidates) continue;
        const c = candidate(uri, from);
        if (c) { items.push(c); extra++; }
      }
    }
    // The background tells Jev what the files are and that `conversation` is
    // the segment being recorded (earlier_conversation only context): without
    // it, a segment that merely re-asks what a file holds was judged unrelated
    // to that file, and the writer created a duplicate (see INGEST_BACKGROUND).
    // Only this question gets it; the gate/scope state is unchanged.
    const judgeState = { background: INGEST_BACKGROUND, ...state, ...(linked.length ? { continuation: { previous_segment: job!.continuationOf, files: linked,
      instruction: "这是因长度上限切开的同一话题续段，上一段写进过这些文件。" } } : {}) };
    // Each file gets what the state, question and criteria leave of the request budget.
    const room = Math.max(1800, this.opts.jevChars - JSON.stringify(judgeState).length - RELATED_QUESTION.length - JSON.stringify(RELATED_CRITERIA).length - 600);
    const tJudge = performance.now();
    // Each file with all its write times (local), next to the segment's spoken_at.
    const judged = items.length ? await this.judgeEach(judgeState, items, RELATED_QUESTION, RELATED_CRITERIA, signal, { name: "related", chars: room, times: true }) : [];
    const judgeMs = msSince(tJudge);
    const options: IngestResult["options"] = judged.map((j, i) => ({ side, option: `f${i + 1}`, uri: j.record.uri, similarity: round3(j.similarity), p: round3(j.p), source: items[i].source }));
    // The related files, most similar first, at most `writeFiles` of them.
    const related = judged
      .filter((j) => j.p >= this.opts.relatedAt)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, Math.max(0, this.opts.writeFiles))
      .map((j) => j.record);
    let targets = related.map((r) => r.uri);
    this.emit("ingest", "judge", {
      turns: turns.length,
      user: truncate(turns.map((t) => t.user).join(" / "), 400),
      side,
      recallSource: source,
      // [uri, similarity, P(related), candidate source]
      options: options.map((o) => [o.uri, o.similarity ?? null, o.p, o.source]),
      targets,
      ms: judgeMs,
      bgeMs,
    });

    // The writer gets the related files, each with its importance, and
    // returns as JSON, per file, how it is written: append (the new lines),
    // edit (the whole corrected body), or new files when what is being
    // recorded is a different matter.
    const target = (rec: MemoryRecord): WriteTarget => ({ rec, importance: metas.get(rec.uri)?.importance ?? DEFAULT_IMPORTANCE });
    let writeTargets: WriteTarget[] = related.map(target);
    const time = [...turns].reverse().find((t) => t.time)?.time;
    const validate = (ts: WriteTarget[]) => (out: Record<string, unknown>) => prepareWrites(out, ts, side, time, true);
    // Soft checks, one corrective round: time in a title (always), and entries
    // with relative time only or a date without its weekday (when the segment's time is known).
    const lint = (steps: WriteStep[]) => writerComplaints(steps, writeTargets, datable(turns));
    let { steps, reply, ms } = await this.write(ingestUserPrompt({ turns, earlier, targets: writeTargets, scope: side, bothSides }), validate(writeTargets), signal, lint);
    // A `new` named like a file this side already has (by name, or by topic)
    // used to become `<name>_2`: one topic, several files. Instead the writer
    // is asked once more, with those files shown, to write into them or pick
    // a distinguishable name. Re-asking (rather than turning the `new` into an
    // append right away) lets it see what the file already holds — so it can
    // dedupe, edit, or write nothing — and keep the file's summary whole.
    const taken = takenFiles(steps, all, side);
    if (taken.length && steps.every((s) => s.write)) {
      for (const t of taken) if (!writeTargets.some((w) => w.rec.uri === t.rec.uri)) writeTargets = [...writeTargets, target(t.rec)];
      this.emit("ingest", "new_taken", { side, taken: taken.map((t) => [t.proposed, t.rec.uri]) });
      const again = await this.write(
        ingestUserPrompt({ turns, earlier, targets: writeTargets, scope: side, bothSides, taken: [...new Set(taken.map((t) => t.proposed))] }),
        validate(writeTargets),
        signal,
        lint,
      );
      ({ steps, reply } = again);
      ms += again.ms;
      // Still the exact uri of an existing file: append to it (last resort; never a `_2`).
      if (steps.every((s) => s.write)) steps = foldTaken(steps, writeTargets);
      targets = writeTargets.map((t) => t.rec.uri);
    }
    // A title that still carries time after the corrective round is kept, with
    // a trace warning (see titleTimes for why it is not stripped).
    const timed = titleTimes(steps, writeTargets);
    if (timed.length) this.emit("ingest", "title_time", { ...(job ? { segment: job.id } : {}), side, titles: timed.map((t) => [t.uri, t.title, t.words]) });
    const errors = steps.filter((s) => !s.write).map((s) => s.action);
    if (errors.length) {
      this.emit("ingest", "write", { ...(job ? { segment: job.id } : {}), side, actions: errors, llmText: reply, ms });
      return { targets, options, actions: errors };
    }
    // The related files already hold everything this segment says: nothing
    // is written, and the segment completes as "nothing new" (no more
    // "asked again" lines). prepareWrites only allows this with files shown.
    if (!steps.length) {
      const actions = [nothingNew()];
      if (job) await this.meta.exclusive(() => this.meta.savePlan<WritePlan>(job.id, side, { targets, options, steps }));
      this.emit("ingest", "write", { ...(job ? { segment: job.id } : {}), side, actions, nothingNew: true, llmText: reply, ms });
      return { targets, options, actions };
    }
    if (job) {
      const plan = await this.meta.exclusive(() => this.meta.savePlan<WritePlan>(job.id, side, { targets, options, steps }));
      const actions = await this.commitPlan(plan, job, side, signal);
      this.emit("ingest", "write", { segment: job.id, side, actions, llmText: reply, ms });
      return { targets: plan.targets, options: plan.options, actions };
    }
    // Write-back: inside one write transaction (a lock across processes), the
    // related files must still be exactly what was read and shown to the
    // writer — compared against the file on disk, not a separately read
    // version number, so no read window and no hand edit slips through.
    const actions = await this.meta.transaction(async () => {
      signal?.throwIfAborted();
      for (const { rec: f } of writeTargets) if ((await this.store.diskFingerprint(f.uri)) !== fingerprint(f)) throw new Conflict(f.uri);
      // A new uri taken meanwhile would fail mid-way, after earlier steps were written: check first.
      for (const s of steps) if (s.write?.mode === "create" && s.write.uri && (await this.store.diskFingerprint(s.write.uri)) !== null) throw new Conflict(s.write.uri);
      return this.applyWrites(steps);
    });
    // The whole raw reply: a write that went wrong can only be debugged from it.
    this.emit("ingest", "write", { side, actions, llmText: reply, ms });
    return { targets, options, actions };
  }

  /**
   * One writer call. A reply that is not JSON, or whose JSON does not pass
   * validation, is sent back once with what was wrong; the second reply
   * stands, right or wrong (nothing is written from a reply with errors).
   * `lint` adds soft complaints (an entry with relative time and no absolute
   * date): they can trigger that same one corrective round, but never block
   * the second reply.
   */
  private async write(
    prompt: string,
    validate: (out: Record<string, unknown>) => WriteStep[],
    signal?: AbortSignal,
    lint?: (steps: WriteStep[]) => string[],
  ): Promise<{ steps: WriteStep[]; reply: string; ms: number }> {
    // `ms`: the writer's DeepSeek time, both rounds when the first reply is sent back.
    const t0 = performance.now();
    const messages: ChatMessage[] = [{ role: "system", content: INGEST_SYSTEM }, { role: "user", content: prompt }];
    let steps: WriteStep[] = [];
    let reply = "";
    for (let round = 0; round < 2; round++) {
      const res = await this.llm.chat(messages, { json: true, temperature: 0.2, maxTokens: 4000, signal });
      reply = res.content || "";
      const out = extractJson(reply);
      steps = out ? validate(out) : [{ key: "error:0", action: { op: "skip", ok: false, error: "writer reply is not a JSON object" } }];
      const errors = steps.filter((s) => !s.write).map((s) => s.action.error);
      if (round === 0 && !errors.length && lint) errors.push(...lint(steps));
      if (!errors.length) break;
      messages.push(
        { role: "assistant", content: reply },
        { role: "user", content: `上面的输出有问题：\n${errors.map((e) => `- ${e}`).join("\n")}\n改正后重新输出完整的 JSON 对象，不要别的文字。` },
      );
    }
    return { steps, reply, ms: msSince(t0) };
  }

  /** Apply validated writer steps (direct ingest without a segment job). */
  private async applyWrites(steps: WriteStep[]): Promise<IngestAction[]> {
    const actions: IngestAction[] = [];
    for (const step of steps) {
      try {
        const { rec } = await this.store.write(step.write!, { retainActions: (ids) => this.meta.retainActionMarkers(ids) });
        if (step.action.op === "new") this.meta.created(rec.uri, this.now());
        else this.meta.updated(rec.uri, this.now(), step.importance);
        actions.push({ ...step.action, uri: rec.uri, ok: true });
      } catch (e) {
        if (e instanceof Conflict) throw e;
        actions.push({ ...step.action, ok: false, error: String((e as Error).message ?? e) });
      }
    }
    return actions;
  }

  /** A receipt and the file's embedded action id together cover either crash order. */
  private async commitPlan(plan: WritePlan, job: SegmentJob, side: MemoryScope, signal?: AbortSignal): Promise<IngestAction[]> {
    const actions: IngestAction[] = [];
    for (let index = 0; index < plan.steps.length; index++) {
      const id = `${job.id}:${side}:${plan.steps[index].key}`;
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        const receipt = await this.meta.exclusive(() => this.meta.receipt<IngestAction>(id));
        if (receipt) { actions.push(receipt); break; }
        // Another worker may already have rebased an uncommitted edit.
        plan = (await this.meta.exclusive(() => this.meta.plan<WritePlan>(job.id, side)))!;
        const step = plan.steps[index];
        try {
          const action = await this.meta.transaction(async () => {
            signal?.throwIfAborted();
            const done = this.meta.receipt<IngestAction>(id);
            if (done) return done;
            const { rec } = await this.store.write({ ...step.write!, actionId: id }, { retainActions: (ids) => this.meta.retainActionMarkers(ids) });
            if (step.action.op === "new") this.meta.created(rec.uri, this.now());
            // Recovery may find our marker underneath a newer committed
            // action. Restore our receipt without reverting its ranking metadata.
            else if (rec.appliedActions?.at(-1) === id) this.meta.updated(rec.uri, this.now(), step.importance);
            const result: IngestAction = { ...step.action, id, uri: rec.uri, ok: true };
            this.meta.saveReceipt(id, job.id, side, result);
            return result;
          });
          actions.push(action);
          break;
        } catch (e) {
          if (e instanceof Conflict && attempt < 2) {
            // Only this still-uncommitted file is regenerated. Completed files
            // and new-file actions retain their original ids and payloads.
            const rec = await this.store.get(e.uri);
            if (!rec) throw e;
            const importance = await this.meta.exclusive(() => this.meta.get(rec.uri)?.importance ?? DEFAULT_IMPORTANCE);
            const target = { rec, importance };
            const { steps: revised } = await this.write(
              ingestUserPrompt({ turns: job.turns, earlier: job.earlier, targets: [target], scope: side, onlyUpdate: true }),
              (out) => prepareWrites(out, [target], side, step.write?.time, false),
              signal,
              (steps) => writerComplaints(steps, [target], datable(job.turns)),
            );
            // The file (changed, or a `new` whose uri another session just
            // took) already holds what this step would add: nothing to write.
            if (!revised.length) {
              const result: IngestAction = { ...step.action, op: "skip", id, uri: rec.uri, ok: true, reason: NOTHING_NEW };
              await this.meta.exclusive(() => this.meta.saveReceipt(id, job.id, side, result));
              actions.push(result);
              break;
            }
            if (revised.length !== 1 || !revised[0].write || revised[0].write.uri !== rec.uri) {
              actions.push({ ...step.action, id, ok: false, error: "writer could not rebase the uncommitted file" });
              return actions;
            }
            const next = structuredClone(plan);
            next.steps[index] = { ...revised[0], key: step.key };
            plan = await this.meta.exclusive(() => this.meta.revisePlan(job.id, side, plan, next));
            continue;
          }
          actions.push({ ...step.action, id, ok: false, error: String((e as Error).message ?? e) });
          return actions;
        }
      }
    }
    return actions;
  }

  // ---------------------------------------------------------------- retrieve
  //
  //   0. Gate (Jev, one request): does answering need memory that is not
  //      already in the conversation — its history and the files this topic
  //      already recalled (mid-term memory, `recalled`)? Below `recallAt`
  //      nothing is recalled this turn.
  //   1. BGE recall over all files of both sides (no "which side" step:
  //      without more prior knowledge Jev cannot tell reliably whose memory a
  //      question needs, and a wrong pick hides a whole side). The query is
  //      the current message plus the most recent conversation (so a
  //      follow-up like "那它在哪个会议室？" finds the file the conversation is
  //      about). Files are ordered by
  //        similarity × (1 + importance) × 0.5^(days since last update / halfLifeDays)
  //      and the top `recall` go on.
  //   2. Rewrite (DeepSeek, JSON): given the message, the conversation and
  //      the recalled files (topic, summary, newest entry), it decides
  //      whether a SECOND query would find a file the list lacks — the
  //      matter of a question that is not in the list, or the other matter
  //      of a two-part question; never for statements or small talk. The new
  //      query is phrased like the summary it should land on (it reads the
  //      writer's summary guidance) in the memory's own words; the two
  //      recalls are merged, each file at its better rank. Skipped when the
  //      first recall already holds every file.
  //   3. One Jev request PER recalled file, in parallel: state = the
  //      conversation (background, history, current message), question = the
  //      file ("is this file relevant to the conversation?"). A file reaches
  //      the answering model only if its P(relevant) ≥ minScore.

  async retrieve(message: string, opts: { history?: HistoryTurn[]; signal?: AbortSignal; recalled?: string[] } = {}): Promise<RetrieveResult> {
    const msg = message.trim();
    const signal = opts.signal;
    const t0 = performance.now();
    const timings: RetrieveTimings = { gate: 0, bge: 0, rewrite: 0, judge: 0, total: 0 };
    const finished = (): RetrieveTimings => ({ ...timings, total: msSince(t0) });
    const all = await this.store.all();
    // A complete inventory: the only place stale vectors may be dropped.
    if (this.index) await this.index.retain(all.map((r) => r.uri)).catch((e) => {
      this.emit("retrieve", "cache_cleanup_failed", { error: String((e as Error).message ?? e) });
    });
    const none = { gate: null, rewrite: null, hits: [], recallSource: null, recalled: [], evidence: renderEvidence([]) };
    if (!msg || !all.length) return none;
    const conversation = this.fitHistory(opts.history ?? []);

    if (this.opts.retrieval === "bm25") {
      const hits = bm25Rank(all.map((r) => ({ item: r, text: `${r.topic} ${r.summary || r.body}` })), msg)
        .filter((x) => x.score > 0)
        .slice(0, this.opts.k)
        .map((x) => ({ record: x.item, score: x.score, source: "bm25" as const }));
      this.emit("retrieve", "bm25", { hits: hits.map((h) => [h.record.uri, h.score]) });
      return {
        gate: null,
        rewrite: null,
        hits,
        recallSource: "bm25",
        recalled: hits.map((h) => ({ uri: h.record.uri, similarity: h.score, rank: h.score, importance: DEFAULT_IMPORTANCE, forgetting: 1, passed: true })),
        evidence: renderEvidence(hits, this.opts.evidenceChars),
      };
    }

    let state: Record<string, unknown> = { background: RETRIEVAL_BACKGROUND, conversation, current_message: clipText(msg, this.opts.messageChars) };
    let gate: RetrieveResult["gate"] = null;
    // Time awareness rides the gate's request as a second question (one Jev
    // call either way); with the gate off it is asked on its own.
    const timeQ = this.opts.timeAware
      ? { time_related: { type: "noul" as const, instructions: TIME_RELATED_QUESTION, criteria: TIME_RELATED_CRITERIA } }
      : {};
    let timeP: number | null = null;
    if (this.opts.recallGate) {
      const shown = all.filter((r) => opts.recalled?.includes(r.uri));
      const room = Math.max(1800, this.opts.jevChars - JSON.stringify(state).length - NEED_RECALL_QUESTION.length - (this.opts.timeAware ? TIME_RELATED_QUESTION.length + 200 : 0) - 600);
      const per = shown.length ? Math.floor(room / shown.length) : 0;
      const tGate = performance.now();
      const ans = await this.judge.ask(
        { ...state, recalled_memory: shown.map((r) => this.fileView(r, per)) },
        { need_recall: { type: "noul", instructions: NEED_RECALL_QUESTION, criteria: NEED_RECALL_CRITERIA }, ...timeQ },
        signal,
      );
      const a = ans.need_recall;
      // A missing answer recalls rather than not.
      const p = a?.type === "noul" ? a.noul : 1;
      gate = { p: round3(p), recall: p >= this.opts.recallAt };
      // A missing time answer is "not time-related": the normal path.
      if (this.opts.timeAware) timeP = ans.time_related?.type === "noul" ? ans.time_related.noul : 0;
      timings.gate = msSince(tGate);
      this.emit("retrieve", "gate", { ...gate, ...(timeP !== null ? { time: round3(timeP) } : {}), recalled: shown.map((r) => r.uri), ms: timings.gate });
      if (!gate.recall) {
        const time = timeP === null ? null : { p: round3(timeP), fired: timeP >= this.opts.timeAt };
        return { ...none, gate, time, timings: finished() };
      }
    } else if (this.opts.timeAware) {
      const tGate = performance.now();
      const ans = await this.judge.ask(state, timeQ, signal);
      timeP = ans.time_related?.type === "noul" ? ans.time_related.noul : 0;
      timings.gate = msSince(tGate);
    }
    // Time-related turn: resolve the dates by rule and find the files that name them.
    const time: TimeInfo | null = timeP === null ? null : { p: round3(timeP), fired: timeP >= this.opts.timeAt };
    let dated: { record: MemoryRecord; hits: { text: number; times: number } }[] = [];
    if (time?.fired) {
      const today = envelopeOf(msg)?.day ?? localDay(this.now())!;
      const mentions = resolveMentions(msg, today);
      const days = [...new Set(mentions.flatMap((m) => m.dates))];
      if (days.length) {
        dated = all
          .map((record) => ({ record, hits: dateHits(record, days) }))
          .filter((x) => x.hits.text + x.hits.times > 0)
          .sort((a, b) => b.hits.text - a.hits.text || b.hits.times - a.hits.times || (Date.parse(b.record.updatedAt) || 0) - (Date.parse(a.record.updatedAt) || 0));
        // The judge sees what the words resolved to, so 「周六」 and an entry dated 2026-11-07 meet.
        state = { ...state, time_reference: {
          note: "用户这句话里的时间说法换算成的日期（按说话那天换算；记忆条目里写的是绝对日期）",
          today: describeMoment({ day: today }),
          mentioned: mentions.map((m) => `${m.text} = ${m.dates.map((d) => `${d}（${weekdayName(d)}）`).join(" 或 ")}`),
        } };
      }
      Object.assign(time, { today, mentions, dated: dated.slice(0, Math.max(0, this.opts.timeFiles)).map((x) => x.record.uri) });
      this.emit("retrieve", "time", { p: time.p, today, mentions, dated: dated.slice(0, 10).map((x) => [x.record.uri, x.hits.text, x.hits.times]), used: time.dated });
    } else if (time) {
      this.emit("retrieve", "time", { p: time.p, fired: false });
    }
    let query = this.recallQuery(msg, conversation);
    // With date matches, rank the whole store once: a dated file then keeps its real similarity.
    const first = await this.recallFiles(all, query, dated.length ? all.length : this.opts.recall, { weighted: true, signal });
    let items = first.items.slice(0, this.opts.recall);
    let source = first.source;
    timings.bge = first.ms;
    let rewrite: RetrieveResult["rewrite"] = null;
    // When the first recall already holds every file in the store, a second
    // query cannot add a candidate (the merge is the same set), so the
    // DeepSeek round is skipped.
    if (this.opts.queryRewrite && items.length < all.length) {
      const tRewrite = performance.now();
      const next = await this.rewriteQuery(msg, conversation, query, items.map((i) => i.record), all.length, signal);
      timings.rewrite = msSince(tRewrite);
      if (next) {
        rewrite = { query: next };
        const second = await this.recallFiles(all, next, this.opts.recall, { weighted: true, signal });
        timings.bge += second.ms;
        // Union of both recalls, each file once at its better rank, then the
        // top `recall`: a rewrite can only add candidates, not lose good ones.
        const best = new Map<string, RecallItem>();
        for (const it of [...items, ...second.items]) if (!best.has(it.record.uri) || best.get(it.record.uri)!.rank < it.rank) best.set(it.record.uri, it);
        items = [...best.values()].sort((x, y) => y.rank - x.rank).slice(0, this.opts.recall);
        source = second.source ?? source;
        query = next;
      }
    }
    // n date-matched files first, then (recall − n) from BGE, each once.
    const datedUsed = dated.slice(0, Math.max(0, this.opts.timeFiles));
    if (datedUsed.length) {
      const asItem = (r: MemoryRecord): RecallItem =>
        first.items.find((i) => i.record.uri === r.uri) ?? { record: r, similarity: 0, rank: 0, importance: DEFAULT_IMPORTANCE, forgetting: 1 };
      items = mergeCandidates(datedUsed.map((x) => asItem(x.record)), items, this.opts.recall, this.opts.timeFiles, (i) => i.record.uri);
    }
    const datedHits = new Map(datedUsed.map((x) => [x.record.uri, x.hits]));
    const tJudge = performance.now();
    const judged = await this.judgeEach(state, items, RELEVANT_QUESTION, RELEVANT_CRITERIA, signal);
    timings.judge = msSince(tJudge);
    const passed = judged
      .filter((j) => j.p >= this.opts.minScore)
      .sort((x, y) => y.p - x.p)
      .slice(0, this.opts.k);
    const keep = new Set(passed.map((j) => j.record.uri));
    const weights = new Map(items.map((it) => [it.record.uri, it]));
    const recalled: Recalled[] = judged.map((j) => {
      const w = weights.get(j.record.uri)!;
      return {
        uri: j.record.uri,
        similarity: round3(j.similarity),
        rank: round3(w.rank),
        importance: round3(w.importance),
        forgetting: round3(w.forgetting),
        p: round3(j.p),
        passed: keep.has(j.record.uri),
        ...(datedHits.has(j.record.uri) ? { dated: datedHits.get(j.record.uri)! } : {}),
      };
    });
    this.emit("retrieve", "judge", { rewritten: Boolean(rewrite), recallSource: source, query: truncate(query, 300), recalled, ms: timings.judge, bgeMs: timings.bge });
    const hits = passed.map((j) => ({ record: j.record, score: j.p, source: "judge" as const }));
    return { gate, rewrite, time, hits, recallSource: source, recalled, evidence: renderEvidence(hits, this.opts.evidenceChars), timings: finished() };
  }

  /**
   * DeepSeek's look at the first recall: null keeps the query, a string is
   * the rewritten one. A failed or unusable reply keeps the query — the
   * rewrite only ever improves recall, it must not fail the turn.
   */
  private async rewriteQuery(
    msg: string,
    conversation: HistoryTurn[],
    query: string,
    files: MemoryRecord[],
    total: number,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const t0 = performance.now();
    try {
      const res = await this.llm.chat(
        [
          { role: "system", content: REWRITE_SYSTEM },
          { role: "user", content: rewriteUserPrompt({ conversation, message: clipText(msg, this.opts.messageChars), query, files, total }) },
        ],
        { json: true, temperature: 0, maxTokens: 800, signal },
      );
      const out = extractJson(res.content);
      const next = out?.rewrite === true && typeof out.query === "string" ? truncate(out.query.trim(), this.opts.queryChars) : "";
      this.emit("retrieve", "rewrite", { query: truncate(query, 300), rewrite: out?.rewrite === true, next, ms: msSince(t0) });
      return next && next !== query ? next : null;
    } catch (e) {
      if (signal?.aborted) throw e;
      this.emit("retrieve", "rewrite_failed", { error: truncate(String((e as Error).message ?? e), 200), ms: msSince(t0) });
      return null;
    }
  }

  /**
   * Top-n files for `query`: by dense similarity, or by BM25 when there is no
   * embedder or the embedding service fails (recall must not fail the turn).
   * `weighted` (retrieval) orders by similarity × (1 + importance) ×
   * forgetting instead of similarity alone (ingest).
   */
  private async recallFiles(
    pool: MemoryRecord[],
    query: string,
    n: number,
    opts: { weighted: boolean; signal?: AbortSignal },
  ): Promise<{ items: RecallItem[]; source: "bge" | "bm25" | null; ms: number }> {
    if (!pool.length || n <= 0) return { items: [], source: null, ms: 0 };
    // `ms`: the whole recall — query embedding and file vectors (cache misses
    // are embedded here too), or the BM25 fallback after a failed embedding.
    const t0 = performance.now();
    const { signal } = opts;
    let scored: { record: MemoryRecord; similarity: number }[] | null = null;
    let source: "bge" | "bm25" = "bge";
    if (this.index && this.embedder) {
      try {
        const [qv] = await this.embedder.embed([query], signal);
        const vecs = await this.index.vectors(pool, signal);
        scored = pool.map((r) => ({ record: r, similarity: dot(qv, vecs.get(r.uri)!) }));
      } catch (e) {
        if (signal?.aborted) throw e;
        this.emit("retrieve", "recall_fallback", { error: truncate(String((e as Error).message ?? e), 200) });
      }
    }
    if (!scored) {
      source = "bm25";
      scored = bm25Rank(pool.map((r) => ({ item: r, text: `${r.topic} ${r.summary} ${truncate(r.body, 300)}` })), query)
        .filter((x) => x.score > 0)
        .map((x) => ({ record: x.item, similarity: x.score }));
    }
    const metas = opts.weighted ? await this.meta.exclusive(() => new Map(pool.map((r) => [r.uri, this.meta.get(r.uri)]))) : null;
    const items = scored
      .map((x) => opts.weighted ? this.weigh(x, metas?.get(x.record.uri) ?? {
        uri: x.record.uri, importance: DEFAULT_IMPORTANCE,
        createdAt: Date.parse(x.record.createdAt) || this.now(), updatedAt: Date.parse(x.record.updatedAt) || this.now(),
      }) : { ...x, rank: x.similarity, importance: DEFAULT_IMPORTANCE, forgetting: 1 })
      .sort((a, b) => b.rank - a.rank)
      .slice(0, n);
    return { items, source, ms: msSince(t0) };
  }

  /**
   * Recall order for retrieval: relevance × importance × forgetting.
   *   relevance  = the similarity (a negative cosine counts as 0);
   *   importance = 1 + the file's importance, so 1..2;
   *   forgetting = 0.5^(age / halfLifeDays), age = now − last update, in days:
   *                exponential in how long the file has gone untouched —
   *                except at importance 1, which pins the file: no forgetting.
   *                (Seeded canon memories keep their real, old dates and must
   *                stay reachable; importance 1 is the signal for that.)
   */
  private weigh(x: { record: MemoryRecord; similarity: number }, meta: FileMeta | undefined): RecallItem {
    const importance = meta?.importance ?? DEFAULT_IMPORTANCE;
    const ageDays = Math.max(0, this.now() - (meta?.updatedAt ?? this.now())) / 86_400_000;
    const forgetting = importance >= 1 ? 1 : Math.pow(0.5, ageDays / Math.max(1e-6, this.opts.halfLifeDays));
    return { ...x, importance, forgetting, rank: Math.max(0, x.similarity) * (1 + importance) * forgetting };
  }

  /**
   * One judge request per file, in parallel: the same state (the statement),
   * the file as the question. Returns each file with its P(yes).
   */
  private async judgeEach(
    state: Record<string, unknown>,
    items: { record: MemoryRecord; similarity: number }[],
    question: string,
    criteria: { true: string; false: string },
    signal?: AbortSignal,
    opts: { name?: string; chars?: number; times?: boolean } = {},
  ): Promise<{ record: MemoryRecord; similarity: number; p: number }[]> {
    const name = opts.name ?? "relevant";
    return Promise.all(
      items.map(async ({ record, similarity }) => {
        const ans = await this.judge.ask(
          state,
          { [name]: { type: "noul", instructions: { question, memory: this.fileView(record, opts.chars, opts.times) }, criteria } },
          signal,
        );
        const a = ans[name];
        return { record, similarity, p: a?.type === "noul" ? a.noul : 0 };
      }),
    );
  }

  /** The recall query: the current message, then the most recent turns that fit. */
  private recallQuery(msg: string, conversation: HistoryTurn[]): string {
    const parts = [msg];
    let used = msg.length;
    for (let i = conversation.length - 1; i >= 0; i--) {
      const t = conversation[i].text;
      if (used + t.length > this.opts.queryChars) break;
      used += t.length;
      parts.push(t);
    }
    return truncate(parts.join("\n"), this.opts.queryChars);
  }

  /** Most recent turns that fit the budget; the earliest are dropped first. */
  private fitHistory(history: HistoryTurn[]): HistoryTurn[] {
    const out: HistoryTurn[] = [];
    let used = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const text = truncate(history[i].text.trim(), 2000);
      if (!text) continue;
      if (used + text.length > this.opts.historyChars) break;
      used += text.length;
      out.unshift({ role: history[i].role, text });
    }
    return out;
  }

  /**
   * A file as the judge sees it, within `chars` (default `fileChars`) all told: index
   * entry, latest time, and the newest entries that fit (writes append, so a
   * head cut would drop exactly the newest).
   */
  private fileView(r: MemoryRecord, chars = this.opts.fileChars, times = false): Record<string, unknown> {
    const summary = clipText(r.summary, Math.floor(chars / 3));
    // `times` (ingest's related judge): every write time, local with weekday,
    // newest WRITE_TIMES of them — the retrieval view keeps latest_time as it was.
    const when = times
      ? { written_at: r.times.slice(-WRITE_TIMES).map(localMoment) }
      : { latest_time: r.times.at(-1) ?? "" };
    const head = { uri: r.uri, scope: r.scope, type: r.type, topic: r.topic, summary, ...when, times_written: r.times.length };
    const room = chars - JSON.stringify(head).length - 40;
    const { text, omitted } = recentEntries(r.body, Math.max(0, room));
    return { ...head, ...(omitted ? { older_entries_omitted: omitted } : {}), content: text };
  }

  // ------------------------------------------------------------ answer (harness only)

  async answer(question: string, evidence: string, signal?: AbortSignal): Promise<string> {
    const res = await this.llm.chat(
      [
        { role: "system", content: `你是一个带长期记忆的助手。\n\n${ANSWER_RULES}\n\n直接回答，简洁。` },
        { role: "user", content: `【记忆检索结果】\n${evidence}\n\n【用户的问题】${question}` },
      ],
      { temperature: 0.2, maxTokens: 1500, signal },
    );
    return res.content.trim();
  }
}

type RecallItem = { record: MemoryRecord; similarity: number; rank: number; importance: number; forgetting: number };
type Candidate = RecallItem & { source: CandidateSource };

/** Ingest: how many of the session's recent segments' files count as "recent" candidates. */
const RECENT_SEGMENTS = 3;

/** Ingest's related judge: how many of a file's newest write times it is shown. */
const WRITE_TIMES = 8;

type WriteInput = Parameters<MemoryStore["write"]>[0];
interface WriteStep { key: string; action: IngestAction; write?: WriteInput; importance?: number }
interface WritePlan { targets: string[]; options: IngestResult["options"]; steps: WriteStep[] }

/**
 * Validate the ENTIRE writer response before a durable plan can execute any
 * action. `{"files": [...]}`, one entry per file written:
 *   append / edit — `uri` must be one of the related files, character for
 *                   character, at most once each; append gives `add`, edit the
 *                   whole `body`. A related file the writer leaves out is untouched.
 *   new           — `uri` must be a legal new uri of this side:
 *                   `<side>/<principle|event>/<name>`, the name already in slug
 *                   form, at most once. A name the side already has is handled
 *                   by the caller (takenFiles / foldTaken), never suffixed.
 * `{"files": []}` is the writer's "nothing new": valid only when related files
 * were shown (they already hold the segment); with none, what passed the gate
 * has nowhere else to go, so an empty list is sent back.
 */
function prepareWrites(out: Record<string, unknown>, targets: WriteTarget[], side: MemoryScope, time: string | undefined, allowNew: boolean): WriteStep[] {
  const s = (v: unknown) => typeof v === "string" ? v.trim() : "";
  const lines = (v: unknown) => Array.isArray(v) ? v.map(s).filter(Boolean).join("\n") : s(v);
  const steps: WriteStep[] = [];
  const fail = (op: IngestAction["op"], error: string, uri?: string) => steps.push({ key: `error:${steps.length}`, action: { op, ok: false, error, ...(uri ? { uri } : {}) } });
  const files: any[] = Array.isArray(out.files) ? out.files : [];
  if (!Array.isArray(out.files)) fail("skip", `the reply needs a "files" list`);
  const done = new Set<string>();
  const newUris = new Set<string>();
  let news = 0;
  for (const f of files) {
    const mode = s(f?.mode);
    const uri = s(f?.uri);
    if (mode === "append" || mode === "edit") {
      const t = targets.find((x) => x.rec.uri === uri);
      if (!t) { fail("update", `${mode} uri is not one of the related files given: ${uri || "(empty)"}`); continue; }
      if (done.has(uri)) { fail("update", `${uri} appears more than once`, uri); continue; }
      done.add(uri);
      const body = mode === "edit" ? lines(f.body) : lines(f.add) || lines(f.body);
      if (!body) { fail("update", `${mode} of ${uri} has nothing to write (${mode === "edit" ? "body" : "add"})`, uri); continue; }
      steps.push({ key: `update:${uri}`, action: { op: "update", uri, ok: true, reason: mode },
        importance: clampImportance(f.importance, t.importance),
        write: { uri, mode: mode === "edit" ? "replace" : "append", expectedFingerprint: fingerprint(t.rec),
          type: t.rec.type, topic: s(f.topic) || t.rec.topic, summary: s(f.summary), body, time } });
    } else if (mode === "new") {
      if (!allowNew) { fail("new", "only the given file may be updated here; no new file"); continue; }
      if (++news > 3) { fail("new", "at most 3 new files per side"); continue; }
      const m = /^([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
      if (!m || m[1] !== side || !isMemoryType(m[2]) || !m[3] || slug(m[3]) !== m[3]) {
        fail("new", `illegal new uri "${uri}": must be ${side}/principle/<name> or ${side}/event/<name>, the name only letters, digits and _`);
        continue;
      }
      if (newUris.has(uri)) { fail("new", `${uri} appears more than once`, uri); continue; }
      newUris.add(uri);
      const body = lines(f.body);
      if (!s(f.topic) || !s(f.summary) || !body) { fail("new", `new ${uri} needs topic, summary, body`, uri); continue; }
      steps.push({ key: `new:${steps.length}`, action: { op: "new", ok: true, reason: uri },
        write: { mode: "create", uri, scope: side, type: m[2], topic: s(f.topic), summary: s(f.summary), body, time } });
    } else {
      fail("skip", `unknown mode "${mode}": use append, edit or new${uri ? ` (${uri})` : ""}`, uri || undefined);
    }
  }
  if (Array.isArray(out.files) && !steps.length && !targets.length)
    fail("skip", "the files list is empty, but no related file was given: write what is worth remembering as new files");
  return steps;
}

function nothingNew(): IngestAction {
  return { op: "skip", ok: true, reason: NOTHING_NEW };
}

/** Last path segment of a uri: the file's name. */
function fileName(uri: string): string {
  return uri.slice(uri.lastIndexOf("/") + 1);
}

/**
 * `new` steps that name a file this side already has: the same name (either
 * type), or a topic that slugs to an existing file's name or topic. Each with
 * the existing file it collides with.
 */
function takenFiles(steps: WriteStep[], all: MemoryRecord[], side: MemoryScope): { proposed: string; rec: MemoryRecord }[] {
  const out: { proposed: string; rec: MemoryRecord }[] = [];
  for (const step of steps) {
    if (step.action.op !== "new" || !step.write?.uri) continue;
    const names = titleKeys(fileName(step.write.uri), step.write.topic);
    const rec = all.find((r) => r.scope === side && [...titleKeys(fileName(r.uri), r.topic)].some((k) => names.has(k)));
    if (rec) out.push({ proposed: step.write.uri, rec });
  }
  return out;
}

/**
 * The names a title collides by: the file name and the topic's slug, and the
 * same two with their time words taken out. Titles no longer carry time, but
 * stores written before do (`周日六分街看片约定`), and a writer may still slip
 * one in: the time-free 「六分街看片约定」 must collide with
 * 「周日六分街看片约定」, and two time-free titles collide as before. A key of
 * fewer than two characters left after stripping (「九点见」 → 「见」) is too
 * generic to collide by.
 */
function titleKeys(name: string, topic: string): Set<string> {
  const keys = new Set([name, slug(topic)]);
  for (const t of [name, topic]) {
    const k = slug(withoutTimeWords(t));
    if (k !== "misc" && [...k].length >= 2) keys.add(k);
  }
  return keys;
}

/**
 * Titles of the writer's steps that carry time words: a `new` file's name or
 * topic, an update's topic when the writer changed it. After the one
 * corrective round such a title is KEPT, with a `title_time` trace event —
 * not stripped: the complaint names the words, so a writer that still keeps
 * them almost always has a proper name the rule misreads (a film 「第九夜」, a
 * shop 「24点便利店」), and cutting a token out of a name can leave a wrong or
 * empty title (「九点见」 → 「见」) or a fresh slug collision after the
 * collision check already ran. A title with time costs dedupe quality; a
 * mangled title costs correctness.
 */
function titleTimes(steps: WriteStep[], targets: WriteTarget[]): { uri: string; title: string; words: string[] }[] {
  const out: { uri: string; title: string; words: string[] }[] = [];
  for (const st of steps) {
    const w = st.write;
    if (!w?.uri) continue;
    const titles = st.action.op === "new" ? [fileName(w.uri), w.topic] : w.topic && w.topic !== targets.find((t) => t.rec.uri === w.uri)?.rec.topic ? [w.topic] : [];
    for (const title of new Set(titles)) {
      const words = timeWordsIn(title);
      if (words.length) out.push({ uri: w.uri, title, words });
    }
  }
  return out;
}

/** All of the writer's soft complaints: titles always, entry dates when the segment's time is known. */
function writerComplaints(steps: WriteStep[], targets: WriteTarget[], dated: boolean): string[] {
  const titles = titleTimes(steps, targets).map(
    (t) =>
      `${t.uri} 的${t.title === fileName(t.uri) ? "文件名" : " topic"}「${t.title}」带了时间「${t.words.join("」「")}」——topic 和文件名只写这件事是什么（人、物、地点、活动），` +
      "时间写进条目和 summary；换一个不含日期、星期、钟点、相对时间的名字（例如「周日见约定」→「六分街看片之约」）",
  );
  return [...titles, ...(dated ? dateComplaints(steps, targets) : [])];
}

/**
 * After the writer was re-asked: a `new` that still names an existing file's
 * exact uri (the only case the store cannot create) is appended to that file
 * — merged into the writer's own update of it when there is one. Its summary
 * covers only the new lines, so the file keeps its own. A topic-only match
 * stays a new file: the writer saw the file and chose another name.
 */
function foldTaken(steps: WriteStep[], targets: WriteTarget[]): WriteStep[] {
  const out: WriteStep[] = [];
  for (const step of steps) {
    const t = step.action.op === "new" ? targets.find((x) => x.rec.uri === step.write?.uri) : undefined;
    if (!t) { out.push(step); continue; }
    const own = steps.find((s) => s.action.op === "update" && s.write?.uri === t.rec.uri);
    if (own) {
      own.write = { ...own.write!, body: `${own.write!.body}\n${step.write!.body}` };
      continue;
    }
    out.push({ key: `update:${t.rec.uri}`, action: { op: "update", uri: t.rec.uri, ok: true, reason: "append (new uri taken)" }, importance: t.importance,
      write: { uri: t.rec.uri, mode: "append", expectedFingerprint: fingerprint(t.rec), type: t.rec.type, topic: "", summary: "", body: step.write!.body, time: step.write!.time } });
  }
  return out;
}

/**
 * The writer post-check for time: every NEW entry line (append: the added
 * lines; edit: lines not in the old body; new: all) that carries relative
 * time words (明天 / 周六 / 下周 …) but no absolute date is a complaint, and
 * so is a dated line whose date lacks its weekday or names the wrong one
 * (「2026-11-08 看片」). Old lines are left alone — the writer cannot know what
 * day they meant.
 */
/** Only a segment with a known time can be converted to absolute dates (else no complaint). */
function datable(turns: SegmentTurn[]): boolean {
  return turns.some((t) => turnMoment(t.user, t.time));
}

/**
 * When a segment was said, for Jev's ingest state: 「2026-11-02（周一） 05:12」,
 * or 「… 05:12 至 2026-11-02（周一） 05:17」 when its turns span time; null when
 * no turn has a known time.
 */
export function segmentSpan(turns: SegmentTurn[]): string | null {
  const ms = turns.map((t) => turnMoment(t.user, t.time)).filter((m): m is NonNullable<typeof m> => Boolean(m));
  if (!ms.length) return null;
  const first = describeMoment(ms[0]);
  const last = describeMoment(ms[ms.length - 1]);
  return first === last ? first : `${first} 至 ${last}`;
}

function dateComplaints(steps: WriteStep[], targets: WriteTarget[]): string[] {
  const out: string[] = [];
  for (const st of steps) {
    const w = st.write;
    if (!w) continue;
    const old = w.mode === "replace" ? new Set((targets.find((t) => t.rec.uri === w.uri)?.rec.body ?? "").split("\n").map((l) => l.trim())) : new Set<string>();
    for (const line of w.body.split("\n").map((l) => l.trim()).filter(Boolean)) {
      if (old.has(line)) continue;
      const words = relativeWithoutDate(line);
      if (words.length) {
        out.push(`${w.uri} 的条目只有相对时间「${words.join("」「")}」、没有绝对日期：${truncate(line, 120)} —— 按【时间怎么写】换算成「YYYY-MM-DD（周X）」（以那句话说出的时间或【现在】为准）`);
        continue;
      }
      const days = weekdayProblems(line);
      if (days.length) out.push(`${w.uri} 的条目里${days.join("；")}：${truncate(line, 120)} —— 日期后面紧跟星期写成「YYYY-MM-DD（周X）」，对话里给了钟点就再接上「HH:MM」`);
    }
  }
  return out;
}

/**
 * Files of `all` whose topic/summary share key terms with `query` (BM25),
 * best first. Key terms: a shared token of at least two characters (a CJK
 * bigram or a word) — single CJK characters alone match nearly every file.
 */
function lexicalMatches(all: MemoryRecord[], query: string): string[] {
  const q = new Set(tokenize(query).filter((t) => t.length >= 2));
  if (!q.size) return [];
  return bm25Rank(all.map((r) => ({ item: r, text: `${r.topic} ${r.summary}` })), query)
    .filter((x) => x.score > 0 && tokenize(`${x.item.topic} ${x.item.summary}`).some((t) => t.length >= 2 && q.has(t)))
    .map((x) => x.item.uri);
}

/** A turn whose reply has no recall markup the model wrote itself (neither memory nor its words). */
function withoutRecallMarkup(t: SegmentTurn): SegmentTurn {
  if (!t.assistant?.includes("memkit-recall")) return t;
  const { assistant, ...rest } = t;
  const text = stripRecallMarkup(assistant).text;
  return text ? { ...rest, assistant: text } : rest;
}

/** Recent pairs, in conversation order; both speakers receive a fair share of the budget. */
export function segmentQuery(turns: SegmentTurn[], budget: number): string {
  const pairs: string[] = [];
  let left = Math.max(0, Math.floor(budget));
  for (let i = turns.length - 1; i >= 0 && left > 12; i--) {
    const t = turns[i];
    const labelCost = t.assistant ? 20 : 7;
    const room = Math.max(0, left - labelCost);
    const userRoom = t.assistant ? Math.min(t.user.length, Math.floor(room / 2)) : room;
    const u = balancedClip(t.user, userRoom);
    const a = t.assistant ? balancedClip(t.assistant, room - u.length) : "";
    const pair = `User: ${u}${a ? `\nAssistant: ${a}` : ""}`;
    pairs.unshift(pair);
    left -= pair.length + 1;
  }
  return pairs.join("\n").slice(0, budget);
}

/** Preserve late corrections/promises as well as the opening context. */
function balancedClip(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget < 5) return text.slice(0, Math.max(0, budget));
  const head = Math.floor((budget - 3) / 2);
  return `${text.slice(0, head)}\n…\n${text.slice(-(budget - head - 3))}`;
}

/**
 * Serialize one session's boundaries. Different sessions may call models in
 * parallel; MetaStore.exclusive protects only their brief shared write-backs.
 */
function sessionLock<T>(root: string, session: string, fn: () => Promise<T>): Promise<T> {
  const k = Symbol.for("memkit.sessionLocks.v1");
  const locks: Map<string, Promise<unknown>> = ((globalThis as any)[k] ??= new Map());
  const key = JSON.stringify([root, session]);
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

function captureSignal(timing?: AbortSignal | CaptureOptions): AbortSignal | undefined {
  if (!timing || timing instanceof AbortSignal) return timing;
  if (timing.timeoutMs === undefined) return timing.signal;
  const timeout = AbortSignal.timeout(Math.max(0, Math.floor(timing.timeoutMs)));
  return timing.signal ? AbortSignal.any([timing.signal, timeout]) : timeout;
}

/**
 * Is a stored boundary decision the one for this turn? By run id once a run
 * claimed it; before that (made at context assembly, which knows only the
 * prompt) by the prompt text, within a short window — the host may wrap the
 * prompt (a timestamp, a channel prefix), so containment either way counts.
 */
function samePrompt(d: { turn: string; prompt: string; at: number }, user: string, id: string | undefined, now: number): boolean {
  if (id && d.turn === id) return true;
  if (d.turn) return false;
  const p = d.prompt.trim();
  const u = user.trim();
  if (!p || !u) return false;
  if (now - d.at > 10 * 60_000) return false;
  return p === u || p.includes(u) || u.includes(p);
}

/** Characters of a run of turns (what the segment cap counts). */
function turnsChars(turns: SegmentTurn[]): number {
  return turns.reduce((n, t) => n + t.user.length + (t.assistant?.length ?? 0), 0);
}

/** Jev's scope answer as one of the four options; `fallback` when it is missing or unknown. */
function scopeOf(a: Answer | undefined, fallback: ScopeChoice): ScopeChoice {
  const c = a?.type === "choice" ? a.choice : "";
  return c === "user" || c === "assistant" || c === "both" || c === "empty" ? c : fallback;
}

function round3(x: number): number {
  return Number(x.toFixed(3));
}
