#!/bin/bash
# Send one message to Yuzuha (the test gateway) and print her visible reply.
# Usage: chat.sh <session-name> "<message>"   (message may be multi-line; the
# hidden 心声 is never shown — it goes to the log only).
# Set GATEWAY_HOST=<ssh host> to run chat.py on a remote gateway host instead
# (it must have this directory at ~/yuzuha-eval).
set -e
[ $# -ge 2 ] || { echo "usage: chat.sh <session> <message>" >&2; exit 2; }
S="$1"; shift
if [ -n "$GATEWAY_HOST" ]; then
  printf '%s' "$*" | ssh "$GATEWAY_HOST" "python3 ~/yuzuha-eval/chat.py '$S' --log ~/yuzuha-eval/runs/$S.jsonl"
else
  D="$(cd "$(dirname "$0")" && pwd)"; mkdir -p "$D/runs"
  printf '%s' "$*" | python3 "$D/chat.py" "$S" --log "$D/runs/$S.jsonl"
fi
