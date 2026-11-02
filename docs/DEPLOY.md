# 部署指南

从零开始，把 memkit 和柚叶跑起来：先准备外部服务，再起一个测试 gateway 用 HTTP 和她对话，最后接上微信。

需要：Node ≥ 24、OpenClaw ≥ 2026.10.7、python3（ops 脚本只用标准库）。memkit 没有第三方依赖，不需要构建或 `npm install`。

---

## 1. 外部服务

| 服务 | 用途 | 必需？ |
|---|---|---|
| **DeepSeek** | 主模型（回答），以及 memkit 的写入（ingest 的 JSON）和召回改写 | 必需 |
| **Jev**（TypeSafe System One） | 所有「过 / 不过」的判断：值不值得记、记到哪一侧、话题是否切换、这一轮要不要召回、每个候选文件相不相关 | 强烈建议 |
| **BGE-M3** | 召回排序（只负责把候选找出来，不决定什么能进证据） | 可选 |

### DeepSeek

`POST https://api.deepseek.com/chat/completions`，模型 `deepseek-flash`，`reasoning_effort: low`。key 放在 `DEEPSEEK_API_KEY`。覆盖项：`MEMKIT_LLM_MODEL` / `MEMKIT_LLM_BASE_URL` / `MEMKIT_LLM_REASONING_EFFORT`（任何 OpenAI 兼容的服务都行）。

### Jev

`POST https://api.typesafe.ai/v1/systemone`，key 在 console.typesafe.ai 申请，放在 `JEV_API_KEY`。覆盖项 `JEV_BASE_URL` / `JEV_MODEL`（默认 `jev-latest`）。

**没有 Jev key 时**，`judge.backend: "auto"`（默认）会退回用 DeepSeek 模拟同一套判断（`LlmJudge`）。这样也能跑，但这时「判断」也是生成模型给的，失去了这个项目的核心保证（判断由判别模型给出、生成模型只负责写），召回质量也明显更差。正式使用请配真 Jev，并设 `judge.backend: "jev"`：没有 key 时直接报错，不会悄悄降级。用的是哪种判断，看 `.trace.jsonl` 里 judge 的名字是 `jev:…` 还是 `llm:…`。

### BGE-M3（可选）

任何 OpenAI 兼容的 `/v1/embeddings` 服务都可以，模型名默认 `bge-m3`（`embed.model` 可改）。memkit 发送 `{ "model", "input": [..], "encoding_format": "base64" }`，期望返回 1024 维 L2 归一化向量。每条输入在发送前截到 `embed.maxChars`（6000 字）。

```json
"embed": { "baseUrl": "http://127.0.0.1:8000", "apiKeyFile": "~/.config/bge/token" }
```

`baseUrl` 和 key 都不配（或 `embed.enabled: false`）时用 BM25 召回（中文一字 + 二字切词）；配了但服务挂了，这一轮自动退回 BM25（trace 里记 `recall_fallback`），不会让这一轮失败。Jev 的判断两种情况下都照常进行。

---

## 2. 安装插件

```bash
git clone <this repo> ~/apps/memkit
cd ~/apps/memkit && npm test                     # 离线单测，几秒，不联网
openclaw --profile memtest plugins install --link ~/apps/memkit --force --accept-capabilities
```

`--link` 安装后，改代码不用重装；改了 hook / 引擎逻辑要重启 gateway。人设卡改了下一轮自动重读，不用重启。

密钥放在 profile 状态目录的 `.env` 里（模板 [.env.example](../.env.example)），gateway 启动时加载：

```bash
cp .env.example ~/.openclaw-memtest/.env && chmod 600 ~/.openclaw-memtest/.env    # 再填入 key
```

---

## 3. 测试 gateway（HTTP 对话）

先用一个单独的 profile（下面叫 `memtest`，状态目录 `~/.openclaw-memtest`，端口 18799）起 gateway，通过 OpenAI 兼容的 HTTP 接口和柚叶对话，确认一切正常再接微信。

1. 配置：把 [examples/openclaw.test.example.json](../examples/openclaw.test.example.json) 拷成 `~/.openclaw-memtest/openclaw.json`，替换里面的 `<…>` 和 `/path/to/…`：
   - `plugins.load.paths`：DeepSeek provider 插件和 memkit 的路径；
   - `gateway.auth.token`：生成一个随机 token；
   - `persona.file`：`personas/yuzuha/card.md` 的绝对路径（也可以写相对状态目录的路径）；`persona.vars` 填玩家的名字。
   
   这份配置里决定行为的几项：
   - `tools: { profile: "minimal", deny: ["*"], codeMode: false, toolSearch: false }`：回答模型**没有任何工具**，只能看到证据。`toolSearch` 默认开启，`deny: ["*"]` 拦不住它，必须显式关。
   - `plugins.slots.memory` 和 `plugins.slots.contextEngine` 都是 `"memkit"`。后者负责把已经结束的话题的召回块从历史里清掉；不选它，每一轮注入的证据都会在之后的每一轮里重放。
   - `memory-core` 停用：OpenClaw 自带的文件记忆会成为第二份、会分叉的记忆。
   - `hooks.allowConversationAccess: true` 和足够长的 hook 超时（非内置插件需要授权才能挂 `before_prompt_build` / `agent_end`）。
   - `mainAgent: "answer-only"`：用人设卡整个替换系统提示词，后面追加 memkit 的角色扮演记忆规则。
2. 初始记忆：`scripts/ops/memstore_reset.sh first-run`（见 §5）。
3. 起 gateway：
   ```bash
   openclaw --profile memtest gateway run --port 18799
   ```
   小内存机器上建议加内存限额（Linux）：
   ```bash
   systemd-run --user --unit=memtest-gw --collect -p MemoryHigh=1100M -p MemoryMax=1300M \
     -E HOME=$HOME -E PATH=$PATH "$(command -v openclaw)" --profile memtest gateway run --port 18799
   journalctl --user -u memtest-gw -f              # 等 "[gateway] ready"
   ```
   加 `-E MEMKIT_DEBUG=1` 可以看到每一轮召回 / 写入的耗时。
4. 对话：
   ```bash
   personas/yuzuha/eval/chat.sh s1 "在吗"            # 只打印可见回复；心声进 personas/yuzuha/eval/runs/s1.jsonl
   ```
   或者直接 curl（同一个 `x-openclaw-session-key` = 同一个会话，换一个 = 新会话，只能靠记忆）：
   ```bash
   TOKEN=$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.openclaw-memtest/openclaw.json")))["gateway"]["auth"]["token"])')
   curl -s http://127.0.0.1:18799/v1/chat/completions \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -H "x-openclaw-session-key: agent:main:s1" \
     -d '{"model":"openclaw/main","messages":[{"role":"user","content":"在吗"}]}'
   ```
   注意：一次性的 `openclaw agent exec` 会在运行结束 5 秒后回收插件，打断 `agent_end` 里的写入；要用常驻的 gateway。

### 时区

柚叶靠用户消息前的时间信封（如 `[Mon 2026-11-02 04:36 GMT+8]`）判断早晚，记忆里的日期也按它解析。所以：

- 配置里设 `agents.defaults.userTimezone: "Asia/Shanghai"`（模板里已有）；
- 机器的系统时区也设成北京时间（Linux：`sudo timedatectl set-timezone Asia/Shanghai`；只改 `/etc/timezone` 不生效），改完重启 gateway。

症状：gateway 日志的时间偏移不是 `+08:00`，信封显示 `CST`（有歧义，可能是美国中部时间），深夜的消息被她当成上午。

### 抓包（可选）

想看回答模型实际收到了什么（系统提示词、证据块、有没有 `tools` 字段）：

```bash
node scripts/request_log_proxy.mjs --port 18990 --upstream https://api.deepseek.com --log /tmp/model-requests.jsonl
# openclaw.json: "models": { "providers": { "deepseek": { "baseUrl": "http://127.0.0.1:18990", "api": "openai-completions" } } }
python3 scripts/ops/inspect_requests.py /tmp/model-requests.jsonl
: > /tmp/model-requests.jsonl                    # 日志里有对话原文，看完清空
```

memkit 自己调用 DeepSeek 时直连，不经过代理。代理没在跑而 `baseUrl` 指着它时，每一轮都会报连接错误。

---

## 4. 接上微信

1. 按你使用的 OpenClaw 微信渠道插件自己的文档安装、登录（本仓库不包含渠道插件）。
2. 在同一个 profile 里按 [examples/openclaw.yuzuha.example.json](../examples/openclaw.yuzuha.example.json) 加上 memkit 相关的部分：`plugins.slots`、`memkit` 条目（hooks 授权、超时、`persona`）、`memory-core` 停用、`tools` 全部拒绝、`userTimezone`。
3. 渠道的输出设置：
   - **关掉分块流式推送**，或者确保回复完整之后再发。柚叶的回复里有一段隐藏的 `<心声>…</心声>`，memkit 在 `message_sending` 时把它剥掉；如果回复被流式切开，剥离后剩下的部分也可能漏出去。
   - 回复按空行分成多条消息发（更像她的连发短句）：OpenClaw 的 `chunkMode: "newline"`。
4. 密钥：这个 profile 的 `.env` 里要有 `DEEPSEEK_API_KEY` 和 `JEV_API_KEY`。
5. 初始记忆：这个 profile 的记忆库从空开始。要让她记得和玩家的往事（卫非地、绮梦度假村），用 `MEMTEST_STATE=<这个 profile 的状态目录> scripts/ops/memstore_reset.sh init` 注入 `memory_seed/`（gateway 停着时做）。
6. 起 gateway 后发一条消息，看日志里有 `memkit: persona loaded`，`.trace.jsonl` 里有这一轮的召回门判断。

`mainAgent` 的两种模式：
- `"answer-only"`（推荐，也是默认）：人设卡就是完整的系统提示词，回答模型没有工具。
- `"host"`：保留 OpenClaw 自己的系统提示词（SOUL.md / AGENTS.md）、工具和技能，只追加记忆规则；`persona.file` 不生效。适合给已有的通用 bot 加记忆，不适合角色扮演，也失去了「回答模型没有工具」的保证。

### 小内存机器

一个 gateway 启动约 600 MB，稳定后约 1 GB。2 GB 内存的机器上**同一时间只跑一个 gateway**（测试和线上不要同时开，曾经因此把整台机器拖到 ssh 都连不上），每次 `openclaw …` CLI 本身也是一个几百 MB 的进程，不要和 gateway 启动、评测同时跑。8–10 秒的回合延迟通常是 OpenClaw 在换页，不是 memkit（每轮 0.1–0.5 秒，`scripts/ops/turn_timing.py` 可以拆开看）。

---

## 5. 记忆库：备份、重置、注入初始记忆

记忆库在 `<状态目录>/memkit/<agentId>/`：`user/`、`assistant/` 下的 markdown 文件（可以手工读和改，memkit 按 mtime 发现外部修改），`.meta.sqlite`（文件元数据、分段作业、召回块记账），`.embeddings.json`（向量缓存），`.trace.jsonl`（每一次判断和写入一行）。

| 脚本 | 做什么 |
|---|---|
| `scripts/ops/memstore_backup.sh <name>` | 把整个记忆库打包成 `$SNAPSHOT_DIR/<name>-<时间>.tgz`（默认 `~/.openclaw-memtest-snapshots`），只增不删 |
| `scripts/ops/memstore_reset.sh <name> [seed-dir]` | gateway 在跑就中止；先备份，再清空，把种子（默认 `personas/yuzuha/memory_seed`）拷进 `memkit/main/`，并给每个文件写一行 meta：`importance` 取种子 frontmatter 里的值（种子用 1 = 固定，不遗忘），时间取故事里的时间 |

为什么要写 meta：否则 memkit 会从 frontmatter 回填，`updated` 是故事里 2025 年的日期，按 30 天半衰期的遗忘系数，种子一开局就被埋掉了。

两个脚本的路径都可以用环境变量换：`MEMTEST_STATE`（状态目录，默认 `~/.openclaw-memtest`；指向 `~/.openclaw` 时拒绝运行）、`SNAPSHOT_DIR`、`SEED_DIR`、`MEMKIT_DIR`、`NODE_BIN`、`MEMTEST_UNIT`（systemd 单元名，默认 `memtest-gw`）。没有 systemd 的机器（macOS）上，确认 gateway 已停后加 `SKIP_UNIT_CHECK=1`。

一次测试的固定步骤：停 gateway → `memstore_reset.sh <run>` → 起 gateway → 测试 → 停 gateway → `memstore_backup.sh <run>-end`。

---

## 6. 排错

```bash
tail -3 ~/.openclaw-memtest/memkit/main/.trace.jsonl | cut -c1-200      # memkit 最近在做什么
python3 scripts/ops/trace_summary.py ~/.openclaw-memtest/memkit/main/.trace.jsonl
journalctl --user -u memtest-gw --since "-30min" --no-pager | grep -E "memkit:|error|OOM" | tail -20
```

| 现象 | 原因 | 处理 |
|---|---|---|
| trace 里 judge 是 `llm:…` | `JEV_API_KEY` 没加载（`.env` 没填或 gateway 没重启） | 填好后重启 gateway |
| trace 里 `recall_fallback` | BGE 服务连不上 | 检查 embeddings 服务；这期间用 BM25 召回 |
| 日志 `cannot stat persona file …` | `persona.file` 路径不对 | 用绝对路径，或相对状态目录的路径 |
| 她把心声发出来了 | 渠道在流式分块推送 | 关掉分块流式（§4） |
| 主 Agent 每轮报错 / 连接被拒 18990 | `baseUrl` 指向抓包代理而代理没在跑 | 起代理，或删掉 `models.providers.deepseek.baseUrl` |
| 分段卡住 / 被隔离 | 连续 3 次尝试失败进 `quarantined`，不阻塞后面的分段 | 看 trace 里的 `attempt_failed` / `quarantined`，修好后重试（DEVELOPMENT.md §2） |
| 回合 8–10 秒、无报错 | OpenClaw 换页（内存压力） | 确认只有一个 gateway 在跑 |

---

## 7. 离线评测（不需要 gateway）

```bash
ENV_FILE=~/.openclaw-memtest/.env scripts/ops/run_eval.sh jev judge v1    # 42 个场景，约 10 分钟；结果在 runs/v1/summary.json
scripts/ops/run_eval.sh llm bm25 baseline                                 # 基线：只有 BM25，没有判断
```

每个场景用一个新的记忆库逐轮注入对话，再问一个探测问题，由 DeepSeek 评分员对照标准答案判对错。端到端测试的步骤和判据见 [DEVELOPMENT.md](DEVELOPMENT.md) §6。
