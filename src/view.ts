// What a reader of a memory file sees when the file is longer than its budget.
//
// Writes append to the end of the body, so cutting a long file at its HEAD
// (as a plain truncation does) would drop exactly the newest entries — the
// ones a question is most likely about. Every bounded view of a file (the BGE
// input, the Jev question, the placement option, the evidence) is therefore
// "topic + current summary + the newest entries that fit", oldest of those
// first, with a note of how many older entries were left out.
//
// Budgets are in characters. They hold as token limits too: BGE-M3's
// tokenizer (XLM-R sentencepiece) never makes more tokens than characters, and
// the server's `truncated` list is checked anyway (embed.ts); Jev measured
// about 0.8 tokens per character on this memory text.

import type { MemoryRecord } from "./types.ts";

/** Body split into entries: each starts with "- " (continuation lines stay with it). */
export function entries(body: string): string[] {
  const t = (body ?? "").trim();
  if (!t) return [];
  return t.split(/\n(?=- )/).map((e) => e.trim()).filter(Boolean);
}

/** Cut a text to `max` characters, marking the cut. */
export function clipText(text: string, max: number): string {
  const t = (text ?? "").trim();
  if (max <= 0) return "";
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * The newest entries whose total fits `max` characters, oldest of them first.
 * When even the newest entry alone does not fit, its head is kept.
 */
export function recentEntries(body: string, max: number): { text: string; kept: number; omitted: number } {
  const all = entries(body);
  const kept: string[] = [];
  let used = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    const cost = e.length + (kept.length ? 1 : 0);
    if (used + cost > max) {
      if (!kept.length) kept.unshift(clipText(e, max));
      break;
    }
    kept.unshift(e);
    used += cost;
  }
  return { text: kept.join("\n"), kept: kept.length, omitted: all.length - kept.length };
}

/**
 * A file as plain text within `max` characters: topic, summary, newest
 * entries. The summary is kept whole unless it alone would use more than half
 * the budget.
 */
export function fileText(r: MemoryRecord, max: number): string {
  const head = [r.topic, clipText(r.summary, Math.floor(max / 2))].filter(Boolean).join("\n");
  const room = max - head.length - 1;
  if (room <= 0) return clipText(head, max);
  const { text, omitted } = recentEntries(r.body, omitted0(room));
  const note = omitted ? `（更早的 ${omitted} 条已省略）\n` : "";
  return [head, `${note}${text}`].filter(Boolean).join("\n").slice(0, max);
}

// Leave room for the "older entries omitted" note.
function omitted0(room: number): number {
  return Math.max(0, room - 16);
}
