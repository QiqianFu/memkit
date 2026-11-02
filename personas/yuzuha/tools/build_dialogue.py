#!/usr/bin/env python3
"""Extract Yuzuha-related dialogue from the ZenlessData CHS TextMap and attribute speakers.

The datamined TextMap has the game's own text but (for most lines) no speaker.
Speaker attribution is recovered by matching each line's EN TextMap text against
fandom wiki transcripts (which label speakers); matched EN speaker names are mapped
back to the game's CHS names via TextMap name keys. Lines that cannot be matched
keep speaker "？" (unknown) -- we never guess.

Usage (run with python3 -I, data paths as arguments; never executes downloaded code):
  python3 -I build_dialogue.py RAW_DIR OUT_JSON
RAW_DIR must contain zenlessdata/TextMap/{TextMapTemplateTb,TextMap_ENTemplateTb}.json
and fandom/pages.json (as written by fetch_fandom.py).
"""
from __future__ import annotations

import collections
import json
import re
import sys
from pathlib import Path

YUZUHA_EN = {"Ukinami Yuzuha", "Yuzuha"}
CONV_PREFIX = re.compile(r"^(Main|Activity|PartnerTalk|PartnerDate|Side|Cs|CS|Cinema|Companion|PasserBy)_")
LINE_RE = re.compile(r"^(.*)_(\d+)$")
NAME_RE = re.compile(r"^(.*)_Name_?(\d+)$")


def norm_en(s: str, female: bool = False) -> str:
    s = re.sub(r"\{M#([^}]*)\}\{F#([^}]*)\}", r"\2" if female else r"\1", s)
    s = re.sub(r"\{F#([^}]*)\}\{M#([^}]*)\}", r"\1" if female else r"\2", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = s.replace("&mdash;", "—").replace("&ndash;", "–").replace("&hellip;", "…").replace("&nbsp;", " ")
    s = s.lower()
    return re.sub(r"[^a-z0-9]+", "", s)


def strip_wiki(s: str, variant: int = 1) -> str:
    # [[a|b]] -> b ; [[a]] -> a
    s = re.sub(r"\[\[(?:[^\]|]*\|)?([^\]]*)\]\]", r"\1", s)
    for _ in range(4):  # nested templates, innermost first
        s = re.sub(r"\{\{MC\|s=1\}\}", "SIBLING", s)
        s = re.sub(r"\{\{MC\|([^{}|]*)\|([^{}|]*)\}\}", r"\%d" % variant, s)  # 1 = Wise, 2 = Belle
        s = re.sub(r"\{\{MC\}\}", "MC", s)
        s = re.sub(r"\{\{Color\|[^{}|]*\|([^{}|]*)\}\}", r"\1", s)
        s = re.sub(r"\{\{(?:sic|Color|Term|Item|tt|Tooltip)\|([^{}|]*)(?:\|[^{}]*)?\}\}", r"\1", s)
        s = re.sub(r"\{\{[^{}]*\}\}", "", s)
    s = s.replace("'''", "").replace("''", "")
    return s.strip()


SPEAKER_LINE = re.compile(r"^[:;*#]*\s*'''(.{1,60}?):?'''\s*:?\s*(.*)$")
CHOICE_LINE = re.compile(r"^[:;*#]*\s*(?:\{\{DIcon[^}]*\}\}|\{Choice\})\s*(.*)$")


def parse_fandom(pages: dict) -> tuple[dict, dict]:
    """Return (norm_text -> list[(speaker, page, pos)], page -> infobox meta)."""
    idx: dict[str, list] = collections.defaultdict(list)
    meta = {}
    for title, rec in pages.items():
        text = rec["text"]
        m = {}
        for f in ("type", "subtype", "chapter", "event_name", "id", "seasonNum", "chapterNum", "epNum"):
            mm = re.search(r"^\|\s*" + f + r"\s*=\s*(.*)$", text, re.M)
            if mm:
                m[f] = strip_wiki(mm.group(1))
        meta[title] = m
        for pos, line in enumerate(text.splitlines()):
            sp = SPEAKER_LINE.match(line)
            if sp:
                spk = strip_wiki(sp.group(1)).strip().rstrip(":")
                if spk == "MC" or spk == "{MC}":
                    spk = "MC"
                body = sp.group(2)
            else:
                ch = CHOICE_LINE.match(line)
                if ch:
                    spk, body = "CHOICE", ch.group(1)
                elif re.match(r"^:+\s*[^:;{|'\s]", line):
                    spk, body = "NARRATION", line.lstrip(": ")
                else:
                    continue
            for n in {norm_en(strip_wiki(body, 1)), norm_en(strip_wiki(body, 2))}:
                if len(n) >= 2:
                    idx[n].append((spk, title, pos))
    return idx, meta


def build_name_map(chs: dict, en: dict) -> dict:
    pairs = collections.defaultdict(collections.Counter)
    for k, v in chs.items():
        if (NAME_RE.match(k) or k.startswith("Partner_Name_") or k.endswith("_FullName")) and k in en:
            e = en[k].strip()
            if e and v.strip():
                pairs[e][v.strip()] += 1
    out = {e: c.most_common(1)[0][0] for e, c in pairs.items()}
    out.update({"MC": "主角（哲/铃）", "SIBLING": "主角的兄妹", "CHOICE": "▷选项", "NARRATION": "（旁白/心声）",
                "Ukinami Yuzuha": "浮波柚叶", "Yuzuha": "浮波柚叶"})
    return out


def main() -> None:
    raw = Path(sys.argv[1])
    out = Path(sys.argv[2])
    chs = json.load(open(raw / "zenlessdata/TextMap/TextMapTemplateTb.json", encoding="utf-8"))
    en = json.load(open(raw / "zenlessdata/TextMap/TextMap_ENTemplateTb.json", encoding="utf-8"))
    pages = json.load(open(raw / "fandom/pages.json", encoding="utf-8"))
    fidx, meta = parse_fandom(pages)
    names = build_name_map(chs, en)
    prefix_idx = collections.defaultdict(list)
    for n, lst in fidx.items():
        if len(n) >= 30:
            prefix_idx[n[:30]].extend(lst)

    convs: dict[str, dict] = collections.OrderedDict()
    for k, v in chs.items():
        if not CONV_PREFIX.match(k):
            continue
        nm = NAME_RE.match(k)
        if nm:
            convs.setdefault(nm.group(1), {"lines": {}, "names": {}})["names"][int(nm.group(2))] = v
            continue
        m = LINE_RE.match(k)
        if not m:
            continue
        convs.setdefault(m.group(1), {"lines": {}, "names": {}})["lines"][int(m.group(2))] = (m.group(2), k, v)

    result = []
    for base, c in convs.items():
        if not c["lines"]:
            continue
        lines = []
        page_votes = collections.Counter()
        page_pos = {}
        speaks = False
        mentions = False
        # NOTE: TextMap *_Name_NN keys are a per-conversation table of name labels,
        # not per-line speakers (verified: Name_001/002 of a GalGame were 铃/哲 while
        # lines 001/002 are spoken by A-Yue/Yuzuha). So they are only kept as "cast".
        order = sorted(c["lines"])
        hitmap = {}
        for i in order:
            raw_idx, key, text = c["lines"][i]
            hits = []
            for fem in (False, True):
                n = norm_en(en.get(key, ""), fem)
                hits = fidx.get(n) or (prefix_idx.get(n[:30]) if len(n) >= 30 else None) or []
                if hits:
                    break
            hitmap[i] = (n, hits)
            if len(n) >= 25:  # only distinctive lines vote for the source page
                for pg in {h[1] for h in hits}:
                    page_votes[pg] += 1
        if page_votes:
            top = page_votes.most_common(1)[0][1]
            dominant = {pg for pg, v in page_votes.items() if v >= max(2, 0.3 * top)} or {page_votes.most_common(1)[0][0]}
        else:
            dominant = set()
        last_pos = {}
        for i in order:
            raw_idx, key, text = c["lines"][i]
            en_text = en.get(key, "")
            n, hits = hitmap[i]
            speaker, src = "？", None
            # Accept only hits from the conversation's dominant source page(s); this stops
            # short generic lines ("Huh?") from importing a speaker from an unrelated quest.
            cand = [h for h in hits if h[1] in dominant]
            if cand:
                # sequence alignment: prefer the first hit at/after the last matched position
                def keyf(h):
                    lp = last_pos.get(h[1], -1)
                    return (0 if h[2] >= lp else 1, abs(h[2] - lp))
                h = min(cand, key=keyf)
                last_pos[h[1]] = h[2]
                page_pos.setdefault(h[1], h[2])
                speaker, src = names.get(h[0], h[0]), "fandom:" + h[0]
            if speaker == "浮波柚叶":
                speaks = True
            if "柚叶" in text or "柚子胡椒" in text:
                mentions = True
            lines.append({"idx": raw_idx, "key": key, "speaker": speaker, "speaker_src": src,
                          "chs": text, "en": en_text})
        if not (speaks or mentions):
            continue
        page = page_votes.most_common(1)[0][0] if page_votes else (next(iter(page_pos)) if page_pos else None)
        result.append({"base": base, "cast_names": [c["names"][j] for j in sorted(c["names"])], "speaks": speaks, "mentions": mentions, "fandom_page": page,
                       "fandom_pos": page_pos.get(page) if page else None,
                       "fandom_meta": meta.get(page, {}) if page else {},
                       "lines": lines})

    # CHS quest names for fandom page titles, via EN TextMap QuestName_* keys
    en_q = collections.defaultdict(list)
    en_rev: dict[str, str] = {}
    for k, v in en.items():
        if k.startswith("QuestName_"):
            en_q[v.strip()].append(k)
        else:
            en_rev.setdefault(v.strip(), k)
    for r in result:
        p = r["fandom_page"]
        if p:
            ks = en_q.get(p) or en_q.get(re.sub(r" \((?:[IVX]+)\)$", "", p)) or []
            r["quest_name_chs"] = chs.get(ks[0]) if ks else None
            r["quest_name_keys"] = ks[:4]
            for f in ("chapter", "event_name"):
                val = r["fandom_meta"].get(f)
                if val:
                    kk = ([en_rev[val]] if val in en_rev else []) or en_q.get(val, [])[:1]
                    r["fandom_meta"][f + "_chs"] = chs.get(kk[0]) if kk else None
    json.dump(result, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    sp = sum(1 for r in result if r["speaks"])
    yl = sum(1 for r in result for l in r["lines"] if l["speaker"] == "浮波柚叶")
    unk = sum(1 for r in result for l in r["lines"] if l["speaker"] == "？")
    tot = sum(len(r["lines"]) for r in result)
    print(f"convs={len(result)} speaking={sp} lines={tot} yuzuha_lines={yl} unknown_speaker={unk}", file=sys.stderr)


if __name__ == "__main__":
    main()
