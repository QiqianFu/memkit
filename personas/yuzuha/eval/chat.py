#!/usr/bin/env python3
"""One turn with Yuzuha on the memtest gateway, as the player sees it.

Runs on the gateway host. Reads the message from stdin, prints only the visible
reply (the hidden 心声 block is stripped exactly as memkit's message_sending
hook strips it for WeChat), and appends the full exchange — raw reply
included — to a JSONL log so the run can be reviewed afterwards.

    echo "在吗" | python3 chat.py <session-name> [--log runs/<name>.jsonl]
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request

GATEWAY = os.environ.get("GATEWAY_URL", "http://127.0.0.1:18799") + "/v1/chat/completions"
CONFIG = os.path.join(os.environ.get("OPENCLAW_STATE", os.path.expanduser("~/.openclaw-memtest")), "openclaw.json")
MONO = re.compile(r"[<＜]\s*心声\s*[>＞][\s\S]*?[<＜]\s*/\s*心声\s*[>＞]")


def visible(raw: str) -> str:
    out = MONO.sub("", raw)
    # lone tags: same rules as src/monologue.ts
    m = re.search(r"[\s\S]*[<＜]\s*/\s*心声\s*[>＞]", out)
    if m:
        out = out[m.end():]
    m = re.search(r"[<＜]\s*心声\s*[>＞]", out)
    if m:
        blank = out.find("\n\n", m.start())
        out = out[: m.start()] if blank == -1 else out[: m.start()] + out[blank:]
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("session")
    ap.add_argument("--log", default=None)
    a = ap.parse_args()
    text = sys.stdin.read().strip()
    if not text:
        sys.exit("empty message")
    with open(CONFIG) as f:
        tok = json.load(f)["gateway"]["auth"]["token"]
    body = json.dumps({"model": "openclaw/main", "messages": [{"role": "user", "content": text}]}).encode()
    req = urllib.request.Request(
        GATEWAY,
        data=body,
        headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json", "x-openclaw-session-key": f"agent:main:{a.session}"},
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=240) as r:
        raw = json.load(r)["choices"][0]["message"]["content"]
    vis = visible(raw)
    if a.log:
        with open(a.log, "a") as f:
            f.write(json.dumps({"session": a.session, "at": time.strftime("%Y-%m-%d %H:%M:%S"), "elapsed_s": round(time.time() - t0, 1), "user": text, "raw": raw, "visible": vis}, ensure_ascii=False) + "\n")
    print(vis)


if __name__ == "__main__":
    main()
