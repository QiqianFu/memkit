// The answering model's system prompt: who it is (the persona) + how it uses
// memory (the rules). memkit stays generic — no character text lives here;
// a role-play character comes from a markdown file named in config.
//
// Persona text, in order of precedence (answer-only mode):
//   1. `persona.file` — read at startup and re-read whenever its mtime/size
//      changes (checked on every turn: one stat), so editing the card needs no
//      gateway restart. If the file later disappears or cannot be read, the
//      last good copy is kept (an editor's save-by-rename briefly removes it)
//      and a warning is logged once per distinct problem.
//   2. `answerPrompt` — inline text, also used while a configured file has
//      never been read successfully.
//   3. DEFAULT_ANSWER_PROMPT — the built-in generic assistant.
//
// Rules appended after it (`persona.rules`):
//   "auto" (default) — ROLEPLAY_RULES when the text in effect came from the
//                      persona file, else ANSWER_RULES; so a config without a
//                      persona file behaves exactly as before.
//   "roleplay" / "assistant" — forced (e.g. an inline answerPrompt that is a
//                      character, or a persona file used as a plain assistant).
// The recall-block wording follows the same choice (prompts.ts, RecallStyle).

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { ANSWER_RULES, DEFAULT_ANSWER_PROMPT, ROLEPLAY_RULES } from "./prompts.ts";
import type { RecallStyle } from "./prompts.ts";

export type PersonaRules = "auto" | "roleplay" | "assistant";

export interface PersonaConfig {
  /** Markdown persona card; absolute, `~/…`, or relative to the OpenClaw state dir. */
  file?: string;
  rules?: PersonaRules;
  /**
   * The character's hidden inner monologue (src/monologue.ts): `strip`
   * removes the tagged block from outbound channel messages ("auto" = when the
   * role-play rules are in effect); `open` / `close` are the block's tags.
   */
  monologue?: { strip?: "auto" | "always" | "never"; open?: string; close?: string };
  /**
   * Values for the card's `{{name}}` placeholders (e.g. the player's name),
   * so one card serves every deployment. An unfilled placeholder is left as
   * is and warned about once.
   */
  vars?: Record<string, string>;
}

/**
 * The card as the model should see it: HTML comments (deployment notes for
 * humans) removed, `{{name}}` placeholders filled from `vars`. Returns the
 * names of placeholders that had no value.
 */
export function renderPersona(text: string, vars: Record<string, string> = {}): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const out = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, name: string) => {
      if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
      missing.add(name);
      return m;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: out, missing: [...missing] };
}

type Log = { info?: (m: string) => void; warn?: (m: string) => void };

/** Where the persona text in effect came from. */
export type PersonaOrigin = "file" | "inline" | "default";

export interface AnswerPrompt {
  /** The full system prompt: persona text + "\n\n" + rules. */
  systemPrompt: string;
  /** The rules alone (what host mode appends to the host's prompt). */
  rules: string;
  style: RecallStyle;
  origin: PersonaOrigin;
}

/** `file` as an absolute path: absolute stays, `~/` is the home dir, anything else is under `stateDir`. */
export function resolvePersonaPath(file: string, stateDir: string): string {
  if (file === "~" || file.startsWith("~/")) return path.join(homedir(), file.slice(1));
  return path.isAbsolute(file) ? file : path.join(stateDir, file);
}

/** The system prompt for a persona text and a rules choice; no file access. */
export function composeAnswerPrompt(persona: { text?: string; origin: PersonaOrigin }, rules: PersonaRules = "auto"): AnswerPrompt {
  const text = persona.text?.trim() || DEFAULT_ANSWER_PROMPT;
  const origin = persona.text?.trim() ? persona.origin : "default";
  const style: RecallStyle = rules === "roleplay" || (rules === "auto" && origin === "file") ? "roleplay" : "assistant";
  const ruleText = style === "roleplay" ? ROLEPLAY_RULES : ANSWER_RULES;
  return { systemPrompt: `${text}\n\n${ruleText}`, rules: ruleText, style, origin };
}

/**
 * The persona source for one plugin registration. `current()` is cheap (a
 * stat per call; the file is only read when its mtime or size changed) and
 * never throws: any problem is a warning and a fallback.
 */
export class PersonaSource {
  private readonly file?: string;
  private readonly inline?: string;
  private readonly rules: PersonaRules;
  private readonly vars: Record<string, string>;
  private readonly log: Log;
  /** The last successfully read file text and the stat it was read at. */
  private loaded?: { text: string; mtimeMs: number; size: number };
  /** The last problem warned about, so a persisting one is logged once. */
  private problem = "";
  private cached?: { key: string; value: AnswerPrompt };

  constructor(opts: { file?: string; inline?: string; rules?: PersonaRules; vars?: Record<string, string>; log?: Log }) {
    this.file = opts.file;
    this.inline = opts.inline?.trim() || undefined;
    this.rules = opts.rules ?? "auto";
    this.vars = opts.vars ?? {};
    this.log = opts.log ?? console;
  }

  /** The answer prompt to use for this turn. */
  current(): AnswerPrompt {
    if (this.file) this.refresh(this.file);
    const persona = this.loaded
      ? { text: this.loaded.text, origin: "file" as const }
      : this.inline
        ? { text: this.inline, origin: "inline" as const }
        : { origin: "default" as const };
    // Same inputs → same object, so the system prompt string stays identical
    // (and the provider's prefix cache warm) until the persona really changes.
    const key = `${persona.origin}\0${this.loaded ? `${this.loaded.mtimeMs}:${this.loaded.size}` : ""}`;
    if (this.cached?.key !== key) this.cached = { key, value: composeAnswerPrompt(persona, this.rules) };
    return this.cached.value;
  }

  private refresh(file: string): void {
    let st: { mtimeMs: number; size: number; isFile(): boolean };
    try {
      st = statSync(file);
    } catch (e) {
      return this.warn(`cannot stat persona file ${file} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
    }
    if (!st.isFile()) return this.warn(`persona file ${file} is not a regular file`);
    if (this.loaded && this.loaded.mtimeMs === st.mtimeMs && this.loaded.size === st.size) return;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8").replace(/^﻿/, "").trim();
    } catch (e) {
      return this.warn(`cannot read persona file ${file} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
    }
    const { text, missing } = renderPersona(raw, this.vars);
    if (!text) return this.warn(`persona file ${file} is empty`);
    const reloaded = Boolean(this.loaded);
    this.loaded = { text, mtimeMs: st.mtimeMs, size: st.size };
    this.problem = "";
    this.log.info?.(`memkit: persona ${reloaded ? "reloaded" : "loaded"} from ${file} (${text.length} chars)`);
    if (missing.length) this.log.warn?.(`memkit: persona file ${file} has unfilled placeholders: ${missing.map((m) => `{{${m}}}`).join(", ")} (set persona.vars)`);
  }

  private warn(problem: string): void {
    if (problem === this.problem) return;
    this.problem = problem;
    const fallback = this.loaded ? "keeping the last loaded persona" : this.inline ? "using answerPrompt" : "using the built-in answer prompt";
    this.log.warn?.(`memkit: ${problem}; ${fallback}`);
  }
}
