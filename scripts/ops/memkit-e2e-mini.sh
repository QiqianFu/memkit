#!/bin/bash
RUN_ID=${RUN_ID:-$(date +%s)}
# OPENCLAW_STATE: the test profile's state dir; GATEWAY_URL: its HTTP endpoint.
STATE=${OPENCLAW_STATE:-$HOME/.openclaw-memtest}
GW=${GATEWAY_URL:-http://127.0.0.1:18799}
TOKEN=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["gateway"]["auth"]["token"])' "$STATE/openclaw.json")
ask() {
  local s=$(date +%s.%N)
  echo "### [$1] USER: $2"
  curl -s --max-time 240 $GW/v1/chat/completions \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -H "x-openclaw-session-key: agent:main:e2e-${RUN_ID}-$1" \
    -d "$(python3 -c "import json,sys; print(json.dumps({\"model\":\"openclaw/main\",\"messages\":[{\"role\":\"user\",\"content\":sys.argv[1]}]}))" "$2")" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(\"ASSISTANT:\", (d.get(\"choices\",[{}])[0].get(\"message\",{}).get(\"content\") or json.dumps(d,ensure_ascii=False))[:800])" 2>&1
  printf "(%.1fs)\n" $(echo "$(date +%s.%N) - $s" | bc)
  sleep ${WAIT:-15}
}
ask n1 "我的车停在 B2 层 37 号车位，记一下。"
ask n2 "我车停哪了？"
ask n2 "那是第几层？"
