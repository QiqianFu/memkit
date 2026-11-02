"""Mid-term memory check over the recording proxy's log.

For each main-agent request: which recall blocks (by id) are in the current
message and which sit in history, and — against the previous request of the
same session — which history blocks were kept and which were dropped.

  python3 check_midterm.py /tmp/model-requests.jsonl [N]   # N = print request N in full
"""
import json
import re
import sys

BLOCK = re.compile(r'<memkit-recall(?:\s+id="([^"]*)")?>[\s\S]*?</memkit-recall>')

rows = [json.loads(l) for l in open(sys.argv[1])]
reqs = [r["body"] for r in rows if r["method"] == "POST"]


def txt(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return " ".join(p.get("text", "") for p in c if isinstance(p, dict))
    return ""


def ids(text):
    return [m.group(1) or "(no id)" for m in BLOCK.finditer(text)]


print(f"{len(reqs)} requests")
prev_hist = None
prev_first = None
for i, b in enumerate(reqs):
    msgs = b.get("messages", [])
    users = [m for m in msgs if m["role"] == "user"]
    if not users:
        continue
    first = txt(users[0]["content"])[:30]
    same_session = first == prev_first
    cur = ids(txt(users[-1]["content"]))
    hist = [(j, ids(txt(m["content"]))) for j, m in enumerate(users[:-1])]
    hist_ids = [x for _, l in hist for x in l]
    at_end = txt(users[-1]["content"]).rstrip().endswith("</memkit-recall>") if cur else None
    line = f"#{i} user_msgs={len(users)} current_block={cur} at_end={at_end} history_blocks={hist_ids}"
    if same_session and prev_hist is not None:
        kept = [x for x in prev_hist if x in hist_ids]
        dropped = [x for x in prev_hist if x not in hist_ids]
        line += f" | vs prev: kept={kept} dropped={dropped}"
    dup = {x for x in hist_ids + cur if (hist_ids + cur).count(x) > 1}
    if dup:
        line += f" | DUPLICATE ids: {sorted(dup)}"
    print(line)
    prev_hist = hist_ids + cur
    prev_first = first

if len(sys.argv) > 2:
    b = reqs[int(sys.argv[2])]
    print(f"\n===== request #{sys.argv[2]} =====")
    for m in b["messages"]:
        print(f"--- [{m['role']}] ---\n{txt(m['content'])}")
