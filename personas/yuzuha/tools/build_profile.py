#!/usr/bin/env python3
"""Write corpus/00_profile.md and corpus/10_voice_lines.md from ZenlessData TextMap keys
(verbatim) plus the fandom EN voice-over transcription page.

Usage: python3 -I build_profile.py RAW_DIR CORPUS_DIR
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

SRC = "ZenlessData CNPRODWin3.3.0 `TextMap/TextMapTemplateTb.json`"


def clean(s: str) -> str:
    s = re.sub(r"\{M#([^}]*)\}\{F#([^}]*)\}", lambda m: m.group(1) if m.group(1) == m.group(2) else f"〔{m.group(1)}｜{m.group(2)}〕", s)
    s = re.sub(r"</?color[^>]*>", "", s)
    s = re.sub(r"<IconMap:[^>]*>", "", s)
    return s


def block(tm: dict, key: str, en: dict | None = None) -> list[str]:
    if key not in tm:
        return [f"- `{key}`：（游戏文本中不存在）"]
    v = clean(tm[key])
    out = [f"`{key}`", ""]
    out += ["> " + ln if ln.strip() else ">" for ln in v.split("\n")]
    if en is not None and key in en:
        out += ["", f"<details><summary>EN</summary>", "", clean(en[key]).replace("\n", "  \n"), "", "</details>"]
    out.append("")
    return out


def main() -> None:
    raw = Path(sys.argv[1])
    out = Path(sys.argv[2])
    tm = json.load(open(raw / "zenlessdata/TextMap/TextMapTemplateTb.json", encoding="utf-8"))
    en = json.load(open(raw / "zenlessdata/TextMap/TextMap_ENTemplateTb.json", encoding="utf-8"))
    pages = json.load(open(raw / "fandom/pages.json", encoding="utf-8"))

    P: list[str] = ["# 浮波柚叶 · 官方资料（Profile）\n",
                    f"> 除特别标注外均逐字取自游戏文本：{SRC}；阵营来自 `FileCfg/PartnerConfigTemplateTb.json`（PBNPPFFJCGN=1411 → 阵营 10021）+ `PartnerCampConfigTemplateTb.json`。",
                    "> 记号：`〔A｜B〕` = 按主角性别切换（A=哲版，B=铃版）；已去除颜色/图标标签。\n"]
    P += ["## 1. 基本信息（代理人档案）\n",
          "| 项目 | 内容 | 键 |", "|---|---|---|"]
    rows = [("名", "Avatar_Female_Size02_Yuzuha"), ("全名", "Avatar_Female_Size02_Yuzuha_FullName"),
            ("英文名", "Avatar_Female_Size02_Yuzuha_En_FullName"), ("档案名", "Partner_Name_1411"),
            ("性别", "Partner_Gender_02"), ("生日", "Partner_Birthday_1411"), ("身高(cm)", "Partner_Stature_1411"),
            ("阵营", "PartnerCamp_Name_11"), ("定位（攻略概览）", "StrategyGuide_Overview_1411_1"),
            ("定位补充", "StrategyGuide_Overview_1411_2"), ("定位补充", "StrategyGuide_Overview_1411_3"),
            ("专属音擎", "Item_Weapon_S_1411_Name")]
    for label, k in rows:
        P.append(f"| {label} | {clean(tm.get(k, '（无）')).replace('|', '/')} | `{k}` |")
    P.append("")
    P += ["## 2. 代理人档案正文（信赖解锁）\n"]
    for k in ("Partner_ProfileDesc_1411", "Partner_ProfileDesc_1411_1"):
        P += block(tm, k, en)
    P += ["## 3. 合作备注（主角对柚叶的印象）\n", "铃版（f）："] + block(tm, "Partner_Impression_f_1411", en) + ["哲版（m）："] + block(tm, "Partner_Impression_m_1411", en)
    P += ["## 4. 影画（Talent）标题与故事文本\n",
          "> 影画 Desc_02 为每张影画附带的叙事短文（她的过去/近况），是最接近「角色故事」的官方文本。\n"]
    for i in range(1, 7):
        t = tm.get(f"Yuzuha_Talent_0{i}_Title", "")
        P.append(f"### 影画{i}：{t}\n")
        P += block(tm, f"Yuzuha_Talent_0{i}_Desc_02", en)
    P += ["## 5. 物品 / 外观 / 其他官方简介\n"]
    for k in ("Item_Avatar_1411_Des", "Item_Weapon_S_1411_Desc", "Item_Weapon_S_1411_ShortDesc",
              "AvatarSkin_Yuzuha_Name_000", "AvatarSkin_Yuzuha_Desc_000", "AvatarSkin_Yuzuha_Name_001", "AvatarSkin_Yuzuha_Desc_001",
              "CallingCard_3311411_name", "CallingCard_3311411_story", "CallingCard_3321411_story",
              "ScaryNightAvatarDesc_1411", "Title_10043503", "TitleText_2001027", "Yuzuha_SkillName", "Yuzuha_SkillText", "Yuzuha_VHS",
              "Avatar_Yuzuha_Buff_01_Title", "Avatar_Yuzuha_DeBuff_02_Title", "EndlessSummer_Yuzuha_FishSkill_Title"):
        P += block(tm, k)
    P += ["## 6. 技能名（战斗风格的命名，均为官方文本）\n"]
    for i in range(1, 14):
        k = f"Yuzuha_SkillList_{i}_Title"
        if k in tm:
            P.append(f"- {clean(tm[k])}  `{k}`")
    P.append("")
    # official promo/greeting texts transcribed by bwiki (not in game data)
    P += ["## 7. 官方宣传文本（非游戏内文本；经 BWIKI 转录）\n",
          "> 来源：https://wiki.biligame.com/zzz/柚叶 「官方介绍」「官方贺图」栏目（转录自米哈游官方发布的介绍图/贺图配文）。仅收录引号内官方文案，未收录 wiki 自身的说明文字。抓取日期 2026-11-01。\n"]
    promo = Path(raw / "bwiki_promo.txt")
    if promo.exists():
        P += [promo.read_text(encoding="utf-8")]
    (out / "00_profile.md").write_text("\n".join(P), encoding="utf-8")

    # ---- voice lines
    V: list[str] = ["# 浮波柚叶 · 语音 / 短句（Voice lines & barks）\n",
                    "> **重要说明**：游戏数据（TextMap）中**没有**代理人语音（选人、战斗、待机等）的中文文本；ZZZ 的这些语音只有音频。",
                    "> 因此本文件分两部分：A = 游戏内有文本的官方中文短句（气泡/小游戏）；B = fandom wiki 对**英文配音音频**的转录（只作参考，不是中文原文）。\n",
                    "## A. 游戏内中文短句（逐字，" + SRC + "）\n"]
    groups = [("A1. 「仲夏游梦绮谭」钓鱼小游戏中柚叶的台词（EndlessSummer_Fish_Ongoing_Yuzuha_*）", r"^EndlessSummer_Fish_Ongoing_Yuzuha_(Switch_)?\d+$"),
              ("A2. 约会 / 逛街时的头顶气泡（PartnerTalk_BubbleStory_PartnerYuzuha_*）", r"^PartnerTalk_BubbleStory_PartnerYuzuha_"),
              ("A3. 信赖事件中的头顶气泡（PartnerTalk_Bubble_PartnerYuzuha_*）", r"^PartnerTalk_Bubble_PartnerYuzuha_")]
    def natkey(k):
        return [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", k)]
    for title, pat in groups:
        V.append(f"### {title}\n")
        for k in sorted((k for k in tm if re.match(pat, k)), key=natkey):
            V.append(f"- {clean(tm[k])}  `{k}`")
        V.append("")
    V += ["## B. 英文配音转录（fandom，参考用）\n",
          "> 来源：https://zenless-zone-zero.fandom.com/wiki/Ukinami_Yuzuha/Voice-Overs （revid %s），参数名为 fandom 模板字段（如 charselect=选人，idle=待机，qte=连携技，menuhello=约会开场）。\n" % pages.get("Ukinami Yuzuha/Voice-Overs", {}).get("revid", "?")]
    vo = pages.get("Ukinami Yuzuha/Voice-Overs", {}).get("text", "")
    section = None
    for ln in vo.splitlines():
        m = re.match(r"^==([^=].*)==$", ln.strip())
        if m:
            section = m.group(1)
            V.append(f"\n### {section}\n")
            continue
        m = re.match(r"^\|\s*([\w\-]+?)_tx\s*=\s*(.*)$", ln)
        if m:
            V.append(f"- `{m.group(1)}` {m.group(2).strip()}")
            continue
        m = re.match(r"^\|\s*([\w\-]+?)_note\s*=\s*(.*)$", ln)
        if m:
            V.append(f"  - note: {m.group(2).strip()}")
    (out / "10_voice_lines.md").write_text("\n".join(V) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
