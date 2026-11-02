import json
import sys

rows = [json.loads(l) for l in open(sys.argv[1])]
reqs = [r["body"] for r in rows if r["method"] == "POST"]


def txt(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return " ".join(p.get("text", "") for p in c if isinstance(p, dict))
    return ""


print(f"{len(reqs)} requests")
for i, b in enumerate(reqs):
    msgs = b.get("messages", [])
    users = [m for m in msgs if m["role"] == "user"]
    last = users[-1]
    older = users[:-1]
    t = txt(last["content"])
    pos = t.find("<memkit-recall>")
    print(
        f"#{i} tools={len(b.get('tools') or [])} roles={[m['role'] for m in msgs]} "
        f"recall_in_current={pos >= 0} recall_at_end={pos >= 0 and t.rstrip().endswith('</memkit-recall>')} "
        f"recall_in_history={sum('<memkit-recall>' in txt(m['content']) for m in older)}"
    )

# Prefix stability: request N's prefix (system + all but the last user msg) should
# equal request N-1's full messages minus its recall block, for same-session pairs.
print("\nsame-session prefix check:")
for i in range(1, len(reqs)):
    prev, cur = reqs[i - 1]["messages"], reqs[i]["messages"]
    if len(cur) <= 2:
        continue
    prefix = cur[: len(prev)]
    same_sys = prefix[0] == prev[0]
    prev_user_clean = txt(prev[-1]["content"]).split("<memkit-recall>")[0].strip()
    cur_hist_user = txt(prefix[-1]["content"]).strip()
    print(f"#{i - 1}->#{i} system_identical={same_sys} prev_user_persisted_without_recall={cur_hist_user == prev_user_clean}")

if len(sys.argv) > 2:
    b = reqs[int(sys.argv[2])]
    print(f"\n===== request #{sys.argv[2]} =====")
    for m in b["messages"]:
        print(f"--- [{m['role']}] ---\n{txt(m['content'])}")
