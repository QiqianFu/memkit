// The discriminator: every yes/no or pick-one judgment in the pipeline.
//
// Jev (TypeSafe System One) takes one `state` and any number of named typed
// questions, answers them in parallel in ONE request, and returns calibrated
// probabilities instead of generated text. That shape is why it replaces the
// embedding: "does memory i help answer this question?" for 30 candidates is
// a single request with 30 Noul questions over the same state.
//
// LlmJudge emulates the same contract with a chat model. It exists so the
// pipeline runs end-to-end before a Jev key is configured, and as a baseline
// to compare Jev against — not as the intended production path.

import { postJson } from "./http.ts";
import type { Llm } from "./llm.ts";
import { extractJson } from "./llm.ts";

export type Question =
  | { type: "noul"; instructions: unknown; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: unknown; criteria: Record<string, string> };

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence?: number };

export interface Judge {
  readonly name: string;
  ask(state: unknown, questions: Record<string, Question>, signal?: AbortSignal): Promise<Record<string, Answer>>;
}

export interface JevConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

export class JevJudge implements Judge {
  readonly name: string;
  private cfg: JevConfig;
  calls = 0;
  inputTokens = 0;

  constructor(cfg: JevConfig) {
    this.cfg = cfg;
    this.name = `jev:${cfg.model ?? "jev-latest"}`;
  }

  async ask(state: unknown, questions: Record<string, Question>, signal?: AbortSignal): Promise<Record<string, Answer>> {
    if (!Object.keys(questions).length) return {};
    this.calls++;
    const res = await postJson(
      `${(this.cfg.baseUrl ?? "https://api.typesafe.ai").replace(/\/$/, "")}/v1/systemone`,
      { model: this.cfg.model ?? "jev-latest", state, questions },
      { headers: { Authorization: `Bearer ${this.cfg.apiKey}` }, timeoutMs: this.cfg.timeoutMs ?? 20000, signal },
    );
    this.inputTokens += Number(res?.usage?.input_tokens ?? 0);
    const out: Record<string, Answer> = {};
    for (const [name, q] of Object.entries(questions)) {
      const a = res?.answers?.[name];
      if (!a) throw new Error(`jev response missing answer for ${name}`);
      if (q.type === "noul") out[name] = { type: "noul", noul: clamp01(Number(a.noul)) };
      else
        out[name] = {
          type: "choice",
          choice: String(a.choice),
          probabilities: a.probabilities ?? {},
          confidence: a.confidence ?? undefined,
        };
    }
    return out;
  }
}

/** Same contract, answered by a chat model asked for probabilities as JSON. */
export class LlmJudge implements Judge {
  readonly name: string;
  private llm: Llm;

  constructor(llm: Llm) {
    this.llm = llm;
    this.name = `llm-judge:${llm.model}`;
  }

  async ask(state: unknown, questions: Record<string, Question>, signal?: AbortSignal): Promise<Record<string, Answer>> {
    if (!Object.keys(questions).length) return {};
    const spec: Record<string, unknown> = {};
    for (const [name, q] of Object.entries(questions)) {
      spec[name] =
        q.type === "noul"
          ? { type: "yes/no", question: q.instructions, criteria: q.criteria }
          : { type: "pick exactly one option key", question: q.instructions, options: q.criteria };
    }
    const sys =
      "You are a strict discriminative classifier. Judge every question independently and only " +
      "against the given STATE. Reply with ONE JSON object keyed by question id. For a yes/no " +
      'question give {"p": <probability the answer is yes, 0..1>}. For a pick-one question give ' +
      '{"choice": "<option key>", "p": <probability that choice is right, 0..1>}. No other text.';
    const res = await this.llm.chat(
      [
        { role: "system", content: sys },
        { role: "user", content: JSON.stringify({ STATE: state, QUESTIONS: spec }) },
      ],
      { json: true, temperature: 0, maxTokens: 800 + 40 * Object.keys(questions).length, signal },
    );
    const parsed = extractJson(res.content) ?? {};
    const out: Record<string, Answer> = {};
    for (const [name, q] of Object.entries(questions)) {
      const a = (parsed[name] ?? {}) as Record<string, unknown>;
      if (q.type === "noul") {
        out[name] = { type: "noul", noul: clamp01(Number(a.p ?? 0)) };
      } else {
        const keys = Object.keys(q.criteria);
        const choice = keys.includes(String(a.choice)) ? String(a.choice) : keys[0];
        const p = clamp01(Number(a.p ?? 0.5));
        const probabilities: Record<string, number> = {};
        for (const k of keys) probabilities[k] = k === choice ? p : (1 - p) / Math.max(1, keys.length - 1);
        out[name] = { type: "choice", choice, probabilities, confidence: p };
      }
    }
    return out;
  }
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}
