// OpenAI-compatible chat client (DeepSeek by default). Used only for the
// GENERATIVE steps: writing memory text + summary at ingest, and composing the
// next-hop query at retrieve. Every yes/no or pick-one judgment goes to the
// discriminator instead (see judge.ts).

import { postJson } from "./http.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  content: string;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Sent as `reasoning_effort` when set; reasoning tokens count against max_tokens. */
  reasoningEffort?: string;
}

export interface Llm {
  readonly model: string;
  chat(
    messages: ChatMessage[],
    opts?: {
      tools?: ToolSpec[];
      toolChoice?: "auto" | "required" | "none";
      json?: boolean;
      temperature?: number;
      maxTokens?: number;
      signal?: AbortSignal;
    },
  ): Promise<ChatResult>;
}

export class OpenAICompatLlm implements Llm {
  readonly model: string;
  private cfg: LlmConfig;
  calls = 0;

  constructor(cfg: LlmConfig) {
    this.cfg = cfg;
    this.model = cfg.model;
  }

  async chat(messages: ChatMessage[], opts: Parameters<Llm["chat"]>[1] = {}): Promise<ChatResult> {
    if (!this.cfg.apiKey) throw new Error("LLM api key missing (set DEEPSEEK_API_KEY or plugin config llm.apiKey)");
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 2500,
      stream: false,
    };
    if (opts.tools?.length) {
      body.tools = opts.tools;
      body.tool_choice = opts.toolChoice ?? "auto";
    }
    if (opts.json) body.response_format = { type: "json_object" };
    if (this.cfg.reasoningEffort) body.reasoning_effort = this.cfg.reasoningEffort;
    this.calls++;
    const res = await postJson(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, body, {
      headers: { Authorization: `Bearer ${this.cfg.apiKey}` },
      timeoutMs: this.cfg.timeoutMs ?? 60000,
      signal: opts.signal,
    });
    const msg = res?.choices?.[0]?.message ?? {};
    const toolCalls = (msg.tool_calls ?? []).map((tc: ToolCall) => ({
      id: tc.id,
      name: tc.function?.name ?? "",
      args: parseArgs(tc.function?.arguments),
    }));
    return { content: String(msg.content ?? ""), toolCalls, usage: res?.usage };
  }
}

export function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** Pull the first JSON object out of model text (tolerates ``` fences and prose). */
export function extractJson(text: string): Record<string, unknown> | null {
  const s = (text || "").replace(/```(?:json)?/g, "");
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (s[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          start = -1;
        }
      }
    }
  }
  return null;
}
