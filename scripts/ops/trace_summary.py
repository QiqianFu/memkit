"""One line per interesting memkit trace event (segments, gate, rewrite, mid-term, writes).

  python3 trace_summary.py ~/.openclaw-memtest/memkit/main/.trace.jsonl
"""
import json
import sys

STEPS = {"topic_shift", "topic_shift_failed", "gate", "gate_redo", "rewrite", "rewrite_failed", "mid_term", "judge", "write",
         "quarantined", "attempt_failed", "conflict", "recall_fallback"}
short = lambda u: u.split("/")[-1] if isinstance(u, str) else u

for line in open(sys.argv[1]):
    e = json.loads(line)
    st, step, d = e.get("stage"), e.get("step"), e.get("detail", {})
    if step not in STEPS:
        continue
    if step == "judge" and st == "retrieve":
        d = {"rewritten": d.get("rewritten"), "query": d.get("query", "")[:60],
             "recalled": [(short(r["uri"]), r.get("p"), r["passed"]) for r in d.get("recalled", [])]}
    elif step == "judge" and st == "ingest":
        d = {"user": d.get("user", "")[:50], "gate": d.get("gate"), "scope": d.get("scope"), "side": d.get("side"),
             "targets": [short(t) for t in d.get("targets", [])], "options": [(short(o[0]), o[1], o[2]) for o in d.get("options", [])]}
    elif step == "write":
        d = {"side": d.get("side"), "actions": [(a["op"], short(a.get("uri")), a.get("reason"), a["ok"], a.get("error")) for a in d.get("actions", [])]}
    elif step == "mid_term":
        d = {"shift": d.get("shift"), "shown": [short(u) for u in d.get("shown", [])], "fresh": [short(u) for u in d.get("fresh", [])]}
    elif step == "topic_shift":
        d = {"pending": d.get("pending"), "current": d.get("current", "")[:30], "p": d.get("p")}
    elif step == "gate":
        d = {"p": d.get("p"), "recall": d.get("recall"), "recalled": [short(u) for u in d.get("recalled", [])]}
    elif step == "rewrite":
        d = {"query": d.get("query", "")[:50], "rewrite": d.get("rewrite"), "next": d.get("next")}
    t = str(e.get("time", e.get("ts", "")))
    print(f"{t[11:19]} {st}/{step} {json.dumps(d, ensure_ascii=False)}")
