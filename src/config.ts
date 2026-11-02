// Resolves plugin config + environment into a ready engine.
//
// Secrets come from the environment by default (OpenClaw loads the state
// dir's .env into the gateway process): DEEPSEEK_API_KEY for the generative
// model, JEV_API_KEY (or TypeSafe's own TYPESAFE_API_KEY) for the judge, and
// the BGE embedding service's token — inline (MEMKIT_EMBED_API_KEY) or, by
// default, read from the file the deployment keeps it in, so the secret never
// has to be copied into config.

import { appendFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { MemoryEngine, DEFAULT_OPTIONS } from "./engine.ts";
import type { EngineOptions } from "./engine.ts";
import { BgeEmbedder, readToken } from "./embed.ts";
import type { Embedder } from "./embed.ts";
import { JevJudge, LlmJudge } from "./judge.ts";
import type { Judge } from "./judge.ts";
import { OpenAICompatLlm } from "./llm.ts";
import type { Llm } from "./llm.ts";
import type { PersonaConfig } from "./persona.ts";
import { MemoryStore } from "./store.ts";
import type { TraceSink } from "./types.ts";

export interface MemkitConfig {
  /** Store root. Default: <agent workspace>/memkit. */
  rootDir?: string;
  llm?: { baseUrl?: string; apiKey?: string; model?: string; timeoutMs?: number; reasoningEffort?: string };
  judge?: {
    /** "auto" = Jev when a key is present, else the LLM emulation. */
    backend?: "auto" | "jev" | "llm";
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    timeoutMs?: number;
  };
  /** Dense recall (BGE-M3, OpenAI-compatible /v1/embeddings). Off → BM25 recall. */
  embed?: {
    enabled?: boolean;
    baseUrl?: string;
    apiKey?: string;
    /** File holding the token (optional). */
    apiKeyFile?: string;
    model?: string;
    timeoutMs?: number;
    /** Characters kept per embedded input (BGE-M3 stops at 8,192 tokens). */
    maxChars?: number;
  };
  retrieve?: Partial<Pick<EngineOptions, "recallGate" | "recallAt" | "timeAware" | "timeAt" | "timeFiles" | "queryRewrite" | "recall" | "halfLifeDays" | "k" | "minScore" | "historyChars" | "messageChars" | "queryChars" | "fileChars" | "evidenceChars" | "retrieval">>;
  ingest?: Partial<Pick<EngineOptions, "gateAt" | "ingestCandidates" | "extraCandidates" | "relatedAt" | "writeFiles" | "topicShiftAt" | "segmentChars" | "tailTurns" | "jevChars" | "maxAttempts">>;
  /**
   * "answer-only" (default): the main agent gets a minimal answering system
   * prompt and no tools; "host": keep the host's prompt and tools, only append
   * the memory rules.
   */
  mainAgent?: "answer-only" | "host";
  /**
   * Replaces the default answer-only system prompt (memory rules are always
   * appended). A readable `persona.file` takes precedence over it.
   */
  answerPrompt?: string;
  /**
   * Role-play persona (see src/persona.ts): `file` is a markdown card,
   * absolute, `~/…` or relative to the OpenClaw state dir, re-read when it
   * changes; `rules` picks the memory rules appended after it ("auto": role-play
   * rules when the persona file is in effect, else the assistant rules).
   */
  persona?: PersonaConfig;
  /** Auto-recall before each turn (default true). */
  autoRecall?: boolean;
  /** Auto-capture after each turn (default true). */
  autoCapture?: boolean;
  recallTimeoutMs?: number;
  captureTimeoutMs?: number;
  /** Record a session's unrecorded turns after this many quiet minutes (default 20; 0 = off). */
  idleFlushMinutes?: number;
  /** Write a JSONL decision trace next to the store (default true). */
  trace?: boolean;
}

export function resolveLlm(cfg: MemkitConfig, env: NodeJS.ProcessEnv = process.env): Llm {
  return new OpenAICompatLlm({
    baseUrl: cfg.llm?.baseUrl ?? env.MEMKIT_LLM_BASE_URL ?? "https://api.deepseek.com",
    apiKey: cfg.llm?.apiKey ?? env.MEMKIT_LLM_API_KEY ?? env.DEEPSEEK_API_KEY ?? "",
    model: cfg.llm?.model ?? env.MEMKIT_LLM_MODEL ?? "deepseek-flash",
    timeoutMs: cfg.llm?.timeoutMs,
    reasoningEffort: cfg.llm?.reasoningEffort ?? env.MEMKIT_LLM_REASONING_EFFORT ?? "low",
  });
}

export function resolveJudge(cfg: MemkitConfig, llm: Llm, env: NodeJS.ProcessEnv = process.env): Judge {
  const key = cfg.judge?.apiKey ?? env.JEV_API_KEY ?? env.TYPESAFE_API_KEY ?? "";
  const backend = cfg.judge?.backend ?? (env.MEMKIT_JUDGE as "auto" | "jev" | "llm" | undefined) ?? "auto";
  if (backend === "jev" || (backend === "auto" && key)) {
    if (!key) throw new Error("judge backend 'jev' needs JEV_API_KEY (or judge.apiKey)");
    return new JevJudge({
      apiKey: key,
      baseUrl: cfg.judge?.baseUrl ?? env.JEV_BASE_URL,
      model: cfg.judge?.model ?? env.JEV_MODEL ?? "jev-latest",
      timeoutMs: cfg.judge?.timeoutMs,
    });
  }
  return new LlmJudge(llm);
}

export function resolveEmbedder(cfg: MemkitConfig, env: NodeJS.ProcessEnv = process.env): Embedder | null {
  const e = cfg.embed ?? {};
  if (e.enabled === false || env.MEMKIT_EMBED === "off") return null;
  const apiKey = readToken(e.apiKey ?? env.MEMKIT_EMBED_API_KEY, e.apiKeyFile ?? env.MEMKIT_EMBED_API_KEY_FILE);
  const baseUrl = e.baseUrl ?? env.MEMKIT_EMBED_BASE_URL;
  if (!apiKey && !baseUrl) return null; // no embedding service configured → BM25 recall
  return new BgeEmbedder({
    baseUrl: baseUrl ?? "http://127.0.0.1:8000",
    apiKey,
    model: e.model ?? env.MEMKIT_EMBED_MODEL ?? "bge-m3",
    timeoutMs: e.timeoutMs,
    maxChars: e.maxChars,
  });
}

export function jsonlTrace(file: string): TraceSink {
  let ready = false;
  return (ev) => {
    if (!ready) {
      mkdirSync(path.dirname(file), { recursive: true });
      ready = true;
    }
    appendFileSync(file, JSON.stringify(ev) + "\n");
  };
}

export function buildEngine(
  rootDir: string,
  cfg: MemkitConfig = {},
  overrides: { llm?: Llm; judge?: Judge; embedder?: Embedder | null; trace?: TraceSink; env?: NodeJS.ProcessEnv } = {},
): MemoryEngine {
  const env = overrides.env ?? process.env;
  const llm = overrides.llm ?? resolveLlm(cfg, env);
  const judge = overrides.judge ?? resolveJudge(cfg, llm, env);
  const embedder = overrides.embedder !== undefined ? overrides.embedder : resolveEmbedder(cfg, env);
  const trace = overrides.trace ?? (cfg.trace === false ? undefined : jsonlTrace(path.join(rootDir, ".trace.jsonl")));
  return new MemoryEngine({
    store: new MemoryStore(rootDir),
    judge,
    llm,
    embedder,
    trace,
    opts: { ...DEFAULT_OPTIONS, ...(cfg.retrieve ?? {}), ...(cfg.ingest ?? {}) },
  });
}
