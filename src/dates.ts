// Time awareness: hard-coded date resolution, no model call.
//
// Why rules and not a model: which calendar day 「周六」 or 「下周三」 means
// is arithmetic over the turn's own timestamp, not judgment. Rules are
// deterministic (a seeded scenario replays identically), cost nothing per
// turn, and every resolution can be audited in the trace — a model could
// "resolve" a date confidently and wrongly, which is exactly the shortcut
// memkit exists to avoid. What a rule cannot resolve resolves to nothing; the
// normal recall path still runs.
//
// Dates are plain `YYYY-MM-DD` strings in the conversation's local calendar
// (the date in the host's time envelope, else the host's local date). All
// arithmetic is done on UTC midnights, so no time zone or DST can shift a day.

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** `YYYY-MM-DD` → UTC-midnight epoch ms (NaN when malformed). */
function toUtc(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}

function fromUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `day` shifted by `n` calendar days. */
export function addDays(day: string, n: number): string {
  return fromUtc(toUtc(day) + n * 86_400_000);
}

/** 1 = Monday … 7 = Sunday (Chinese weeks run Monday to Sunday). */
export function isoWeekday(day: string): number {
  return new Date(toUtc(day)).getUTCDay() || 7;
}

/** 「周六」 for a `YYYY-MM-DD`. */
export function weekdayName(day: string): string {
  return WEEKDAYS[new Date(toUtc(day)).getUTCDay()];
}

/** A valid calendar day, or null (e.g. 2 月 30 日). */
function makeDay(y: number, m: number, d: number): string | null {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const s = `${y}-${pad(m)}-${pad(d)}`;
  return fromUtc(toUtc(s)) === s ? s : null;
}

/** The host's local calendar date of an epoch ms (or of an ISO string). */
export function localDay(t: number | string): string | null {
  const d = typeof t === "number" ? new Date(t) : new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localClock(t: string): string | null {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The host's time envelope at the start of a user message, e.g.
 * `[Sun 2026-11-01 10:32 CST]` or `[Mon 2026-11-02 04:36 GMT+8]`. Its date is
 * already the conversation's local date, so it wins over any conversion.
 */
const ENVELOPE = /^\s*\[(?:[A-Za-z]{3}\s+)?(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}:\d{2}))?[^\]\n]{0,40}\]\s*/;

export function envelopeOf(text: string): { day: string; clock?: string } | null {
  const m = ENVELOPE.exec(text || "");
  if (!m) return null;
  const day = makeDay(+m[1], +m[2], +m[3]);
  return day ? { day, ...(m[4] ? { clock: m[4] } : {}) } : null;
}

/** The message without its leading time envelope. */
export function stripEnvelope(text: string): string {
  return (text || "").replace(ENVELOPE, "");
}

/**
 * When a turn was said, as the writer and the trace are shown it:
 * envelope first, then the turn's ISO time in the host's local zone.
 * `null` when neither gives a date (e.g. a test's "第2天").
 */
export function turnMoment(user: string, time?: string): { day: string; clock?: string } | null {
  const env = envelopeOf(user);
  if (env) return env;
  if (!time || !/^\d{4}-\d{2}-\d{2}T/.test(time)) return null;
  const day = localDay(time);
  const clock = localClock(time);
  return day ? { day, ...(clock ? { clock } : {}) } : null;
}

/** 「2026-11-01（周日）10:32」 */
export function describeMoment(m: { day: string; clock?: string }): string {
  return `${m.day}（${weekdayName(m.day)}）${m.clock ? ` ${m.clock}` : ""}`;
}

// ---- resolution -------------------------------------------------------------

const CN_DIGIT: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 「12」「十二」「二十一」「三十」 → number (1–99), else NaN. */
export function parseNum(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^([一二两三四五六七八九])?(十)?([一二三四五六七八九])?$/.exec(s);
  if (!m || !s) return NaN;
  if (!m[2]) return m[1] && !m[3] ? CN_DIGIT[m[1]] : NaN;
  return (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[3] ? CN_DIGIT[m[3]] : 0);
}

const NUM = "(\\d{1,2}|[一二两三四五六七八九十]{1,3})";
const DAY_NAME: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 七: 7, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7 };

/** One resolved expression: the words, and the day(s) they mean. */
export interface DateMention {
  text: string;
  dates: string[];
}

/**
 * Every absolute day the text refers to, relative to `today` (`YYYY-MM-DD`,
 * the day the message was said). Handled, in this order (a matched span is
 * consumed so 「下周六」 is not also read as 「周六」):
 *   - explicit 2026-11-02 / 2026/11/2 / 2026年11月2日
 *   - [明年|去年|今年|前年|后年] X月X日/号 (no year → this year)
 *   - [上个月|下个月|这个月|本月] X号 / X日 (bare: this month; 日 only after Arabic digits)
 *   - [上|这|本|下]…[个]周末 → that week's Saturday and Sunday
 *   - [上上|上|这|本|下|下下][个] 周X / 星期X / 礼拜X (Monday-to-Sunday weeks);
 *     a bare 周X is this week's X, plus next week's X when this week's has
 *     already passed (「周六」 said on a Sunday may mean yesterday or the coming one)
 *   - 大前天 / 前天 / 昨天 / 今天 / 明天 / 后天 / 大后天 (and 昨晚, 今早, 明晚, …)
 * 「明年」「去年」 alone name no day and resolve to nothing.
 */
export function resolveMentions(text: string, today: string): DateMention[] {
  if (Number.isNaN(toUtc(today))) return [];
  let s = stripEnvelope(text);
  const out: DateMention[] = [];
  const year = +today.slice(0, 4);
  const month = +today.slice(5, 7);
  const take = (re: RegExp, fn: (m: RegExpExecArray) => (string | null)[]) => {
    s = s.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      const dates = [...new Set(fn(m).filter((d): d is string => Boolean(d)))];
      if (dates.length) out.push({ text: m[0], dates });
      return " ".repeat(m[0].length);
    });
  };
  const YEAR_SHIFT: Record<string, number> = { 明年: 1, 后年: 2, 去年: -1, 前年: -2 };
  const yearOf = (w: string | undefined) => year + (YEAR_SHIFT[w ?? ""] ?? 0);

  take(/(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})(?!\d)/g, (m) => [makeDay(+m[1], +m[2], +m[3])]);
  take(new RegExp(`(?:(\\d{4})\\s*年|(明年|后年|去年|前年|今年))?\\s*${NUM}\\s*月(?:份)?\\s*${NUM}\\s*[日号]`, "g"), (m) => {
    const y = m[1] ? +m[1] : yearOf(m[2]);
    return [makeDay(y, parseNum(m[3]), parseNum(m[4]))];
  });
  take(new RegExp(`(上个?月|下个?月|这个?月|本月)?(?:(?<!\\d)(\\d{1,2})\\s*[号日]|([一二三四五六七八九十]{1,3})\\s*号)`, "g"), (m) => {
    const shift = m[1]?.startsWith("上") ? -1 : m[1]?.startsWith("下") ? 1 : 0;
    const first = new Date(Date.UTC(year, month - 1 + shift, 1));
    return [makeDay(first.getUTCFullYear(), first.getUTCMonth() + 1, parseNum(m[2] ?? m[3]))];
  });
  const weekStart = addDays(today, 1 - isoWeekday(today)); // this week's Monday
  const weekShift = (w: string | undefined) => {
    if (!w) return 0;
    if (w.startsWith("上")) return -(w.match(/上/g)!.length);
    if (w.startsWith("下")) return w.match(/下/g)!.length;
    return 0;
  };
  take(/(上上|下下|上|下|这|本)?个?(?:周末|礼拜末)/g, (m) => {
    const mon = addDays(weekStart, 7 * weekShift(m[1]));
    return [addDays(mon, 5), addDays(mon, 6)];
  });
  take(/(上上|下下|上|下|这|本)?个?(?:周|星期|礼拜)([一二三四五六日天七1-7])/g, (m) => {
    const dow = DAY_NAME[m[2]];
    const day = addDays(weekStart, 7 * weekShift(m[1]) + dow - 1);
    // A bare 周X whose day this week is already past: the coming one too.
    if (!m[1] && day < today) return [day, addDays(day, 7)];
    return [day];
  });
  const REL: [RegExp, number][] = [
    [/大前天/g, -3], [/大后天/g, 3],
    [/前天|前日/g, -2], [/后天|后日/g, 2],
    [/昨天|昨日|昨晚|昨夜|昨儿/g, -1], [/明天|明日|明早|明晚|明儿/g, 1],
    [/今天|今日|今晚|今早|今夜|今儿/g, 0],
  ];
  for (const [re, n] of REL) take(re, () => [addDays(today, n)]);
  return out;
}

/** The distinct days of resolveMentions(), in order of mention. */
export function resolveDates(text: string, today: string): string[] {
  return [...new Set(resolveMentions(text, today).flatMap((m) => m.dates))];
}

// ---- ingest post-check --------------------------------------------------------

/** Relative time words an entry must not carry without an absolute date. */
const RELATIVE =
  /(大?前天|大?后天|昨天|昨日|昨晚|昨夜|今天|今晚|今早|今夜|明天|明日|明早|明晚|(?:上上|下下|上|下|这|本)?个?(?:周|星期|礼拜)[一二三四五六日天]|(?:上|下|这|本)个?周末|周末|(?:上|下|这|本)个?(?:周|星期|礼拜)(?![一二三四五六日天末])|上个?月|下个?月|明年|去年)/;
const ABSOLUTE = /\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*[日号]/;

/** The relative time words in one entry that has no absolute date ([] = fine). */
export function relativeWithoutDate(entry: string): string[] {
  if (ABSOLUTE.test(entry)) return [];
  const g = new RegExp(RELATIVE.source, "g");
  return [...new Set([...entry.matchAll(g)].map((m) => m[0]))];
}

/**
 * Absolute dates with a year, as entries write them: 2026-11-08, 2026/11/8,
 * 2026年11月8日. A date without a year (「11月2日」, a birthday) recurs and
 * names no weekday, so only these need one.
 */
const DATED = /(\d{4})\s*(?:-|\/|\.|年)\s*(\d{1,2})\s*(?:-|\/|\.|月)\s*(\d{1,2})(?!\d)\s*[日号]?/g;
const WEEKDAY_AFTER = /^\s*[（(]?\s*(?:周|星期|礼拜)([一二三四五六日天七])/;
const WEEKDAY_BEFORE = /(?:周|星期|礼拜)([一二三四五六日天七])\s*[（(]?\s*$/;

/**
 * What is wrong with the weekdays of one entry's absolute dates ([] = fine):
 * a dated entry must say which weekday it is (「2026-11-08（周日）」, before
 * or right after the date) and the weekday must be that day's. An entry read
 * weeks later is matched against 「周日」 by people and by Jev; the weekday
 * is what lets them tell one Sunday from another, and it is arithmetic, so a
 * wrong one is checked here rather than trusted.
 */
export function weekdayProblems(entry: string): string[] {
  const out: string[] = [];
  for (const m of entry.matchAll(DATED)) {
    const day = makeDay(+m[1], +m[2], +m[3]);
    if (!day) continue;
    const said = WEEKDAY_AFTER.exec(entry.slice(m.index! + m[0].length)) ?? WEEKDAY_BEFORE.exec(entry.slice(0, m.index!));
    const want = weekdayName(day);
    if (!said) out.push(`「${m[0].trim()}」没有写星期（${day} 是${want}）`);
    else if (`周${said[1].replace(/[天七]/, "日")}` !== want) out.push(`「${m[0].trim()}」的星期写错了（${day} 是${want}）`);
  }
  return [...new Set(out)];
}

// ---- titles -------------------------------------------------------------------

/**
 * Time in a file's name or topic: dates, months, weekdays, weekends, relative
 * days/weeks/months/years, clock times. A title is what Jev and BGE match a
 * file by; 「周日见约定」 then looks like every later segment that mentions
 * some Sunday (long-2: P(related) 0.50–0.93 on segments about other things,
 * and never written into), while the same appointment told on another day
 * gets another title. Time belongs in the entries, which carry the full date.
 *
 * Guarded against the common false hits: 「第七号隧道」 / 「十七号」 (an
 * ordinal or a longer number), 「3号线」 「5号楼」 (a numbered thing), 「有一点」
 * 「差一点」 (a quantity, not a clock). Parts of the day (深夜, 午夜…) are left
 * alone: they name things too (「午夜第九站台」).
 */
const CN = "[一二两三四五六七八九十]";
const TITLE_TIME = new RegExp(
  [
    "\\d{4}\\s*[-/.年]\\s*\\d{1,2}(?:\\s*[-/.月]\\s*\\d{1,2}\\s*[日号]?)?",
    `(?<![第\\d一二两三四五六七八九十])(?:\\d{1,2}|${CN}{1,3})\\s*月(?:份)?(?:\\s*(?:\\d{1,2}|${CN}{1,3})\\s*[日号])?`,
    `(?<![第\\d一二两三四五六七八九十])(?:\\d{1,2}\\s*[号日]|${CN}{1,3}\\s*号)(?![线楼房位车门床机店桌柜球鞋码屋窗台口院馆厅坑箱包杯人])`,
    "(?:上上|下下|上|下|这|本)?个?(?:周|星期|礼拜)[一二三四五六日天]",
    "(?:上上|下下|上|下|这|本)?个?周末",
    "(?:上上|下下|上|下|这|本)个?(?:周|星期|礼拜)(?![一二三四五六日天末])",
    "大?前天|大?后天|昨天|昨日|昨晚|昨夜|今天|今日|今晚|今早|今夜|明天|明日|明早|明晚|今年|明年|去年|上个?月|下个?月|这个?月|本月|月底|月初|年底",
    "\\d{1,2}\\s*[:：]\\s*\\d{2}",
    `(?<![差有早晚快慢多少好些点这那第])(?:\\d{1,2}|${CN}{1,3})\\s*点(?:半|钟|整|一刻|三刻|\\d{1,2}分?)?(?![儿心子滴菜赞评头])`,
  ].join("|"),
  "g",
);

/** The time words in a title (file name or topic), in order, each once ([] = none). */
export function timeWordsIn(title: string): string[] {
  return [...new Set([...(title || "").matchAll(TITLE_TIME)].map((m) => m[0].trim()))];
}

/** A title with its time words taken out (「周日六分街看片约定」 → 「六分街看片约定」). */
export function withoutTimeWords(title: string): string {
  return (title || "").replace(TITLE_TIME, "");
}

// ---- store search ---------------------------------------------------------------

/**
 * How strongly a file is dated on any of `days`: `text` counts occurrences in
 * topic / summary / body (as 2026-11-02, or 11月2日 / 11月2号 for older
 * entries), `times` the writes whose local date (or literal ISO prefix) is
 * one of them. Text hits rank first: a file merely WRITTEN that day is a
 * weaker match than one that SAYS that day.
 */
export function dateHits(rec: { topic: string; summary: string; body: string; times: string[] }, days: string[]): { text: number; times: number } {
  const hay = `${rec.topic}\n${rec.summary}\n${rec.body}`;
  let text = 0;
  for (const day of days) {
    const [y, m, d] = [day.slice(0, 4), +day.slice(5, 7), +day.slice(8, 10)];
    const forms = [day, `${y}-${m}-${d}`, `${m}月${d}日`, `${m}月${d}号`];
    for (const f of new Set(forms)) text += countOf(hay, f);
  }
  let times = 0;
  for (const t of rec.times) {
    const literal = /^\d{4}-\d{2}-\d{2}/.exec(t)?.[0];
    const local = /T/.test(t) ? localDay(t) : null;
    if ((literal && days.includes(literal)) || (local && days.includes(local))) times++;
  }
  return { text, times };
}

function countOf(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) {
    // 「11月2日」 must not count inside 「11月21日」, nor 2026-11-2 inside 2026-11-21.
    const after = hay[i + needle.length] ?? "";
    const before = hay[i - 1] ?? "";
    if (/\d/.test(after) && /\d$/.test(needle)) continue;
    if (/\d/.test(before) && /^\d/.test(needle)) continue;
    n++;
  }
  return n;
}

/**
 * The candidate list for a time-related turn: up to `n` date-matched files
 * first, then the BGE recall fills the rest up to `total`, each file once.
 * Fewer date matches leave more room for BGE.
 */
export function mergeCandidates<T>(dated: T[], recalled: T[], total: number, n: number, key: (x: T) => string): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  const add = (x: T) => {
    const k = key(x);
    if (seen.has(k) || out.length >= total) return;
    seen.add(k);
    out.push(x);
  };
  for (const x of dated.slice(0, Math.max(0, n))) add(x);
  for (const x of recalled) add(x);
  return out;
}
