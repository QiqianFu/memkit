// Tokenization + BM25 for the lexical prefilter.
//
// The prefilter only has to get the right file INTO the candidate list; the
// discriminator (Jev) does the actual relevance judgment. So recall matters
// far more than precision here, and when the store is small the caller skips
// the prefilter entirely and lets the discriminator see every file.

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD = /[\p{L}\p{N}]/u;

/** Latin/number runs become words; CJK runs become unigrams + bigrams. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  let word = "";
  let cjk: string[] = [];
  const flushWord = () => {
    if (word) out.push(word);
    word = "";
  };
  const flushCjk = () => {
    for (let i = 0; i < cjk.length; i++) {
      out.push(cjk[i]);
      if (i + 1 < cjk.length) out.push(cjk[i] + cjk[i + 1]);
    }
    cjk = [];
  };
  for (const ch of (text || "").toLowerCase()) {
    if (CJK.test(ch)) {
      flushWord();
      cjk.push(ch);
    } else if (WORD.test(ch)) {
      flushCjk();
      word += ch;
    } else {
      flushWord();
      flushCjk();
    }
  }
  flushWord();
  flushCjk();
  return out;
}

export interface Bm25Doc<T> {
  item: T;
  text: string;
}

export function bm25Rank<T>(
  docs: Bm25Doc<T>[],
  query: string,
  opts: { k1?: number; b?: number } = {},
): { item: T; score: number }[] {
  const k1 = opts.k1 ?? 1.2;
  const b = opts.b ?? 0.75;
  const toks = docs.map((d) => tokenize(d.text));
  const avgLen = toks.reduce((s, t) => s + t.length, 0) / Math.max(1, toks.length);
  const df = new Map<string, number>();
  for (const t of toks) for (const term of new Set(t)) df.set(term, (df.get(term) ?? 0) + 1);
  const qTerms = [...new Set(tokenize(query))];
  const N = docs.length;
  const scored = docs.map((d, i) => {
    const tf = new Map<string, number>();
    for (const term of toks[i]) tf.set(term, (tf.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of qTerms) {
      const f = tf.get(term);
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks[i].length) / (avgLen || 1)));
    }
    return { item: d.item, score };
  });
  return scored.sort((x, y) => y.score - x.score);
}

/** Stable path segment for a topic, so separator variants of one topic land in one file. */
export function slug(s: string): string {
  const out = (s || "")
    .trim()
    .toLowerCase()
    // A space between two CJK characters is noise, not a word boundary.
    .replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, "$1")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return out || "misc";
}

export function truncate(s: string, n: number): string {
  if (!s || s.length <= n) return s || "";
  return s.slice(0, n) + "…";
}
