// The character's hidden inner monologue (心声): the persona card asks the
// answering model to think as the character first — current mood, what it
// notices, what it wants, what it decides to say — inside a tagged block at
// the top of every reply, and only then write the visible reply. The block
// must never reach the player, but it is deliberately kept everywhere else:
// in the transcript (so the next turn's history carries the character's own
// mood) and in the model request logs (so the thinking can be inspected).
// Hence the split: `stripMonologue` rewrites only the outbound channel text
// (OpenClaw's `message_sending` hook, which the WeChat plugin runs before
// every send, including each streamed block); `before_message_write` leaves
// the monologue in the stored message; ingest sees it through `markMonologue`,
// which labels it as unspoken so the writer never records a thought as
// something the character said or promised.
//
// The tags are configurable because the card owns the markup; the defaults
// match personas/yuzuha/card.md. Matching tolerates what DeepSeek sometimes
// writes instead of the exact tag: full-width brackets, spaces inside the tag,
// `</ 心声>`.
//
// The same block rules strip memkit's own recall markup (`stripRecallMarkup`)
// from what the answering model WROTE. A 354-turn role-play run had the model
// write `<memkit-recall>…</memkit-recall>` blocks into its reply twice (once a
// wholly invented memory), imitating the injected evidence. Unlike the
// monologue, such a block is never kept as anything: it is not the
// character's words (outbound: always removed, whatever the role-play mode)
// and not memory (ingest: removed before Jev and the writer see the reply).

export interface MonologueTags {
  open: string;
  close: string;
}

export const DEFAULT_MONOLOGUE_TAGS: MonologueTags = { open: "<心声>", close: "</心声>" };

export interface StripResult {
  /** The visible text; "" when nothing but monologue was written. */
  text: string;
  /** How many complete blocks were removed. */
  blocks: number;
  /** A lone open tag (its paragraph was dropped) or a lone close tag (everything before it was dropped). */
  unterminated: boolean;
}

/** `<心声>` → a pattern that also accepts `＜ 心声 ＞`; `</心声>` → one that also accepts `＜/ 心声＞`. */
function tagPattern(tag: string): string {
  const m = /^([<＜])\s*(\/?)\s*(.+?)\s*([>＞])$/.exec(tag);
  if (!m) return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const name = m[3].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `[<＜]\\s*${m[2] ? "\\/\\s*" : ""}${name}\\s*[>＞]`;
}

/**
 * Removes every monologue block from `text`. A model that forgets a tag
 * would otherwise leak its thoughts, so a lone open tag drops everything from
 * the tag to the end of its paragraph (the first blank line; to the end when
 * there is none), and a lone close tag drops everything before it. Blank
 * lines left around a removed block are collapsed. Stream-safe: a block cut
 * into pieces at paragraph boundaries loses each piece by one of these rules.
 */
export function stripMonologue(text: string, tags: MonologueTags = DEFAULT_MONOLOGUE_TAGS): StripResult {
  return stripBlocks(text, tagPattern(tags.open), tagPattern(tags.close));
}

/** `<memkit-recall>` / `<memkit-recall id="…">` (any attributes), full-width brackets and spaces tolerated. */
const RECALL_OPEN_PATTERN = "[<＜]\\s*memkit-recall\\b[^>＞]*[>＞]";
const RECALL_CLOSE_PATTERN = "[<＜]\\s*\\/\\s*memkit-recall\\s*[>＞]";

/**
 * Removes memkit recall markup the answering model wrote itself: whole
 * blocks, and a lone tag by the same rules as a lone monologue tag (open:
 * its paragraph; close: everything before it) — such a block is an imitation
 * of injected evidence, often invented, and never something to send or store.
 */
export function stripRecallMarkup(text: string): StripResult {
  return stripBlocks(text, RECALL_OPEN_PATTERN, RECALL_CLOSE_PATTERN);
}

/** The block rules of stripMonologue for any open/close pattern (regex source). */
function stripBlocks(text: string, open: string, close: string): StripResult {
  let blocks = 0;
  let out = text.replace(new RegExp(`${open}[\\s\\S]*?${close}`, "g"), () => {
    blocks++;
    return "";
  });
  let unterminated = false;
  const lastClose = new RegExp(`[\\s\\S]*${close}`);
  if (lastClose.test(out)) {
    unterminated = true;
    out = out.replace(lastClose, "");
  }
  const lone = new RegExp(open).exec(out);
  if (lone) {
    unterminated = true;
    const blank = out.indexOf("\n\n", lone.index);
    out = blank === -1 ? out.slice(0, lone.index) : out.slice(0, lone.index) + out.slice(blank);
  }
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return { text: out, blocks, unterminated };
}

/**
 * For the ingest prompts: the block stays, but labelled as what it is — the
 * character's unspoken thought — so Jev and the writer can use the mood and
 * the decision ("decided not to mention it") without recording the thought
 * as words said or a promise made. A lone tag is labelled the same way.
 */
export function markMonologue(text: string, tags: MonologueTags = DEFAULT_MONOLOGUE_TAGS, label = "没说出口的心声"): string {
  const open = tagPattern(tags.open);
  const close = tagPattern(tags.close);
  return text
    .replace(new RegExp(`${open}\\s*([\\s\\S]*?)\\s*${close}`, "g"), (_m, body: string) => `（${label}：${body.replace(/\s*\n\s*/g, " ")}）`)
    .replace(new RegExp(`${open}|${close}`, "g"), `（${label}）`);
}

/**
 * A role-play character on a chat channel cannot send images or links, but the
 * model sometimes writes an `<img src=…>` tag or a bare URL it made up (seen
 * in a long run: an NGA image link, four turns in a row). Outbound text loses
 * every HTML tag and every http(s) URL; the surrounding words stay.
 */
export function stripHtmlAndUrls(text: string): { text: string; removed: number } {
  let removed = 0;
  let out = text.replace(/<\/?[A-Za-z][^<>]*>/g, () => {
    removed++;
    return "";
  });
  out = out.replace(/https?:\/\/[^\s<>"'）)】]+/g, () => {
    removed++;
    return "";
  });
  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: out, removed };
}
