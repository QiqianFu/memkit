import json
import sys

rows = [json.loads(l) for l in open(sys.argv[1])]
reqs = [r for r in rows if r["method"] == "POST"]
print("total requests:", len(rows), "POST:", len(reqs))


def txt(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return " ".join(p.get("text", "") for p in c if isinstance(p, dict))
    return ""


keys = set()
for i, r in enumerate(reqs):
    b = r["body"]
    keys |= set(b.keys())
    msgs = b.get("messages", [])
    sysm = [m for m in msgs if m.get("role") in ("system", "developer")]
    last = msgs[-1] if msgs else {}
    print(
        f"#{i} {r['path']} model={b.get('model')} tools={len(b.get('tools') or [])} "
        f"tool_choice={b.get('tool_choice')} roles={[m['role'] for m in msgs]} "
        f"sys_chars={sum(len(txt(m['content'])) for m in sysm)} "
        f"recall_in_last={'<memkit-recall>' in txt(last.get('content', ''))}"
    )
print("top-level keys seen:", sorted(keys))

if len(sys.argv) > 2:
    b = reqs[int(sys.argv[2])]["body"]
    print("\n===== FULL REQUEST #%s (messages) =====" % sys.argv[2])
    for m in b.get("messages", []):
        print(f"--- [{m['role']}] ---")
        print(txt(m.get("content")))
    rest = {k: v for k, v in b.items() if k != "messages"}
    print("===== other fields =====")
    print(json.dumps(rest, ensure_ascii=False, indent=1)[:3000])
