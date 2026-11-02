#!/usr/bin/env python3
"""Render dialogue.json (from build_dialogue.py) into corpus/2x_*.md story files.

Usage: python3 -I render_corpus.py DIALOGUE_JSON CORPUS_DIR
"""
from __future__ import annotations

import collections
import json
import re
import sys
from pathlib import Path

FILES = {
    "20": ("20_story_main.md", "主线剧情（Phaethon's Story：第二季第二章「迟吟的浪涌」等）中的柚叶对话"),
    "21": ("21_story_trust_and_dates.md", "柚叶本人的信赖事件 / 逸趣事件 / 约会（PartnerTalk·PartnerDate）"),
    "22": ("22_event_midsummer_main.md", "版本活动「仲夏游梦绮谭」主线「绮梦之夏」（2.1；Activity_*_EndlessSummer、Cs_Summer_* 等）"),
    "23": ("23_event_midsummer_side.md", "版本活动「仲夏游梦绮谭」番外故事「人鱼之梦」「乘风破浪」等（2.1；Activity_*_Summer）"),
    "24": ("24_event_summer_waves.md", "版本活动「恰浪花逐夏而至」（Activity_*_SummerTideTreasure）"),
    "26": ("26_events_other.md", "其他版本活动 / 小游戏剧情中的柚叶对话"),
    "25": ("25_story_cameos.md", "其他代理人的信赖事件、支线、路人对话中的柚叶"),
    "29": ("29_mentions_only.md", "仅提及柚叶（她本人不出声/无法确认她出声）的对话"),
}


def disp(s: str) -> str:
    s = re.sub(r"\{M#([^}]*)\}\{F#([^}]*)\}", lambda m: m.group(1) if m.group(1) == m.group(2) else f"〔{m.group(1)}｜{m.group(2)}〕", s)
    s = re.sub(r"</?color[^>]*>", "", s)
    return s.replace("\n", " / ")


def route(r: dict) -> str:
    b = r["base"]
    ev = (r["fandom_meta"].get("event_name_chs") or "")
    if not r["speaks"]:
        return "29"
    if b.startswith("Main_") or r["fandom_meta"].get("type") == "Phaethon's Story":
        return "20"
    if "Yuzuha" in b and b.startswith(("PartnerTalk", "PartnerDate")):
        return "21"
    if b.startswith(("Activity_", "Cs_", "CS_", "Cinema_")):
        if "SummerTideTreasure" in b or ev == "恰浪花逐夏而至":
            return "24"
        if re.search(r"_Summer_", b):
            return "23"
        if ev == "仲夏游梦绮谭" or "EndlessSummer" in b or b.startswith("Cs_Summer"):
            return "22"
        return "26"
    return "25"


def main() -> None:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
    out = Path(sys.argv[2])
    buckets: dict[str, dict] = {k: collections.OrderedDict() for k in FILES}
    for r in data:
        page = r["fandom_page"] or "（未匹配到 fandom 页面）"
        buckets[route(r)].setdefault(page, []).append(r)
    stats = {}
    for fk, (fname, title) in FILES.items():
        groups = buckets[fk]
        lines = [f"# {title}\n",
                 "> 逐字取自游戏文本（ZenlessData CNPRODWin3.3.0 `TextMap/TextMapTemplateTb.json`）。",
                 "> 说话人由 tools/build_dialogue.py 通过 EN TextMap ↔ fandom 英文剧情转写对齐得到；`？` = 未能对齐，未作猜测。",
                 "> 记号：`〔A｜B〕` = 游戏中按主角性别切换的文本（A=哲版，B=铃版）；` / ` = 原文换行；已去除颜色标签。",
                 "> **粗体** = 柚叶本人台词。每段对话标注 TextMap 键前缀（行号接在其后，如 `_001`）。\n"]
        def gkey(item):
            page, rs = item
            m = rs[0]["fandom_meta"]
            try:
                return (0, int(m.get("seasonNum", 99)), int(m.get("chapterNum", 99)), int(m.get("epNum", 99)), min(x["base"] for x in rs))
            except ValueError:
                return (1, 0, 0, 0, min(x["base"] for x in rs))
        n_conv = n_line = n_yz = 0
        for page, rs in sorted(groups.items(), key=gkey):
            m = rs[0]["fandom_meta"]
            qn = rs[0].get("quest_name_chs")
            head = f"## {qn}（{page}）" if qn else f"## {page}"
            lines.append(head)
            info = []
            if m.get("type"):
                info.append(f"类型（fandom）：{m['type']}")
            for f in ("chapter_chs", "event_name_chs"):
                if m.get(f):
                    info.append(("章节：" if f.startswith("chapter") else "活动：") + m[f])
            if rs[0].get("quest_name_keys"):
                info.append("任务名键：" + ", ".join(rs[0]["quest_name_keys"]))
            if page != "（未匹配到 fandom 页面）":
                info.append(f"说话人对齐来源：https://zenless-zone-zero.fandom.com/wiki/{page.replace(' ', '_')}")
            if info:
                lines.append("> " + "；".join(info) + "\n")
            for r in sorted(rs, key=lambda x: (x["fandom_pos"] if x["fandom_pos"] is not None else 10**9, x["base"])):
                n_conv += 1
                idxs = [l["idx"] for l in r["lines"]]
                lines.append(f"### `{r['base']}`（{idxs[0]}–{idxs[-1]}）")
                for l in r["lines"]:
                    n_line += 1
                    t = disp(l["chs"])
                    if l["speaker"] == "浮波柚叶":
                        n_yz += 1
                        lines.append(f"- **浮波柚叶：{t}**")
                    else:
                        lines.append(f"- {l['speaker']}：{t}")
                lines.append("")
        (out / fname).write_text("\n".join(lines), encoding="utf-8")
        stats[fname] = (len(groups), n_conv, n_line, n_yz)
    for k, v in stats.items():
        print(k, "quests=%d convs=%d lines=%d yuzuha_lines=%d" % v, file=sys.stderr)


if __name__ == "__main__":
    main()
