#!/usr/bin/env python3
"""Build a self-contained HTML viewer for a long role-play run.

Usage:  python3 build_viewer.py runs/long-1        (writes runs/long-1/viewer.html)

Reads (never modifies):
  <run>/yz-dayNN.jsonl              one turn per line {session, at, elapsed_s, user, raw, visible}
  <run>/memstore/.trace.jsonl       memkit trace (retrieve/gate, judge, mid_term rows)
  <run>/memstore/{user,assistant}/**.md   memory files at the end of the run
  <run>/diary.md                    player's notes, "## yz-dayNN ..." sections (optional)
  <run>/flags.json                  optional per-run flag list [{session, turns:[..], label}]
Everything is embedded as JSON; the page makes no network requests except Google Fonts.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Flagged turns for long-1, labels taken from RESULTS.md 「第 1 次长对话」.
# Another run can supply <run>/flags.json with the same shape instead.
DEFAULT_FLAGS = {
    "long-1": [
        {"session": "yz-day01", "turns": [1], "label": "模型自己伪造记忆块（另：一次回复 17 条消息）"},
        {"session": "yz-day13", "turns": [1], "label": "回复末尾抄了一遍当轮的召回块"},
        {"session": "yz-day10", "turns": [3], "label": "<heart> 代替 <心声>"},
        {"session": "yz-day13", "turns": [10], "label": "回复末尾自造「[昨日 23:36]…」"},
        {"session": "yz-day12", "turns": [12, 13, 14, 15], "label": "饮食考题：没召回到就猜"},
        {"session": "yz-day10", "turns": [25, 26], "label": "被玩家编的事套话（被揭穿）"},
    ]
}

# chat `at` is the server's local time; the offset comes from <run>/meta.json
# {"utc_offset_hours": 8} (long-1 was recorded while the box was on UTC-6).
CST = timezone(timedelta(hours=-6))


def parse_trace_ts(s: str) -> float:
    return datetime.strptime(s.replace("Z", "+0000"), "%Y-%m-%dT%H:%M:%S.%f%z").timestamp()


def load_turns(run: Path) -> list[dict]:
    turns = []
    for f in sorted(run.glob("*-day*.jsonl")):
        idx = 0
        for line in f.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            idx += 1
            r = json.loads(line)
            end = datetime.strptime(r["at"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=CST).timestamp()
            segs, ok = segment(r.get("raw", ""), r.get("visible", ""))
            if not ok:  # fall back to exactly what the player saw
                segs = [{"k": "msg", "v": p.strip()} for p in re.split(r"\n\s*\n", r.get("visible", "")) if p.strip()]
            turns.append({
                "s": r.get("session") or f.stem, "n": idx, "at": r["at"],
                "el": r.get("elapsed_s"), "user": r.get("user", ""),
                "segs": segs, "segok": ok,
                "_end": end, "_start": end - float(r.get("elapsed_s") or 0),
            })
    return turns


HIDDEN_RE = re.compile(r"<(心声|heart|memkit-recall)>([\s\S]*?)</(心声|heart|memkit-recall)>")


def segment(raw: str, visible: str) -> tuple[list[dict], bool]:
    """Split raw output into ordered segments: her messages and hidden blocks.

    Hidden blocks are 心声 (open/close tag may be <heart> or mismatched) and
    <memkit-recall>. A block whose text also appears in `visible` was leaked to
    the player and is flagged `leak`. Returns (segments, ok) where ok means the
    reconstructed messages equal the paragraphs of `visible` (else the caller
    should fall back to `visible`).
    """
    segs: list[dict] = []
    last = 0

    def add_text(txt: str) -> None:
        for para in re.split(r"\n\s*\n", txt):
            if para.strip():
                segs.append({"k": "msg", "v": para.strip()})

    for m in HIDDEN_RE.finditer(raw):
        add_text(raw[last:m.start()])
        tag = "recall" if m.group(1) == "memkit-recall" else ("heart" if m.group(1) == m.group(3) == "心声" else "heart-var")
        inner = m.group(2).strip()
        first_line = next((x for x in inner.splitlines() if x.strip()), "")
        segs.append({"k": tag, "v": inner, "tags": f"<{m.group(1)}>…</{m.group(3)}>",
                     "leak": bool(first_line) and first_line.strip() in visible})
        last = m.end()
    add_text(raw[last:])
    vis_paras = [p.strip() for p in re.split(r"\n\s*\n", visible) if p.strip()]
    rec = [x["v"] for x in segs if x["k"] == "msg"]
    # ok = every message we show was seen, and nothing the player saw is missing
    # (residual of `visible` after removing messages, leaked blocks and tags is empty)
    residual = visible
    for x in sorted(segs, key=lambda x: -len(x["v"])):
        if x["k"] == "msg" or x.get("leak"):
            residual = residual.replace(x["v"], "", 1)
    residual = re.sub(r"</?(心声|heart|memkit-recall)>|\s", "", residual)
    for x in segs:  # e.g. text after a mismatched </heart> that the outbound stripper also removed
        if x["k"] == "msg" and x["v"] not in visible:
            x["unseen"] = True
    return segs, not residual


def attach_trace(run: Path, turns: list[dict]) -> None:
    tp = run / "memstore" / ".trace.jsonl"
    if not tp.exists():
        return
    rows = []
    for line in tp.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        if r.get("stage") == "retrieve" and r.get("step") in ("gate", "judge", "mid_term", "rewrite"):
            r["_t"] = parse_trace_ts(r["at"])
            rows.append(r)
    for t in turns:
        lo, hi = t["_start"] - 2, t["_end"] + 1  # +1 s: chat `at` is truncated to whole seconds
        mine = [r for r in rows if lo <= r["_t"] <= hi]
        if not mine:
            continue
        rec: dict = {"fresh": [], "shown": [], "judged": [], "gate": None, "query": None, "rewritten": None}
        for r in mine:
            d = r.get("detail") or {}
            if r["step"] == "mid_term":
                for u in d.get("fresh") or []:
                    if u not in rec["fresh"]:
                        rec["fresh"].append(u)
                for u in d.get("shown") or []:
                    if u not in rec["shown"]:
                        rec["shown"].append(u)
            elif r["step"] == "gate":
                rec["gate"] = d.get("p")
            elif r["step"] == "judge":
                rec["query"] = d.get("query")
                rec["rewritten"] = d.get("rewritten")
                for x in d.get("recalled") or []:
                    rec["judged"].append({"uri": x.get("uri"), "p": x.get("p"), "passed": bool(x.get("passed"))})
        t["rc"] = rec


def load_memory(run: Path) -> dict:
    out = {}
    base = run / "memstore"
    for side in ("user", "assistant"):
        for f in sorted((base / side).rglob("*.md")):
            out[str(f.relative_to(base).with_suffix(""))] = f.read_text(encoding="utf-8")
    return out


def load_diary(run: Path) -> dict:
    p = run / "diary.md"
    if not p.exists():
        return {}
    out: dict[str, list[str]] = {}
    cur = None
    for line in p.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^##\s+(yz\d*-day\d+)(.*)$", line)
        if m:
            cur = m.group(1)
            out.setdefault(cur, [])
            out[cur].append("### " + (m.group(1) + m.group(2)).strip())
            continue
        if cur:
            out[cur].append(line)
    return {k: "\n".join(v).strip() for k, v in out.items()}


def load_flags(run: Path) -> list[dict]:
    p = run / "flags.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return DEFAULT_FLAGS.get(run.name, [])


def main() -> None:
    run = Path(sys.argv[1] if len(sys.argv) > 1 else "runs/long-1").resolve()
    global CST
    meta = run / "meta.json"
    if meta.exists():
        CST = timezone(timedelta(hours=json.loads(meta.read_text())["utc_offset_hours"]))
    turns = load_turns(run)
    attach_trace(run, turns)
    flags = load_flags(run)
    fmap = {(f["session"], n): f["label"] for f in flags for n in f["turns"]}
    for t in turns:
        if (t["s"], t["n"]) in fmap:
            t["flag"] = fmap[(t["s"], t["n"])]
        del t["_start"], t["_end"]
    data = {
        "run": run.name, "turns": turns, "memory": load_memory(run),
        "diary": load_diary(run), "flags": flags,
    }
    blob = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    html = TEMPLATE.replace("__RUN__", run.name).replace("__DATA__", blob)
    out = run / "viewer.html"
    out.write_text(html, encoding="utf-8")
    n_rc = sum(1 for t in turns if t.get("rc"))
    n_fr = sum(1 for t in turns if t.get("rc") and (t["rc"]["fresh"] or t["rc"]["judged"]))
    print(f"wrote {out} ({out.stat().st_size/1024:.0f} KB): {len(turns)} turns, "
          f"{n_rc} with trace rows, {n_fr} with fresh/judged memory, {len(data['memory'])} memory files")


TEMPLATE = r"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>柚叶对话回看 · __RUN__</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#ededed; --panel:#f7f7f7; --line:#dcdcdc; --text:#191919; --muted:#7a7a7a;
  --me:#95ec69; --me-text:#111; --her:#ffffff; --her-text:#191919;
  --heart-bg:#f3efe6; --heart-text:#6b6352; --heart-line:#d8cfba;
  --flag:#e5484d; --flag-bg:#fde8e8; --defect-bg:#fff0d6; --defect-line:#e8a33d;
  --accent:#07a35a; --chip:#e6e6e6; --pass:#07a35a; --fail:#b0b0b0;
  --hl:#ffe58a;
}
@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){
  --bg:#111111; --panel:#1b1b1b; --line:#2e2e2e; --text:#e6e6e6; --muted:#8a8a8a;
  --me:#3eb575; --me-text:#0b1a10; --her:#2c2c2c; --her-text:#e6e6e6;
  --heart-bg:#24221d; --heart-text:#b7ad96; --heart-line:#3d382c;
  --flag:#ff6b6f; --flag-bg:#3a1d1e; --defect-bg:#3a2c12; --defect-line:#c48a2c;
  --accent:#3eb575; --chip:#2a2a2a; --pass:#3eb575; --fail:#666;
  --hl:#6b5a12;
}}
:root[data-theme="dark"]{
  --bg:#111111; --panel:#1b1b1b; --line:#2e2e2e; --text:#e6e6e6; --muted:#8a8a8a;
  --me:#3eb575; --me-text:#0b1a10; --her:#2c2c2c; --her-text:#e6e6e6;
  --heart-bg:#24221d; --heart-text:#b7ad96; --heart-line:#3d382c;
  --flag:#ff6b6f; --flag-bg:#3a1d1e; --defect-bg:#3a2c12; --defect-line:#c48a2c;
  --accent:#3eb575; --chip:#2a2a2a; --pass:#3eb575; --fail:#666;
  --hl:#6b5a12;
}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--text);
  font-family:"Noto Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
  font-size:16px;line-height:1.65;-webkit-text-size-adjust:100%}
button,input{font:inherit;color:inherit}
#top{position:sticky;top:0;z-index:20;background:var(--panel);border-bottom:1px solid var(--line);padding:8px 16px}
#top .row{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
#top h1{font-size:16px;margin:0;font-weight:700;white-space:nowrap}
#stats{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:13px;color:var(--muted)}
#stats b{color:var(--text);font-weight:500}
.ctl{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px}
.tog{display:inline-flex;align-items:center;gap:5px;font-size:14px;padding:4px 10px;border:1px solid var(--line);border-radius:999px;cursor:pointer;background:var(--bg);user-select:none}
.tog input{margin:0;accent-color:var(--accent)}
#q{flex:1 1 160px;min-width:120px;padding:5px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);font-size:15px}
select{font:inherit;font-size:14px;padding:4px 6px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);max-width:100%}
#menuBtn{display:none;border:1px solid var(--line);background:var(--bg);border-radius:8px;padding:3px 10px;cursor:pointer}
#wrap{display:flex;min-height:calc(100vh - 100px)}
#side{width:290px;flex:none;border-right:1px solid var(--line);background:var(--panel);position:sticky;top:var(--toph,100px);height:calc(100vh - var(--toph,100px));overflow:auto;padding:8px 0}
.sess{padding:8px 14px;border-bottom:1px solid var(--line)}
.sess a{display:block;color:var(--text);text-decoration:none;font-size:15px;cursor:pointer}
.sess a .m{color:var(--muted);font-size:13px}
.sess a.cur{color:var(--accent);font-weight:700}
.sess .fc{color:var(--flag);font-size:12px;margin-left:4px}
details.diary{margin-top:4px}
details.diary summary{font-size:13px;color:var(--muted);cursor:pointer}
.diarytxt{font-size:13px;line-height:1.6;white-space:pre-wrap;color:var(--text);margin-top:4px;padding:6px 8px;background:var(--bg);border-radius:6px}
#main{flex:1;min-width:0;padding:0 16px 80px}
.daybar{position:sticky;top:var(--toph,100px);z-index:5;text-align:center;margin:18px 0 6px}
.daybar span{display:inline-block;background:var(--chip);color:var(--muted);font-size:13px;padding:2px 12px;border-radius:6px}
.turn{max-width:760px;margin:0 auto;padding:10px 0 6px;border-top:1px dashed transparent}
.turn.flagged{border-left:4px solid var(--flag);padding-left:10px;background:linear-gradient(90deg,var(--flag-bg),transparent 60%);border-radius:4px}
.meta{text-align:center;font-size:12px;color:var(--muted);margin:2px 0 8px}
.meta .tn{font-weight:500;color:var(--text)}
.flagl{display:inline-block;background:var(--flag);color:#fff;font-size:12.5px;padding:1px 8px;border-radius:4px;margin:0 0 6px}
.msg{display:flex;margin:6px 0;align-items:flex-start;gap:8px}
.msg.me{justify-content:flex-end}
.av{width:36px;height:36px;border-radius:6px;flex:none;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700}
.av.her{background:#f2a9b5;color:#5a1d29}
.av.me{background:#7aa6e8;color:#0f2546}
.av.ghost{visibility:hidden}
.bub{position:relative;max-width:min(78%,560px);padding:8px 12px;border-radius:8px;white-space:pre-wrap;word-break:break-word;font-size:16px}
.me .bub{background:var(--me);color:var(--me-text)}
.her .bub{background:var(--her);color:var(--her-text)}
.heart{max-width:min(86%,620px);margin:6px 0 6px 44px;padding:6px 10px;border-left:3px solid var(--heart-line);background:var(--heart-bg);color:var(--heart-text);font-size:14px;white-space:pre-wrap;border-radius:4px}
.heart .tag{font-size:11.5px;opacity:.8;display:block;margin-bottom:2px}
.heart.defect{background:var(--defect-bg);border-left-color:var(--defect-line)}
.heart.defect .tag{color:var(--defect-line);font-weight:700;opacity:1}
.defect-inline{outline:2px dashed var(--defect-line);outline-offset:2px}
body:not(.show-heart) .heart:not(.defect){display:none}
.rc{max-width:min(86%,620px);margin:6px 0 4px 44px;font-size:13px}
body:not(.show-rc) .rc{display:none}
.rc summary{cursor:pointer;color:var(--muted)}
.rc .grp{margin:4px 0 2px;color:var(--muted)}
.uri{display:inline-block;margin:2px 4px 2px 0;padding:1px 7px;border-radius:5px;background:var(--chip);cursor:pointer;font-size:13px;border:1px solid transparent}
.uri:hover{border-color:var(--accent)}
.uri.pass{box-shadow:inset 3px 0 0 var(--pass)}
.uri.fail{box-shadow:inset 3px 0 0 var(--fail);opacity:.8}
.uri.missing{text-decoration:line-through}
mark{background:var(--hl);color:inherit;border-radius:2px}
#drawer{position:fixed;top:0;right:0;height:100%;width:min(520px,100%);background:var(--panel);border-left:1px solid var(--line);z-index:50;transform:translateX(105%);transition:transform .18s;display:flex;flex-direction:column;box-shadow:-6px 0 24px rgba(0,0,0,.15)}
#drawer.open{transform:none}
#drawer header{display:flex;gap:8px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--line)}
#drawer header b{flex:1;word-break:break-all;font-size:15px}
#drawer header button{border:1px solid var(--line);background:var(--bg);border-radius:6px;padding:2px 10px;cursor:pointer}
#drawer pre{margin:0;padding:14px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:14.5px;line-height:1.7;flex:1}
#empty{max-width:760px;margin:40px auto;text-align:center;color:var(--muted)}
@media (max-width:820px){
  #top{position:static}
  .daybar{top:0}
  #menuBtn{display:inline-block;position:fixed;left:12px;bottom:16px;z-index:40;font-size:20px;padding:6px 14px;box-shadow:0 2px 10px rgba(0,0,0,.25)}
  #side{position:fixed;left:0;top:0;height:100vh;z-index:30;transform:translateX(-105%);transition:transform .18s;width:min(300px,86%);box-shadow:6px 0 24px rgba(0,0,0,.15)}
  #side.open{transform:none}
  #main{padding:0 10px 80px}
  .bub{max-width:80%}
  .heart,.rc{margin-left:0;max-width:100%}
  .av{width:30px;height:30px;font-size:13px}
}
</style>
</head>
<body>
<div id="top">
  <div class="row">
    <button id="menuBtn" aria-label="会话列表">☰</button>
    <h1>哲 × 浮波柚叶 · __RUN__</h1>
    <div id="stats"></div>
  </div>
  <div class="ctl">
    <label class="tog"><input type="checkbox" id="tHeart">显示心声</label>
    <label class="tog"><input type="checkbox" id="tRc">显示召回</label>
    <select id="jump"><option value="">标记的轮次…</option></select>
    <input id="q" type="search" placeholder="搜索两边的文字">
  </div>
</div>
<div id="wrap">
  <nav id="side"></nav>
  <main id="main"></main>
</div>
<aside id="drawer" aria-hidden="true">
  <header><b id="dTitle"></b><button id="dClose">关闭</button></header>
  <pre id="dBody"></pre>
</aside>
<script id="data" type="application/json">__DATA__</script>
<script>
(function(){
const D = JSON.parse(document.getElementById('data').textContent);
const T = D.turns, MEM = D.memory || {};
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sessions = [];
const bySess = {};
T.forEach(t => { if(!bySess[t.s]){ bySess[t.s]=[]; sessions.push(t.s); } bySess[t.s].push(t); });
const dayName = s => s.replace(/^yz-/,'');
const hm = at => at.slice(11,16);
const tid = t => 't-'+t.s+'-'+t.n;

// ---- stats ----
const nHearts = t => t.segs.filter(x=>x.k==='heart'||x.k==='heart-var').length;
T.forEach(t => { t._txt = (t.user + '\n' + t.segs.map(x=>x.v).join('\n')).toLowerCase(); });
const els = T.map(t=>t.el).filter(x=>typeof x==='number');
const avgEl = els.reduce((a,b)=>a+b,0)/Math.max(els.length,1);
const withRc = T.filter(t=>t.rc && (t.rc.fresh.length||t.rc.judged.length)).length;
const multi = T.filter(t=>nHearts(t)>1).length;
$('#stats').innerHTML =
  `<span>轮数 <b>${T.length}</b></span><span>会话 <b>${sessions.length}</b></span>`+
  `<span>平均耗时 <b>${avgEl.toFixed(1)} s</b></span>`+
  `<span>有召回的轮 <b>${(100*withRc/T.length).toFixed(0)}%</b>（${withRc}）</span>`+
  `<span>多段心声的回复 <b>${multi}</b></span>`;

// ---- sidebar ----
const side = $('#side');
side.innerHTML = sessions.map(s => {
  const ts = bySess[s]; const nf = ts.filter(t=>t.flag).length;
  const di = D.diary && D.diary[s];
  return `<div class="sess"><a data-go="${esc(tid(ts[0]))}" data-s="${esc(s)}">${esc(dayName(s))} · ${ts.length} 轮 <span class="m">· ${hm(ts[0].at)}–${hm(ts[ts.length-1].at)}</span>${nf?`<span class="fc">● ${nf}</span>`:''}</a>`+
    (di?`<details class="diary"><summary>玩家备忘</summary><div class="diarytxt">${esc(di)}</div></details>`:'')+`</div>`;
}).join('');

// ---- jump list ----
const jump = $('#jump');
T.filter(t=>t.flag).forEach(t => {
  const o = document.createElement('option'); o.value = tid(t);
  o.textContent = `${dayName(t.s)} t${t.n} · ${t.flag}`; jump.appendChild(o);
});

// ---- rendering ----
const splitMe = s => s.split(/\n/).map(x=>x.trim()).filter(Boolean);
let Q = '';
function hl(s){
  const e = esc(s);
  if(!Q) return e;
  const qe = esc(Q).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return e.replace(new RegExp(qe,'gi'), m=>`<mark>${m}</mark>`);
}
function bubble(who, text, first){
  const av = `<div class="av ${who}${first?'':' ghost'}">${who==='me'?'哲':'柚'}</div>`;
  const b = `<div class="bub">${hl(text)}</div>`;
  return `<div class="msg ${who}">${who==='me'? b+av : av+b}</div>`;
}
function uriChip(u, cls, extra){
  const miss = MEM[u] === undefined ? ' missing' : '';
  return `<span class="uri ${cls||''}${miss}" data-uri="${esc(u)}" title="${miss?'结束时的记忆库里没有这个文件':''}">${esc(u)}${extra||''}</span>`;
}
function rcBlock(t){
  const r = t.rc;
  if(!r) return `<div class="rc"><span style="color:var(--muted)">召回：trace 中无对应行</span></div>`;
  const n = r.fresh.length, j = r.judged.length;
  let sum = `召回：注入 ${n} · 判断 ${j}`;
  if(r.gate!=null) sum += ` · 门 p=${r.gate}`;
  if(r.shown.length) sum += ` · 沿用 ${r.shown.length}`;
  let body = '';
  if(r.query) body += `<div class="grp">查询${r.rewritten?'（改写）':''}：${esc(r.query)}</div>`;
  if(n) body += `<div class="grp">注入（fresh）</div>` + r.fresh.map(u=>uriChip(u)).join('');
  if(j) body += `<div class="grp">判断（Jev p / 放行）</div>` + r.judged.map(x=>uriChip(x.uri, x.passed?'pass':'fail', ` · ${x.p}${x.passed?' ✓':''}`)).join('');
  if(r.shown.length) body += `<div class="grp">沿用（mid-term shown）</div>` + r.shown.map(u=>uriChip(u)).join('');
  if(!body) return `<div class="rc"><span style="color:var(--muted)">${sum}</span></div>`;
  return `<details class="rc"><summary>${sum}</summary>${body}</details>`;
}
function renderTurn(t){
  let h = `<section class="turn${t.flag?' flagged':''}" id="${esc(tid(t))}">`;
  h += `<div class="meta"><span class="tn">${esc(dayName(t.s))} · 第 ${t.n} 轮</span> · ${esc(t.at.slice(5))} · 耗时 ${t.el!=null?t.el+' s':'—'}</div>`;
  if(t.flag) h += `<div class="flagl">⚑ ${esc(t.flag)}</div>`;
  splitMe(t.user).forEach((m,i)=>{ h += bubble('me', m, i===0); });
  h += rcBlock(t);
  let first = true;
  t.segs.forEach(sg => {
    if(sg.k === 'msg'){
      if(sg.unseen){ h += `<div class="heart defect"><span class="tag">⚠ 模型写了但玩家没看到（随心声一起被出站剥除删掉）</span>${hl(sg.v)}</div>`; return; }
      h += bubble('her', sg.v, first); first = false; return; }
    const defect = sg.k !== 'heart' || sg.leak;
    let tag = sg.k === 'recall' ? '⚠ 模型自己写出的 &lt;memkit-recall&gt; 块' : sg.k === 'heart-var' ? `⚠ 心声标签变体 ${esc(sg.tags)}` : '心声';
    if(sg.leak) tag += ' · 玩家可见';
    h += `<div class="heart${defect?' defect':''}"><span class="tag">${tag}</span>${hl(sg.v)}</div>`;
  });
  if(!t.segok) h += `<div class="meta">（心声切分与玩家所见不一致，此轮按玩家所见显示）</div>`;
  h += `</section>`;
  return h;
}
function render(){
  const q = Q.toLowerCase();
  let h = '', shown = 0, cur = null;
  T.forEach(t => {
    if(q && !t._txt.includes(q)) return;
    if(t.s !== cur){ cur = t.s; const ts = bySess[t.s];
      h += `<div class="daybar" data-s="${esc(t.s)}"><span>${esc(dayName(t.s))} · ${esc(ts[0].at.slice(0,10))} ${hm(ts[0].at)}–${hm(ts[ts.length-1].at)}</span></div>`; }
    h += renderTurn(t); shown++;
  });
  $('#main').innerHTML = shown ? h : `<div id="empty">没有匹配的轮次</div>`;
  if(q) $('#main').insertAdjacentHTML('afterbegin', `<div class="meta" style="margin-top:12px">匹配 ${shown} 轮</div>`);
}

// ---- interactions ----
function setTopH(){ document.documentElement.style.setProperty('--toph', $('#top').offsetHeight+'px'); }
window.addEventListener('resize', setTopH);
function goTo(id){
  let el = document.getElementById(id);
  if(!el && Q){ Q=''; $('#q').value=''; render(); el = document.getElementById(id); }
  if(el){ const stickyH = getComputedStyle($('#top')).position === 'sticky' ? $('#top').offsetHeight : 0;
    const y = el.getBoundingClientRect().top + window.scrollY - stickyH - 40; window.scrollTo({top:y}); }
  side.classList.remove('open');
}
side.addEventListener('click', e => { const a = e.target.closest('a[data-go]'); if(a) goTo(a.dataset.go); });
jump.addEventListener('change', () => { if(jump.value) goTo(jump.value); jump.value=''; });
$('#menuBtn').addEventListener('click', () => side.classList.toggle('open'));
const tH = $('#tHeart'), tR = $('#tRc');
tH.addEventListener('change', () => document.body.classList.toggle('show-heart', tH.checked));
tR.addEventListener('change', () => document.body.classList.toggle('show-rc', tR.checked));
let timer;
$('#q').addEventListener('input', e => { clearTimeout(timer); timer = setTimeout(()=>{ Q = e.target.value.trim(); render(); window.scrollTo({top:0}); }, 200); });
const drawer = $('#drawer');
document.addEventListener('click', e => {
  const u = e.target.closest('.uri'); if(!u) return;
  e.preventDefault();
  const k = u.dataset.uri;
  $('#dTitle').textContent = k;
  $('#dBody').textContent = MEM[k] !== undefined ? MEM[k] : '（结束时的记忆库快照里没有这个文件——可能被合并、改名或从未落盘）';
  drawer.classList.add('open'); drawer.setAttribute('aria-hidden','false');
});
$('#dClose').addEventListener('click', () => { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden','true'); });
document.addEventListener('keydown', e => { if(e.key==='Escape') $('#dClose').click(); });
// highlight current session in sidebar while scrolling
const links = {}; side.querySelectorAll('a[data-s]').forEach(a => links[a.dataset.s] = a);
let ticking = false;
window.addEventListener('scroll', () => { if(ticking) return; ticking = true; requestAnimationFrame(() => {
  ticking = false; const lim = (getComputedStyle($('#top')).position === 'sticky' ? $('#top').offsetHeight : 0) + 40; let curS = null;
  document.querySelectorAll('.daybar').forEach(d => { if(d.getBoundingClientRect().top <= lim) curS = d.dataset.s; });
  curS = curS || sessions[0];
  Object.entries(links).forEach(([s,a]) => a.classList.toggle('cur', s===curS));
});});

render(); setTopH();
window.dispatchEvent(new Event('scroll'));
})();
</script>
</body>
</html>
"""

if __name__ == "__main__":
    main()
