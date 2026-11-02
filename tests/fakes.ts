// Scripted stand-ins for the judge and the LLM, so the pipeline's control flow
// can be tested offline and deterministically.

import type { Embedder } from "../src/embed.ts";
import type { Answer, Judge, Question } from "../src/judge.ts";
import type { ChatMessage, ChatResult, Llm } from "../src/llm.ts";
import { slug, tokenize } from "../src/text.ts";

/** Noul = token overlap between the state and the file in the question (ingest "related", retrieve "relevant"). */
export class OverlapJudge implements Judge {
  readonly name = "overlap";
  calls: { state: unknown; questions: Record<string, Question> }[] = [];

  async ask(state: unknown, questions: Record<string, Question>): Promise<Record<string, Answer>> {
    this.calls.push({ state, questions });
    // The retrieval background is shared boilerplate; score against the rest.
    const { background: _bg, ...rest } = (state ?? {}) as Record<string, unknown>;
    const stateToks = new Set(tokenize(JSON.stringify(rest)));
    const overlap = (s: string) => {
      const t = tokenize(s);
      return t.length ? t.filter((x) => stateToks.has(x)).length / t.length : 0;
    };
    const out: Record<string, Answer> = {};
    for (const [name, q] of Object.entries(questions)) {
      if (q.type === "noul") {
        const mem = (q.instructions as any)?.memory;
        if (name === "worth_storing") out[name] = { type: "noul", noul: /好的|谢谢|哈哈/.test(userLines(state)) ? 0.1 : 0.9 };
        // Small talk needs no recall; anything else does.
        else if (name === "need_recall") out[name] = { type: "noul", noul: /^(好的|谢谢|哈哈|你好)/.test(String((state as any)?.current_message ?? "")) ? 0.1 : 0.9 };
        else if (name === "topic_shift") {
          // Shifted when the current message shares no token with the pending turns.
          const st = state as any;
          const before = new Set(tokenize(JSON.stringify(st?.since_last_record ?? [])));
          const cur = tokenize(String(st?.current_user_message ?? ""));
          out[name] = { type: "noul", noul: cur.some((x) => before.has(x) && x.length > 1) ? 0.1 : 0.9 };
        }
        else out[name] = { type: "noul", noul: mem ? Math.min(1, overlap(`${mem.topic} ${mem.summary}`) * 2) : 0 };
      } else if (name === "scope") {
        // Whose memory: "empty" for small talk, else the user's.
        const choice = /好的|谢谢|哈哈/.test(userLines(state)) ? "empty" : "user";
        out[name] = { type: "choice", choice, probabilities: { [choice]: 0.9 } };
      }
    }
    return out;
  }
}

/** The user's lines of a Jev state (segment `conversation`, or a retrieval `current_message`). */
function userLines(state: unknown): string {
  const st = (state ?? {}) as any;
  const turns = Array.isArray(st.conversation) ? st.conversation : [];
  return [...turns.filter((t: any) => t?.role === "user").map((t: any) => t.text), st.current_message ?? ""].join("\n");
}

/** Replays a queue of scripted chat results and records what it was sent. */
export class ScriptedLlm implements Llm {
  readonly model = "scripted";
  queue: ChatResult[] = [];
  seen: ChatMessage[][] = [];
  /** Tool names offered on each call. */
  tools: string[][] = [];

  push(r: Partial<ChatResult>): this {
    this.queue.push({ content: "", toolCalls: [], ...r });
    return this;
  }

  async chat(messages: ChatMessage[], opts?: { tools?: { function: { name: string } }[] }): Promise<ChatResult> {
    this.seen.push(messages);
    this.tools.push((opts?.tools ?? []).map((t) => t.function.name));
    const r = this.queue.shift() as (ChatResult & { resolve?: (m: ChatMessage[]) => string }) | undefined;
    if (r?.resolve) return { content: r.resolve(messages), toolCalls: [] };
    return r ?? { content: '{"done": true}', toolCalls: [] };
  }
}

export function call(name: string, args: Record<string, unknown>) {
  return { id: `c_${name}`, name, args };
}

/**
 * A writer reply, `{"files": [...]}`, resolved against the prompt it answers:
 * `updates` keys A, B, … are 文件 1, 2, … of that prompt (mode defaults to
 * append; any other key is sent as the uri itself), `new` entries get the
 * uri <side>/<type>/<slug(topic)>, and `files` entries go through as they are.
 */
export function writes(w: { updates?: Record<string, Record<string, unknown>>; new?: Record<string, unknown>[]; files?: Record<string, unknown>[] }) {
  const resolve = (messages: ChatMessage[]) => {
    const prompt = String(messages.find((m) => m.role === "user")?.content ?? "");
    const uris = [...prompt.matchAll(/^  uri：(\S+)$/gm)].map((m) => m[1]);
    const side = /新文件的 uri 以 (\w+)\//.exec(prompt)?.[1] ?? "user";
    const files: Record<string, unknown>[] = [...(w.files ?? [])];
    for (const [key, u] of Object.entries(w.updates ?? {})) {
      const i = /^[A-Z]$/.test(key) ? key.charCodeAt(0) - 65 : -1;
      files.push({ mode: "append", ...u, uri: i >= 0 ? (uris[i] ?? `missing-${key}`) : key });
    }
    for (const { type, ...n } of w.new ?? []) files.push({ mode: "new", uri: `${side}/${type}/${slug(String(n.topic ?? ""))}`, ...n });
    return JSON.stringify({ files });
  };
  return { content: "", resolve };
}

/** A judge whose answers are fixed per question name (noul p, or choice probabilities). */
export class FixedJudge implements Judge {
  readonly name = "fixed";
  calls: { state: unknown; questions: Record<string, Question> }[] = [];
  private answers: { worth?: number; related?: number | Record<string, number>; scope?: string; needRecall?: number; timeRelated?: number };
  /**
   * related: the ingest P(related) — one number for every file, or per uri
   * (others 0.9). scope: whose memory at ingest (default user). needRecall:
   * the retrieve gate (default 0.9). timeRelated: the gate's second question
   * (default 0.1: the plain recall path).
   */
  constructor(answers: { worth?: number; related?: number | Record<string, number>; scope?: string; needRecall?: number; timeRelated?: number }) {
    this.answers = answers;
  }
  async ask(state: unknown, questions: Record<string, Question>): Promise<Record<string, Answer>> {
    this.calls.push({ state, questions });
    const out: Record<string, Answer> = {};
    for (const [name, q] of Object.entries(questions)) {
      if (q.type === "noul") {
        const r = this.answers.related;
        const uri = String((q.instructions as any)?.memory?.uri ?? "");
        const p = name === "worth_storing" ? (this.answers.worth ?? 0.9)
          : name === "related" ? (typeof r === "number" ? r : r?.[uri] ?? 0.9)
          : name === "need_recall" ? (this.answers.needRecall ?? 0.9)
          : name === "time_related" ? (this.answers.timeRelated ?? 0.1)
          : 0.9;
        out[name] = { type: "noul", noul: p };
      } else if (name === "scope") {
        const choice = this.answers.scope ?? "user";
        out[name] = { type: "choice", choice, probabilities: { [choice]: 0.9 } };
      }
    }
    return out;
  }
}

/** Hashed bag-of-tokens vectors, L2-normalised: cosine ≈ token overlap. */
export class FakeEmbedder implements Embedder {
  readonly name = "fake-embed";
  /** Every input it was asked to embed, per call. */
  calls: string[][] = [];
  fail = false;

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push(texts);
    if (this.fail) throw new Error("HTTP 502 from bge");
    return texts.map((t) => {
      const v = new Float32Array(256);
      for (const tok of tokenize(t)) {
        let h = 0;
        for (const ch of tok) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
        v[h % 256] += 1;
      }
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  }
}
