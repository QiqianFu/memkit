#!/bin/bash
# Mid-term memory e2e: ONE session, like a real user. Topics change several
# times so the segment ingest fires; then follow-ups inside a topic should keep
# the earlier recall block (no new block, no new recall when the gate says so),
# and a topic change should drop the previous topic's blocks.
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
    -H "x-openclaw-session-key: agent:main:mid-${RUN_ID}-$1" \
    -d "$(python3 -c "import json,sys; print(json.dumps({\"model\":\"openclaw/main\",\"messages\":[{\"role\":\"user\",\"content\":sys.argv[1]}]}))" "$2")" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(\"ASSISTANT:\", (d.get(\"choices\",[{}])[0].get(\"message\",{}).get(\"content\") or json.dumps(d,ensure_ascii=False))[:600])" 2>&1
  printf "(%.1fs)\n" $(echo "$(date +%s.%N) - $s" | bc)
  sleep ${WAIT:-15}
}
echo "RUN_ID=$RUN_ID"
# --- seeding: each topic change should record the previous segment
ask s "我跟你说一下：我们组的周会改到每周三下午三点了，地点在 5 楼的听涛会议室。"
ask s "另外我女儿叫小满，下个月 12 号过生日。"
ask s "换个事：我对花生过敏，以后推荐吃的都要避开花生。"
ask s "我的车停在 B2 层 37 号车位。"
ask s "定条规矩记牢了：凡是高风险的营生，最多只能动用小金库的两成。"
ask s "今天天气真不错啊，适合出门走走。"
# --- mid-term: follow-ups inside a topic, then topic changes
ask s "我们组周会是什么时候、在哪开？"
ask s "那个会议室在几楼来着？"
ask s "我女儿哪天过生日？"
ask s "那天晚饭给她做点什么好，有什么要注意的吗？"
ask s "上回定的那个上限是几成来着？"
ask s "我车停哪了？"
ask s "那是第几层？"
