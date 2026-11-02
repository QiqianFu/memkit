import json
import os

c = os.path.join(os.environ.get("OPENCLAW_STATE", os.path.expanduser("~/.openclaw-memtest")), "openclaw.json")
d = json.load(open(c))
# Main agent gets no tools: deny wins over every profile/allow; code mode off so
# no exec/wait control tools appear either.
d["tools"] = {"profile": "minimal", "deny": ["*"], "codeMode": False}
d["plugins"]["entries"]["memory-core"] = {"enabled": False}
cfg = d["plugins"]["entries"]["memkit"].setdefault("config", {})
cfg["mainAgent"] = "answer-only"
json.dump(d, open(c, "w"), indent=2)
print(json.dumps({"tools": d["tools"], "memkit": d["plugins"]["entries"]["memkit"]}, ensure_ascii=False))
