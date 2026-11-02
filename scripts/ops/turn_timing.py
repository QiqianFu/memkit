"""Per-turn latency breakdown from memkit's trace (and, optionally, the request-log proxy).

  python3 turn_timing.py ~/.openclaw-memtest/memkit/main/.trace.jsonl [/tmp/model-requests.jsonl]

One row per turn (one `retrieve/mid_term` event = one recallTurn):
  boundary  Jev topic judgment (runs at context assembly, before the prompt hook)
  gate      Jev need-recall gate
  bge       BGE recall (both recalls when the query was rewritten)
  rewrite   DeepSeek query rewrite
  judge     per-file Jev judgments (wall time of the parallel fan-out)
  recall    all of recallTurn (boundary not included when it ran at assembly)
  model     main-model request(s) through the proxy in this turn (`ms` field;
            count in parentheses when OpenClaw sent more than one)
  ingest    segment written after this turn's answer (segment_done ms), with
            the related-judgment fan-out and the writer (DeepSeek) inside it

Traces written before the timing fields existed get approximations from the
gaps between event timestamps, marked with "~" (e.g. "rewrite" then includes
the first BGE recall). Whatever a turn's wall time has beyond
boundary + recall + model is OpenClaw itself (and, on turns whose answer waits
for foreground maintenance, the transcript rewrite: see the gateway log's
"transcript cleaned … rewriteMs=").
"""
import json
import sys
from datetime import datetime


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def load(path):
    out = []
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return out


def fmt(v, approx=False):
    if v is None:
        return "-"
    return f"{'~' if approx else ''}{int(round(v))}"


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    events = [e for e in load(sys.argv[1]) if e.get("at")]
    for e in events:
        e["_t"] = ts(e["at"])
    events.sort(key=lambda e: e["_t"])
    proxy = []
    if len(sys.argv) > 2:
        proxy = [r for r in load(sys.argv[2]) if r.get("at")]
        for r in proxy:
            r["_t"] = ts(r["at"])
        proxy.sort(key=lambda r: r["_t"])

    # Group the retrieve-side events of each turn: everything since the
    # previous mid_term up to and including this turn's mid_term.
    turns, pending = [], []
    for e in events:
        if e.get("stage") == "retrieve" or e.get("step") in ("topic_shift", "topic_shift_failed"):
            pending.append(e)
            if e.get("step") == "mid_term":
                turns.append({"end": e, "events": pending})
                pending = []

    rows = []
    for i, t in enumerate(turns):
        d = t["end"].get("detail", {})
        tm = d.get("timings")
        by = {}
        for e in t["events"]:
            by.setdefault(e["step"], e)
        approx = tm is None
        if tm:
            start = t["end"]["_t"] - tm.get("total", 0) / 1000
            row = {k: tm.get(k) for k in ("boundary", "gate", "bge", "rewrite", "judge", "total")}
        else:
            # Old trace: gaps between event timestamps. The boundary's own
            # duration is unknown (its event only marks its end).
            gate, rw, jd, mid = (by.get(s) for s in ("gate", "rewrite", "judge", "mid_term"))
            row = {"boundary": None, "gate": None, "bge": None, "rewrite": None, "judge": None, "total": None}
            if rw and gate:
                row["rewrite"] = (rw["_t"] - gate["_t"]) * 1000
            if jd:
                row["judge"] = (jd["_t"] - (rw or gate or jd)["_t"]) * 1000
            first = by.get("topic_shift") or gate or mid
            row["total"] = (mid["_t"] - first["_t"]) * 1000 if first is not mid else None
            start = first["_t"]
        row.update(at=t["end"]["at"][11:23], turn=str(d.get("turn", ""))[-8:], approx=approx, start=start, end=t["end"]["_t"],
                   fresh=len(d.get("fresh", [])), reqs=[])
        rows.append(row)

    # Main model: each proxy row belongs to the last turn whose recall had
    # ended when the request arrived (the request follows the prompt hook).
    # Trace and proxy timestamps both have ms resolution: allow 5 ms.
    for r in proxy:
        owner = None
        for row in rows:
            if row["end"] <= r["_t"] + 0.005:
                owner = row
        if owner is not None:
            owner["reqs"].append(r)
    for row in rows:
        reqs = row["reqs"]
        row["model"] = sum(r["ms"] for r in reqs) if reqs and all("ms" in r for r in reqs) else None
        row["nreq"] = len(reqs)

    # Ingest: each event belongs to the last turn whose recall ended before
    # the ingest work started (at - ms), i.e. the agent_end that ran it.
    for row in rows:
        row.update(ingest=None, related=None, write=None)
    for e in events:
        if e.get("stage") != "ingest" or e.get("step") not in ("segment_done", "attempt_failed", "quarantined", "judge", "write"):
            continue
        ms = (e.get("detail") or {}).get("ms")
        began = e["_t"] - (ms or 0) / 1000
        owner = None
        for row in rows:
            if row["end"] <= began:
                owner = row
        if owner is None or ms is None:
            continue
        key = {"segment_done": "ingest", "attempt_failed": "ingest", "quarantined": "ingest", "judge": "related", "write": "write"}[e["step"]]
        owner[key] = (owner[key] or 0) + ms

    cols = ["at", "turn", "boundary", "gate", "bge", "rewrite", "judge", "recall", "model", "ingest", "related", "write", "fresh"]
    print(" ".join(f"{c:>9}" for c in cols))
    for r in rows:
        a = r["approx"]
        model = fmt(r["model"]) + (f"({r['nreq']})" if r["nreq"] > 1 else "")
        vals = [r["at"], r["turn"] or "-", fmt(r["boundary"], a and r["boundary"] is not None), fmt(r["gate"], a and r["gate"] is not None),
                fmt(r["bge"], a and r["bge"] is not None), fmt(r["rewrite"], a and r["rewrite"] is not None),
                fmt(r["judge"], a and r["judge"] is not None), fmt(r["total"], a and r["total"] is not None), model,
                fmt(r["ingest"]), fmt(r["related"]), fmt(r["write"]), str(r["fresh"])]
        print(" ".join(f"{v:>9}" for v in vals))
    if not proxy and len(sys.argv) > 2:
        print("(proxy log empty)")
    elif proxy and not any("ms" in r for r in proxy):
        print("(proxy rows have no `ms`: written by an older request_log_proxy.mjs)")


if __name__ == "__main__":
    main()
