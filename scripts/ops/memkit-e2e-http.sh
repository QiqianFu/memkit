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
ask s1 "我跟你说一下：我们组的周会改到每周三下午三点了，地点在 5 楼的听涛会议室。另外我女儿叫小满，下个月 12 号过生日。"
ask s1 "对了，我对花生过敏，以后推荐吃的都要避开花生。"
ask s2 "我们组周会是什么时候、在哪开？"
ask s3 "帮我想想女儿生日那天晚饭吃什么，有什么要注意的吗？"
ask s4 "更正一下：周会地点不是听涛会议室，是 6 楼的观海会议室，时间不变。"
ask s5 "周会在哪个会议室？"
ask s5 "那几点开？"
ask s6 "我上次跟你说的车牌号是多少来着？"
ask s7 "帮我把小满生日那条忘掉吧，不用再记了。"
ask s8 "我女儿小满哪天过生日？"
