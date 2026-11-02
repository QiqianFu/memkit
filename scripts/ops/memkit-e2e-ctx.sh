#!/bin/bash
# Context-engine e2e: one seeding session, one 3-turn session, two concurrent sessions.
RUN_ID=${RUN_ID:-$(date +%s)}
# OPENCLAW_STATE: the test profile's state dir; GATEWAY_URL: its HTTP endpoint.
STATE=${OPENCLAW_STATE:-$HOME/.openclaw-memtest}
GW=${GATEWAY_URL:-http://127.0.0.1:18799}
TOKEN=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["gateway"]["auth"]["token"])' "$STATE/openclaw.json")
ask() {
  echo "### [$1] USER: $2"
  curl -s --max-time 240 $GW/v1/chat/completions \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -H "x-openclaw-session-key: agent:main:ctx-${RUN_ID}-$1" \
    -d "$(python3 -c "import json,sys; print(json.dumps({\"model\":\"openclaw/main\",\"messages\":[{\"role\":\"user\",\"content\":sys.argv[1]}]}))" "$2")" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(\"[$1] ASSISTANT:\", (d.get(\"choices\",[{}])[0].get(\"message\",{}).get(\"content\") or json.dumps(d,ensure_ascii=False))[:300])" 2>&1
  sleep ${WAIT:-12}
}
echo "RUN_ID=$RUN_ID"
ask seed "我的车停在 B2 层 37 号车位，另外我对花生过敏，记一下。"
ask t "我车停哪了？"
ask t "那是第几层？"
ask t "我对什么过敏来着？"
WAIT=0 ask p1 "我车停在几号车位？" &
WAIT=0 ask p2 "我有什么忌口？" &
wait
sleep 5  # the active-branch index updates asynchronously after rewrites
