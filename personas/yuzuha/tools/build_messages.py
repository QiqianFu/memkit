#!/usr/bin/env python3
"""Render in-game phone messages (短信) involving Yuzuha from ZenlessData tables to Markdown.

Tables: FileCfg/MessageConfigTemplateTb.json (one row per message node),
MessageGroupConfigTemplateTb.json (one row per conversation, with contact NPC),
MessageNPCTemplateTb.json (contact id -> name key). Field names in the dump are
obfuscated; the meanings below were inferred by inspection (see INDEX.md):
  EGBBBFIINLO group id | PFOAJKNPCHL message id | NMIFFJEFBJI sender npc (0 = player)
  LDHNMACDKLH text key | HBPLELJNAEA step | FMOFACKFIMM node type (1 = player choice,
  3 = empty merge node) | FNOKFPDDECI / GGHOAADLHCF option text keys |
  HFEPEHJGIAN / BKABBJFGMNK next step for option 1 / 2 | group.GJMPCHPFOMM contact npc.

Usage: python3 -I build_messages.py ZENLESSDATA_DIR OUT_MD GROUP_ID [GROUP_ID ...]
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def disp(s: str) -> str:
    s = re.sub(r"\{M#([^}]*)\}\{F#([^}]*)\}", lambda m: m.group(1) if m.group(1) == m.group(2) else f"〔{m.group(1)}｜{m.group(2)}〕", s)
    s = re.sub(r"</?color[^>]*>", "", s)
    return s.replace("\n", " / ")


def main() -> None:
    root = Path(sys.argv[1])
    out = Path(sys.argv[2])
    gids = [int(x) for x in sys.argv[3:]]
    tm = json.load(open(root / "TextMap/TextMapTemplateTb.json", encoding="utf-8"))
    msgs = json.load(open(root / "FileCfg/MessageConfigTemplateTb.json", encoding="utf-8"))["IAEFFFFLKNB"]
    groups = {g["EGBBBFIINLO"]: g for g in json.load(open(root / "FileCfg/MessageGroupConfigTemplateTb.json", encoding="utf-8"))["IAEFFFFLKNB"]}
    npc = {n["PFOAJKNPCHL"]: tm.get(n["HAKHHHCAENA"], n["HAKHHHCAENA"]) for n in json.load(open(root / "FileCfg/MessageNPCTemplateTb.json", encoding="utf-8"))["IAEFFFFLKNB"]}
    lines = []
    for gid in gids:
        g = groups.get(gid, {})
        contact = npc.get(g.get("GJMPCHPFOMM"), "（未登记会话）")
        lines.append(f"### 会话 {gid}（联系人：{contact}）\n")
        lines.append(f"来源：MessageConfigTemplateTb.json group={gid}; MessageGroupConfigTemplateTb.json\n")
        rows = sorted((m for m in msgs if m["EGBBBFIINLO"] == gid), key=lambda m: m["PFOAJKNPCHL"])
        step = None
        for m in rows:
            if m["HBPLELJNAEA"] != step:
                step = m["HBPLELJNAEA"]
                lines.append(f"\n[节点 {step}]")
            if m["FMOFACKFIMM"] == 1:
                for tk, nx in ((m["FNOKFPDDECI"], m["HFEPEHJGIAN"]), (m["GGHOAADLHCF"], m["BKABBJFGMNK"])):
                    if tk:
                        lines.append(f"- ▷选项（→节点 {nx}）：{disp(tm.get(tk, tk))}")
                continue
            if not m["LDHNMACDKLH"]:
                lines.append("- （空节点/分支汇合）")
                continue
            who = "主角（哲/铃）" if m["NMIFFJEFBJI"] == 0 else npc.get(m["NMIFFJEFBJI"], str(m["NMIFFJEFBJI"]))
            lines.append(f"- {who}：{disp(tm.get(m['LDHNMACDKLH'], m['LDHNMACDKLH']))}")
        lines.append("\n")
    out.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
