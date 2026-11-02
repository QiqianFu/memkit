#!/usr/bin/env python3
"""Topic-indexed verbatim excerpts for 30_relationships.md and 50_world.md.

Reads raw/dialogue.json (build_dialogue.py) + TextMap, and for each topic regex lists
matching lines verbatim with their source (TextMap key + CHS quest name). Counts in
the tables are mechanical regex counts over speaker-attributed lines (notes, not text).

Usage: python3 -I build_topics.py RAW_DIR CORPUS_DIR
"""
from __future__ import annotations

import collections
import json
import re
import sys
from pathlib import Path

ME = "浮波柚叶"


def disp(s: str) -> str:
    s = re.sub(r"\{M#([^}]*)\}\{F#([^}]*)\}", lambda m: m.group(1) if m.group(1) == m.group(2) else f"〔{m.group(1)}｜{m.group(2)}〕", s)
    s = re.sub(r"</?color[^>]*>", "", s)
    return s.replace("\n", " / ")


def src(r: dict, l: dict) -> str:
    q = r.get("quest_name_chs") or r.get("fandom_page") or "?"
    return f"《{q}》`{l['key']}`"


def pick(items: list, cap: int) -> list:
    """Spread picks across conversations: round-robin by base, keep order."""
    by = collections.OrderedDict()
    for it in items:
        by.setdefault(it[0]["base"], []).append(it)
    out = []
    while len(out) < cap and any(by.values()):
        for b in list(by):
            if by[b]:
                out.append(by[b].pop(0))
                if len(out) >= cap:
                    break
    return out


def section(title: str, items: list, cap: int, note: str = "", show_speaker: bool = False) -> list[str]:
    out = [f"### {title}\n"]
    if note:
        out.append(f"> 注：{note}\n")
    out.append(f"（共匹配 {len(items)} 行，下列 {min(cap, len(items))} 行按对话分散选取）\n")
    for r, l in pick(items, cap):
        who = f"{l['speaker']}：" if show_speaker else ""
        out.append(f"- {who}「{disp(l['chs'])}」 —— {src(r, l)}")
    out.append("")
    return out


def main() -> None:
    raw = Path(sys.argv[1])
    out = Path(sys.argv[2])
    d = json.load(open(raw / "dialogue.json", encoding="utf-8"))
    tm = json.load(open(raw / "zenlessdata/TextMap/TextMapTemplateTb.json", encoding="utf-8"))
    mine = [(r, l) for r in d for l in r["lines"] if l["speaker"] == ME]
    others = [(r, l) for r in d for l in r["lines"] if l["speaker"] not in (ME, "？", "▷选项", "（旁白/心声）")]
    choices = [(r, l) for r in d for l in r["lines"] if l["speaker"] == "▷选项"]

    def m(items, pat):
        rx = re.compile(pat)
        return [(r, l) for r, l in items if rx.search(l["chs"])]

    # ---------------- relationships
    R = ["# 浮波柚叶 · 人际关系与称呼（Relationships）\n",
         "> 所有引文逐字取自游戏文本（TextMap），说话人由 `tools/build_dialogue.py` 对齐得到；`《任务名》` 为对齐到的任务（中文名取自 `QuestName_*`），反引号内为 TextMap 键。",
         "> 「注」与表格为整理者的机械统计/说明，不是游戏文本。阵营成员来自 `FileCfg/PartnerConfigTemplateTb.json`（阵营 10021 = 怪啖屋）。\n"]
    R += ["## 0. 统计速览（注：正则计数，仅指示频率）\n", "| 项 | 柚叶台词中出现的行数 |", "|---|---|"]
    stat_terms = [("直呼主角名 铃/哲（含性别切换文本）", r"铃|(?<![哲])哲(?!学)"), ("「绳匠」", r"绳匠"), ("「店长」", r"店长"),
                  ("「小师父」", r"小师父"), ("「大小姐」（称爱丽丝）", r"大小姐"), ("「爱丽丝」", r"爱丽丝"), ("「真斗」", r"真斗"),
                  ("「阿釜」", r"阿釜"), ("「爸爸」", r"爸爸"), ("自称「柚叶我」/以名自称", r"柚叶我|叫我柚叶"), ("句中「~」", r"~")]
    for label, pat in stat_terms:
        R.append(f"| {label} | {len(m(mine, pat))} / {len(mine)} |")
    R.append("")
    R += ["## 1. 她怎么称呼主角（绳匠 / 店长 / 直呼其名）\n"]
    R += section("1a. 直呼「铃」「哲」", m(mine, r"(?:^|[，。！？~、…\s「])(?:铃|哲|〔哲｜铃〕)(?:[，。！？~、…]|$)|\{M#哲\}\{F#铃\}"), 30,
                 "游戏里主角可选哲（哥哥）或铃（妹妹），柚叶通常直呼对方名字；同一句常有哲版/铃版两个键。")
    R += section("1b. 称「绳匠」", m(mine, r"绳匠"), 20)
    R += section("1c. 称「店长」", m(mine, r"店长"), 10)
    R += section("1d. 主角称呼她（主角/选项台词中含「柚叶」）", m([x for x in others if x[1]["speaker"].startswith("主角")] + choices, r"柚叶"), 25, show_speaker=True)
    R += ["## 2. 怪啖屋（阵营 10021）成员\n"]
    camp = json.load(open(raw / "zenlessdata/FileCfg/PartnerConfigTemplateTb.json", encoding="utf-8"))["IAEFFFFLKNB"]
    R.append("成员（游戏数据）：" + "、".join(tm.get(p["AAADFNAAAJJ"], "?") for p in camp if p.get("OOOHMBMDLBI") == 10021) + "\n")
    for title, pat, cap in [("2a. 爱丽丝（爱丽丝·泰姆菲尔德）—— 柚叶的台词", r"爱丽丝|大小姐", 30),
                            ("2b. 狛野真斗 —— 柚叶的台词", r"真斗", 25),
                            ("2c. 伊德海莉 / 卢西娅 —— 柚叶的台词", r"伊德海莉|卢西娅", 15)]:
        R += section(title, m(mine, pat), cap)
    R += ["## 3. 家人与过去\n"]
    R += section("3a. 宝荣叔（养父）/ 兄弟姐妹 —— 柚叶的台词", m(mine, r"爸爸|宝荣|小枫|小堇|阿文|妹妹|弟弟|哥哥(?!哥)|家里"), 25)
    R += section("3b. 实验室 / 新叶计划 / 菲洛克斯（任何说话人）", m(mine + others, r"新叶|菲洛克斯|ES-07|实验|研究所|小蜡烛"), 20, show_speaker=True)
    R += ["## 4. 阿釜（她的狸猫伙伴）\n"]
    R += section("4a. 柚叶谈阿釜", m(mine, r"阿釜"), 25)
    R += section("4b. 他人谈阿釜", m(others, r"阿釜"), 10, show_speaker=True)
    R += ["## 5. 其他代理人 / 人物\n"]
    R += section("5a. 柚叶提到的其他人物", m(mine, r"安比|妮可|仪玄|潘引壶|橘福福|浮波|达米安|奥菲丝|普罗米娅|嘉音|薇薇安|雅|11号|比利|猫又|格莉丝"), 30)
    R += ["## 6. 别人怎么称呼 / 评价她\n"]
    addr = collections.Counter()
    for r, l in others:
        for mm in re.finditer(r"柚叶(姐姐|姐|小姐|同学|大人|酱|妹妹|学姐|小朋友)?", l["chs"]):
            addr[(l["speaker"], "柚叶" + (mm.group(1) or ""))] += 1
    R += ["| 说话人 | 称呼 | 次数 |", "|---|---|---|"]
    for (spk, a), c in addr.most_common(40):
        R.append(f"| {spk} | {a} | {c} |")
    R.append("")
    R += section("6a. 他人对柚叶的评价/称呼（含「柚叶」的他人台词，节选）", m(others, r"柚叶(姐姐|小姐|同学|大人)|柚叶(她|总是|又|就是|一定|果然|真是)"), 35, show_speaker=True)
    (out / "30_relationships.md").write_text("\n".join(R), encoding="utf-8")

    # ---------------- world
    W = ["# 浮波柚叶 · 世界知识与喜好（World）\n",
         "> 引文逐字取自游戏文本（TextMap）；《任务名》+ 反引号键为出处。「注」为整理者说明。\n",
         "## 1. 她的生活地点与约会见面点（游戏 UI 文本）\n"]
    for k in sorted(k for k in tm if k.startswith("Text_Transition_2114")):
        W.append(f"- {disp(tm[k])}  `{k}`")
    W.append("")
    for k in sorted(k for k in tm if k.startswith("Text_Date_2114")):
        W.append(f"- {disp(tm[k])}  `{k}`")
    W.append("")
    W += ["## 2. 地点与组织（对话引文）\n"]
    for title, pat, cap in [("2a. 释诡斋（家里的辉瓷工艺品店）", r"释诡斋", 20), ("2b. 澄辉坪 / 卫非地 / 泅珑围", r"澄辉坪|卫非地|泅珑围", 20),
                            ("2c. 怪啖屋（绳网子论坛）/「柚子胡椒」", r"怪啖屋|柚子胡椒|论坛|绳网", 25), ("2d. 辉瓷 / 辉岭石 / 收料子", r"辉瓷|辉岭石|料子", 15),
                            ("2e. 饮茶仙 / 随便观 / 六分街 / 学校", r"饮茶仙|随便观|六分街|学校|宿舍|企业校|考试", 25)]:
        W += section(title, m(mine + others, pat), cap, show_speaker=True)
    W += ["## 3. 喜好与话题（柚叶本人台词）\n"]
    for title, pat, cap in [("3a. 「喜欢 / 讨厌 / 最爱」", r"喜欢|讨厌|最爱|最喜欢|不喜欢|爱吃|想吃", 30),
                            ("3b. 怪谈 / 都市传说 / 鬼故事", r"怪谈|传说|鬼|灵异|闹鬼|诅咒", 30),
                            ("3c. 运气 / 幸运 / 直觉 / 打赌", r"运气|幸运|直觉|赌|刮刮乐|骰子", 20),
                            ("3d. 恶作剧 / 捉弄 / 骗", r"恶作剧|捉弄|骗|逗你|开玩笑|上当|整蛊", 30),
                            ("3e. 故事 / 讲故事 / 卖故事", r"故事", 20),
                            ("3f. 电影 / 录像带", r"电影|录像|片子", 15),
                            ("3g. 糖果 / 甜点 / 食物 / 热量", r"糖|甜|点心|虾饺|汉堡|热量|蛋糕|曲奇|零食|好吃", 25)]:
        W += section(title, m(mine, pat), cap)
    W += ["## 4. 绳网帖子中关于怪啖屋的文本（`PostText_*`，作者未知）\n"]
    for k, v in tm.items():
        if k.startswith("PostText_") and ("怪啖屋" in v or "柚叶" in v):
            W.append(f"- `{k}`")
            W += ["  > " + ln for ln in disp(v).split(" / ")]
    W.append("")
    (out / "50_world.md").write_text("\n".join(W), encoding="utf-8")


if __name__ == "__main__":
    main()
