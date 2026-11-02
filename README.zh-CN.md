# memkit

[English](README.md) | **简体中文**

**一个让角色没法「假装记得」的 OpenClaw 角色扮演记忆插件**，附带一个完整的示例角色：绝区零的浮波柚叶，用于微信上长期的一对一陪聊。

**核心原则。** 单次 LLM 调用能写出很流畅的话，听起来像角色记得你上周说过什么，其实是编的。在 memkit 里，角色对玩家、对两人往事的了解**只**来自召回的证据：回答模型没有工具，只看得到人设、当前对话和证据；所有记忆写入都在这一轮结束后的 ingest 步骤里完成，只有这一个写入者；每一个「过 / 不过」的决定都由判别模型（Jev）给出，生成模型（DeepSeek）只负责写。

## 工作方式

ingest → retrieve → answer 三段流程：

| 阶段 | 在 OpenClaw 里的位置 | 判别调用（Jev） | 生成调用（DeepSeek） |
|---|---|---|---|
| **ingest（写入）** | `agent_end` hook，按段落处理：每一轮先和上次记录以来的几轮比，判断*话题是否切换*（Noul）；切换了才把这一段记下来。`before_reset` / `session_end` 时把剩下的也记掉 | *值不值得记？*（对整段的 Noul；角色自己说的关于自己的具体事情也算）+ *记到谁那一侧？*（Choice：user / assistant / both / empty，同一个请求；empty = 跳过，both = 两侧各走一遍后续流程；角色说的自己的一天、喜好、计划、身边的人和承诺记到 assistant 侧，人设卡里的设定和隐藏心声不记）；然后是候选文件——BGE 找出这一侧和本段最相似的 10 个文件，再加最多 5 个：本会话最近几段写过的文件、主题/摘要的词面匹配——Jev 对每个文件单独发一个请求判断：*和正在记录的内容相关吗？*（Noul，没有「新建」选项） | 拿到相关的文件（P ≥ 0.5，按相似度从高到低，最多 3 个），对每个文件用 JSON 决定：`append` 追加新条目，`edit` 改写整个正文（两者都要准确写出文件的 uri，并重新评 importance），不动，或者在合法 uri `<side>/<principle\|event>/<name>` 下 `new` 新文件；相关文件已经包含全部内容时返回 `{"files": []}`。违反这些规则的回复会带着错误原因退回一次；`new` 的名字和已有文件撞名时，会带上那个文件退回一次 |
| **retrieve（召回）** | `before_prompt_build` hook，每一轮回答之前 | 先问*回答这一轮需不需要对话里还没有的记忆？*（Noul；state 里带着本话题已召回的文件）——不需要 → 这一轮不召回；需要 → BGE-M3 按 相似度 × (1 + importance) × 遗忘系数 从两侧召回前 10 个文件；然后每个文件**单独一个请求**——state = 整段对话，question = 这个文件：*和这段对话相关吗？*只有通过的文件才成为证据 | 看第一次召回的摘要，决定保留查询还是改写（JSON `{"rewrite": …, "query": …}`，按写入侧的摘要规则来写）；改写后再召回一次，两次结果合并。**从不决定什么能通过** |
| **answer（回答）** | 主 Agent 本身——没有工具，系统提示词是最简作答提示词或人设卡（`mainAgent: "answer-only"`） | — | —（证据以 `<memkit-recall>` 块追加在本次请求末尾） |

**时间感知。** 召回门的请求里还带着第二个 Noul：*这一轮和时间高度相关吗？*（`time_related`：某一天、某段时间、事情的先后、约好的日子、生日、上次/昨天/周末……）。触发时，消息里提到的日期由 `src/dates.ts` 里的硬规则换算成 `YYYY-MM-DD`（不调用模型；「今天」取宿主时间信封 `[Sun 2026-11-01 10:32 GMT+8]` 里的日期，没有就用宿主本地日期）：今天/明天/后天/昨天/前天，带 这/上/下 前缀的 周X/星期X/礼拜X，上/这/下个周末，X月X日/X号，明年/去年，以及明确写出的日期。主题/摘要/正文提到这些日子（或者在这些日子写下）的文件按命中数排序，最多 `timeFiles` 个排在 10 个候选的最前面；剩下的位置由 BGE 补上，Jev 的判断不变（它的 state 里多一个 `time_reference`，写着这些词换算成了哪天）。换算不出来 → 走正常流程，`time_related` 照样记进 trace。写入侧，写入模型必须给条目写完整的时间戳——`2026-11-08（周日）13:00 …`：绝对日期、星期几，对话里给了钟点就写上钟点（写入模型会拿到这一段的日期、星期和时间）；新条目带相对时间词却没有绝对日期，或者带年份的日期星期几缺失/写错，会通过写入模型的纠正轮退回一次，之后接受。**标题不带时间**：文件的主题和 uri 名里不能出现日期、月份、星期、周末、钟点或相对时间词（「周日见约定」→「六分街看片之约」），时间写进条目里。违反这条的 `new`（或改名后的主题）会带着原因退回一次；退回后仍然带时间就保留，trace 里记为 `title_time`（硬删会弄坏电影名这类专有名词）。撞名检查也会先去掉标题里的时间词再比，所以「六分街看片约定」会和更早的「周日六分街看片约定」撞上。ingest 的每一个 Jev 判断都看得到这段话是什么时候说的：gate/scope 和逐文件相关判断的 state 里带着 `spoken_at`（日期、星期、钟点）和每个用户轮次的 `time`，候选文件会显示它的写入时间（`written_at`，本地时间带星期）。

**召回门怎样算「需要记忆」。** Jev 看到的对话只是最近一段窗口（`historyChars`），所以召回门的「需要」判据除了「问到过去的事，而对话和已召回的文件里没有」之外，还单独列了两种情况：（1）用户在往回指——「之前/上次/早上/我跟你说过/我不是说了吗/你说过/你答应过/还记得吗」；（2）用户提到一个人、作品、东西、地方或约定，好像双方都知道，而对话里从没说过它是什么——对话里出现了名字、没出现它的来龙去脉，也算没说过。没有（2）时，只要名字已经出现在对话里，召回门就一直低于 0.5（long-2：「我早上不是说了吗，男主在桥上放烟花那个」只有 0.45，此前玩家刚说出电影名）。那一次的问题不在逐文件的相关判断（同样几轮里两个文件都是 0.84–0.95），那部分没有改。细节见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) §2 第 31 条。

BGE 只负责召回；没有经过 Jev 判断的东西，不会到达回答模型或写入模型。其余由代码决定：阈值、召回数量、一次写入能碰哪些文件（只能是给模型看过的那些）。文件向量缓存在 `<store>/.embeddings.json`，文件变了才重新嵌入。没有 embeddings 服务（没配置，或者请求失败）时召回退回 BM25。

**分段是持久化的作业。** `agent_end` 在调用任何模型之前，先把完整的 User/Assistant 对和宿主的 run id 存下来。话题或长度边界会封存一个不可变的分段；gate 的决定和每一侧通过校验的写入计划都存在 SQLite 里。每个计划动作有稳定的 id。另一个文件或另一侧失败时，已经成功的动作不会重新生成或重放。只有成功或明确跳过的分段才进入已提交的尾部。JSON 无效、缺少必需的更新时，分段留着等待重试。和未提交的修改冲突时，会对照文件的当前版本重新生成，不重复已完成的动作。

自动处理默认**每个分段最多尝试三次**（`ingest.maxAttempts`，包括第一次）。尝试次数和最后一次错误在重启后仍然保留。用完后分段变成 `quarantined`（隔离）：原始对话留在 `.meta.sqlite` 里，但不再调用模型，也不阻塞后面的分段。修好原因后，运维可以显式调用 `engine.retrySegment(segmentId)` 重置次数，已完成的动作和计划保留。普通的观察和 flush 不会重置次数。一次「尝试」包括其中有限次数的 JSON 格式/冲突重试，不是单个 HTTP 请求的计数。

只有同一会话的边界是串行的。不同会话可以同时调用 Jev 和 DeepSeek；共享的存储锁只覆盖短暂的状态切换和文件/数据库提交。变化了的文件快照在写回时做 rebase。hook 把 `captureTimeoutMs` 作为时长传入，从拿到会话槽位、持久化输入之后开始计时。显式传入的外部 AbortSignal 仍然保留调用方自己的截止时间。

文件正文和它的 `memkit_actions` 回执通过原子 rename 一起落盘（带文件/目录 sync）。SQLite 也记录已完成的动作；rename 和数据库提交之间如果崩溃，靠文件里的回执兜底。回执里的分段 id 能追溯到 `.meta.sqlite` 里完整的原始轮次以及说话人/run id。已有的 markdown 和旧的待处理缓冲仍然可读。每次更新文件时，已确认的旧动作 id 压缩到最近 **20** 个。没有 SQLite 回执的旧 id 也会保留，直到恢复流程确认它们：盲目截断可能丢掉一次中断写入的唯一证据。SQLite 回执本身一直保留。已有的大文件头在下次更新时压缩，不会在启动时重写整个存储。

**空闲的会话也会被记下。** 一个会话有未记录的轮次、`idleFlushMinutes`（默认 20）分钟内没有新消息，就把这些轮次作为一段记下——后面没有新话了，也就不用问 Jev 话题有没有切换。后台计时器（每个 gateway 进程一个，每分钟检查一次）对所有 agent 的存储都这样做，包括重启前留下的待处理会话，正在进行一轮对话的会话会跳过。失败的分段在上次尝试之后再过一个完整的空闲窗口才重试，所以短暂的模型故障不会耗光它的重试次数。未记录的轮次不参与召回：memkit 服务一个用户，这个用户在一个会话里聊，这些轮次本来就在上下文里。

长度边界会把下一段和上一段写过的文件关联起来。即使 BGE 的候选漏掉了这些文件，Jev 也照样能看到；相关判断的 state 会标明这是续写。ingest 的 BGE 查询**同时包含 User 和 Assistant**，各自明确标注，各占有限的比例。DeepSeek 一次 JSON 回复里每一侧最多新建三个文件；经过一轮纠正仍然无效的回复什么都不写，分段保持未完成，等下一次尝试。

**一个话题一个文件。** 只靠 BGE 的候选，经常漏掉同一个话题的那个文件（一次 354 轮的角色扮演跑下来，出现了 `我的生日`、`我的生日_2`、`我的生日_3`、`虾饺` / `虾饺请客` / `虾饺食量`……一小时 125 个文件）。所以交给 Jev 判断的候选，在 BGE 的 `ingestCandidates` 之外还有最多 `ingest.extraCandidates`（5）个：本会话最近 3 个已记录分段写过的文件，以及主题/摘要和本段有共同关键词（中文二字词 / 词，BM25）的文件，轮流取；长度续写的文件额外加上。每个被判断的候选在 `IngestResult.options` 和 trace 里记录来源（`bge` / `continuation` / `recent` / `lexical`）。`new` 的名字或主题和这一侧已有文件相同时，**不会**变成 `<name>_2`：写入模型会再被问一次，并看到那个文件，要么写进去，要么换一个能区分开的名字；如果它仍然写出那个 uri，就把条目追加到那个文件。存储本身也拒绝在已占用的 uri 上新建（抛 `Conflict`，分段的 rebase 会把它变成对那个文件的更新）。旧的 `_N` 文件仍然能读。写入模型也可以什么都不写：给了相关文件时，`{"files": []}` 表示它们已经包含这一段说的全部内容（重复的话，或者靠记忆回答的再次提问）；这一段以**没有新内容**结束（一个原因为 `nothing new` 的 `skip` 动作，trace 里 `nothingNew: true`）。没有相关文件时，空列表会被退回——通过了 gate 的内容必须有地方放。

**回复里的召回标记永远不保留。** 回答模型有时会模仿注入的证据，在自己的回复里写 `<memkit-recall>…</memkit-recall>`，有一次里面是完全编造的记忆。`message_sending` 会在所有模式下，从每一条外发消息里去掉这种块（孤立的标签按心声的规则处理）；ingest 也会在 Jev、BGE 或写入模型看到之前，把它们从 assistant 文本里去掉。

**证据是本话题的中期记忆。** 每次回答之前，Jev 判断这条消息是否开启了新话题（也就是 ingest 的分段边界），和召回并行进行；只有本话题里还没召回过的文件，才作为召回块追加（`appendContext`），块上标着这一轮的 run id。只要话题还在继续，这个块就留在对话里那一轮的位置，所以追问不需要重新召回，前缀也保持逐字不变（模型服务商的前缀缓存一直命中）。话题切换，或者这一段的对话加上它的召回块超过 `segmentChars` 时，上一段会在回答之前封存，memkit 的 context engine 把它的召回块去掉——从它组装的历史里去掉，这一轮结束后也从转录里去掉。

**主 Agent 只负责回答。** 它没有工具，系统提示词由人设（`persona.file` 里的角色卡，或者一个最简作答提示词）加上 memkit 的记忆规则组成；它对过去的一切了解都来自注入的证据。有人设时，规则是为角色写的：召回块是角色自己对对方的记忆，里面没有的就是不记得（用角色的方式表现出来，绝不编造），也绝不提记忆系统或自己是 AI。所有写入——包括「记住 / 更正 / 忘掉这个」——都在这一轮之后的 ingest 步骤里完成，所以只有一个写入者。这是强制的，不是请求：一次端到端测试里，带全套工具的 agent 背着记忆系统改写记忆文件，还从备份里把它们「恢复」回来。

两层措施保证主 Agent 没有工具：

1. **配置（权威）：** `tools.deny: ["*"]`、`tools.codeMode: false` 和 `tools.toolSearch: false`（deny 优先于所有 profile/allow；不关 code mode 会暴露 `exec`；Tool Search 默认开启，即使 `deny: ["*"]` 也会提交一个 `tool_search` 工具）。
2. **插件：** `before_prompt_build` 返回 `toolsAllow: []` 并替换系统提示词（`mainAgent: "answer-only"`，默认）。设 `mainAgent: "host"` 则保留宿主自己的提示词和工具，只追加记忆规则。

OpenClaw 自带的文件记忆（memory-core，`MEMORY.md` / `USER.md` / `memory/` 每日笔记）应当关掉，避免出现第二份、会分叉的记忆。

## 现状

本 README 描述的一切都已实现，由离线测试（`npm test`）和对测试 OpenClaw gateway 的端到端测试覆盖（docs/DEVELOPMENT.md §7，第 9/10 次：20/20 正确，中期记忆按设计保留 / 丢弃）。最后一次在 42 个场景的标准评测集上的离线评测（v9a，真 Jev + DeepSeek + BGE）得分 90.5%；那次早于召回门、中期记忆和查询改写，之后还没有重跑。有意留下的未解决问题：

- **单纯的再次提问仍然会通过 gate。** 用户只是提问、助手靠记忆回答的一段，会被判为值得记；现在写入模型可以对它返回 `{"files": []}`（没有新内容），而不是追加一条「又问了一次」，但它会不会这么做由写入模型决定，还没有在真实角色扮演数据上测过。
- **查询改写（「补查」）还没有体现出价值。** 存储量小时第一次召回就已经包含所有文件，改写会被跳过。需要在大存储量的真实角色扮演数据上验证。
- **压缩和长期记忆还没有适配角色扮演**：两者都是后续工作，长度/证据预算的调优也是。
- **回合延迟**：在小内存（2 GB）VPS 上主要来自 OpenClaw 本身（换页时某些回合 8–10 秒）；memkit 每轮 0.1–0.5 秒，另加 Jev / BGE / DeepSeek 的往返时间。

## 目录结构

```
index.ts               OpenClaw 插件入口（hooks、记忆能力、context engine；不注册任何工具）
openclaw.plugin.json   清单（kind: ["memory", "context-engine"]，空的工具契约，配置 schema）
src/engine.ts          ingest + retrieve 流程、话题边界、中期召回块
src/dates.ts           基于规则的日期换算、按日期搜索、写入侧日期检查
src/context.ts         context engine：从历史里去掉已结束话题的召回块，改写转录
src/turns.ts           各个 hook 共享的单轮状态（提示词、召回块、进行中标记）
src/store.ts           markdown 文件存储：<root>/<user|assistant>/<principle|event>/<topic>.md
src/meta.ts            SQLite 元数据：文件 importance/时间、分段作业、召回块、每轮决定
src/judge.ts           Jev 客户端 + 契约相同的 DeepSeek 模拟判断
src/llm.ts             OpenAI 兼容的对话客户端（DeepSeek）
src/embed.ts           BGE-M3 客户端 + 每个存储的向量缓存
src/view.ts            有长度上限的文件视图：主题 + 摘要 + 最新条目
src/text.ts            分词（中文一字 + 二字）和 BM25（兜底召回）
src/prompts.ts         提示词、问题措辞、召回块标记
src/config.ts          插件配置 + 环境变量 → MemoryEngine
src/persona.ts         人设文件加载（按 mtime 重读、兜底）+ 回答系统提示词的拼装
src/monologue.ts       从外发消息里去掉角色的隐藏心声块（转录保留），以及模型自己写出的召回标记（外发 + ingest）
scripts/eval_gold.ts   离线实验框架（注入 → 探测 → 评分）
scripts/request_log_proxy.mjs  调试代理，记录宿主发给模型的请求
scripts/ops/           对测试 gateway 的端到端脚本、trace/日志检查、记忆库备份/重置
tests/                 用脚本化判断/LLM 的离线测试（`npm test`）
data/goldset_v2.json   离线评测集（42 个 注入 → 探测 场景）
examples/              人设卡示例、OpenClaw 配置模板（测试 gateway、微信上的柚叶）
personas/yuzuha/       柚叶角色包（见下文）
docs/                  DEPLOY.md（部署指南）、DEVELOPMENT.md（设计记录、测试结果）
```

文档：

- [docs/DEPLOY.md](docs/DEPLOY.md)——外部服务（Jev、BGE-M3、DeepSeek）、测试 gateway、柚叶接入微信、记忆库备份/重置、排错。
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)——按时间顺序的设计决定（每一步为什么这样做）、测试方法、结果记录。

记忆文件是带 `key: <json>` frontmatter 的普通 markdown——可以手工阅读和编辑，存储按 mtime 发现外部修改。默认根目录：`<OpenClaw 状态目录>/memkit/<agentId>/`，旁边是 JSONL 格式的决策轨迹 `.trace.jsonl`。

## 安装（OpenClaw ≥ 2026.10.7）

```bash
openclaw plugins install --link /path/to/memkit --force --accept-capabilities
```

安装程序会把 memkit 选为 `plugins.slots.memory`。还要把它选为 context engine（`"plugins": { "slots": { "contextEngine": "memkit" } }`）：正是它让召回的证据不进入之后几轮的历史——没有它，每次请求注入的证据会在之后每一轮作为历史重放。然后授予 hook 权限（非内置插件挂 `before_prompt_build` / `agent_end` 需要授权），给 hook 足够的时间，关掉自带记忆，拿走 agent 的工具：

```json
{
  "tools": { "profile": "minimal", "deny": ["*"], "codeMode": false, "toolSearch": false },
  "plugins": {
    "entries": {
      "memory-core": { "enabled": false },
      "memkit": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true,
          "timeouts": { "before_prompt_build": 30000, "agent_end": 60000 }
        },
        "config": { "recallTimeoutMs": 25000, "captureTimeoutMs": 50000 }
      }
    }
  }
}
```

密钥放在状态目录的 `.env` 里（见 `.env.example`）：

- `DEEPSEEK_API_KEY`——生成模型（默认模型 `deepseek-flash`，`reasoning_effort: low`）
- `JEV_API_KEY`——Jev。为空时，判断退回由 DeepSeek 模拟同一套 Noul/Choice 契约（`judge.backend: "auto"`）；设 `judge.backend: "jev"` 则强制要求 Jev。

注意：一次性的 `openclaw agent exec` 会在运行结束 5 秒后回收插件，打断 `agent_end` 里的写入；请用常驻的 Gateway（`openclaw agent …`）。

## 配置

全部可选；schema 见 `openclaw.plugin.json`。

| 键 | 默认值 | 含义 |
|---|---|---|
| `mainAgent` | `answer-only` | `host` 保留宿主的提示词和工具 |
| `answerPrompt` | 内置 | answer-only 模式的系统提示词（记忆规则总是追加在后面）；能读到的 `persona.file` 优先 |
| `persona.file` | — | markdown 人设卡（角色扮演的角色），作为 answer-only 模式的系统提示词；可以是绝对路径、`~/…` 或相对 OpenClaw 状态目录的路径；mtime/大小变化时重读（不用重启）。不存在/读不了 → 警告一次，然后用上次加载的版本，没有就用 `answerPrompt`，再没有就用内置的。`mainAgent: "host"` 时不生效。示例：`examples/persona.example.md` |
| `persona.rules` | `auto` | 追加在人设后面的记忆规则：`auto` = 人设文件生效时用角色扮演规则，否则用助手规则；`roleplay` / `assistant` 强制其中一种。召回块的标题跟随同样的选择 |
| `persona.monologue.strip` | `auto` | 从发往渠道的消息里去掉角色的隐藏心声块（`message_sending` hook）：`auto` = 角色扮演规则生效时去掉；`always` / `never`。转录保留这个块（下一轮的历史和 ingest 能看到角色的情绪）；整条回复都是心声时不发送 |
| `persona.monologue.open` / `close` | `<心声>` / `</心声>` | 心声块的标签，以人设卡的定义为准（容忍全角尖括号和标签内的空格）。只有开标签时去掉它所在的段落；只有闭标签时去掉它之前的全部内容。在 ingest 的提示词里，这个块保留但标注为「没说出口的心声」，让写入模型记录情绪，而不是把念头当成说过的话 |
| `persona.vars` | `{}` | 人设卡里 `{{name}}` 占位符的值（例如 `{"player_name": "哲"}`）；卡里的 HTML 注释在使用前去掉；没填的占位符警告一次 |
| `embed.baseUrl` / `apiKey` / `apiKeyFile` | — | BGE-M3 服务（OpenAI 兼容的 `/v1/embeddings`；环境变量 `MEMKIT_EMBED_BASE_URL`、`MEMKIT_EMBED_API_KEY`）。地址和 key 都没配，或者 `embed.enabled: false` → BM25 召回；只配了 key 没配地址时用 `http://127.0.0.1:8000` |
| `embed.maxChars` | 6000 | 每条输入嵌入的字符数（BGE-M3 上限 8,192 token） |
| `retrieve.recallGate` / `recallAt` | true / 0.5 | 召回前先问 Jev 是否需要新记忆，以及召回所需的 P |
| `retrieve.timeAware` / `timeAt` | true / 0.5 | 和召回门一起问 `time_related`（同一个请求），以及换算并搜索消息里日期所需的 P |
| `retrieve.timeFiles` | 3 | 最多这么多个日期匹配的文件排在 `recall` 候选最前面（其余由 BGE 补上） |
| `retrieve.queryRewrite` | true | DeepSeek 看过第一次召回后可以改写召回查询 |
| `retrieve.recall` | 10 | 每轮召回的文件数（按 相似度 × (1 + importance) × 遗忘系数 排序），每个文件单独判断 |
| `retrieve.halfLifeDays` | 30 | 遗忘：这么久没更新的文件在召回排序里只算一半；importance 为 1 的文件固定（不遗忘） |
| `retrieve.k` / `minScore` | 10 / 0.5 | 允许进入证据的文件数，以及一个文件所需的 P(相关) |
| `retrieve.queryChars` | 1500 | 召回查询：当前消息 + 最近几轮 |
| `ingest.ingestCandidates` | 10 | BGE 找出的这一侧最相似的文件数（纯相似度），每个由 Jev 单独判断：和正在记录的内容相关吗？ |
| `ingest.extraCandidates` | 5 | 在此之外最多再加的候选数：本会话最近 3 个已记录分段写过的文件，以及主题/摘要的词面（BM25、关键词）匹配，轮流取。长度续写自己的文件额外加上。0 = 只用 BGE |
| `ingest.relatedAt` / `writeFiles` | 0.5 / 3 | 一个文件到达写入模型所需的 P(相关)，以及最多几个（相似度高的优先） |
| `ingest.topicShiftAt` | 0.5 | 记录待处理分段所需的 P(话题切换) |
| `ingest.segmentChars` | 6000 | 待处理分段超过这个长度就直接记录，不等话题切换（没有轮数上限） |
| `idleFlushMinutes` | 20 | 安静这么多分钟后，记录会话里未记录的轮次（0 = 关闭） |
| `ingest.maxAttempts` | 3 | 每个分段的自动处理次数，用完后隔离，不阻塞后面的分段 |
| `ingest.jevChars` | 11000 | 一个 Jev 请求能带的字符数（约 8.8K token）；相关判断里的候选文件拿到 state 剩下的部分，整段满载时约 4,500 |
| `retrieve.historyChars` / `messageChars` | 2000 / 1000 | Jev state 里的对话和当前消息（Jev 的窗口约 10K token） |
| `retrieve.fileChars` | 6000 | 召回判断里的一个文件：摘要 + 最新条目（和 BGE 的输入相同） |
| `retrieve.evidenceChars` | 2000 | 一轮召回块里的证据（本话题的召回块计入 `segmentChars`） |
| `retrieve.retrieval` | `judge` | `bm25` = 只做词面召回，不做判断（基线） |
| `ingest.gateAt` | 0.5 | P(值得记) 低于这个值的轮次跳过 |
| `judge.model` | `jev-latest` | 阈值调好后可以固定版本，例如 `jev-1.14.0` |

## 柚叶角色包

`personas/yuzuha/` 是一套完整、测试过的角色扮演配置：

| 路径 | 内容 |
|---|---|
| `card.md` | 人设卡——即 `persona.file`；占位符 `{{player_name}}`、`{{sibling}}` |
| `CARD_DESIGN.md` | 卡为什么这样写，每一条都标了官方出处 |
| `memory_seed/` | 15 个记忆文件，是两人的官方往事，在第一次聊天之前注入空的记忆库（`scripts/ops/memstore_reset.sh`） |
| `story/` | 剧情节拍：这些天里她会主动提起的事 |
| `eval/` | 探针对话、聊天/探针运行脚本，以及三轮测试的结果 |
| `tools/` | 从公开的游戏数据转储和 fandom wiki 重建官方参考语料（`corpus/`，不随仓库发布）的脚本 |
| `INDEX.md` | 语料包含什么、怎样构建 |

人设卡所依据的游戏原文语料**没有**放进仓库（那是 HoYoverse 拥有版权的文本）；`tools/README.md` 说明了怎样在本地重建。部署她：[docs/DEPLOY.md §4](docs/DEPLOY.md)。

想做自己的角色：复制 `examples/persona.example.md`，写这个角色是谁、怎么说话（不要写关于玩家的事实——那些来自记忆），然后把 `persona.file` 指向它。

## 测试

```bash
npm test                                   # 离线，不联网，脚本化的判断/LLM
node scripts/eval_gold.ts --data data/goldset_v2.json --judge jev --retrieval judge --concurrency 4
node scripts/eval_gold.ts --data data/goldset_v2.json --judge llm --retrieval bm25    # 基线
```

对运行中 gateway 的端到端测试步骤：docs/DEVELOPMENT.md §6 和 `scripts/ops/memkit-e2e-*.sh` 脚本。

## 许可证

代码和文档：[MIT](LICENSE)。

浮波柚叶、《绝区零》及其世界中的一切归 HoYoverse / 米哈游所有。`personas/yuzuha/` 中的文件是非商业的同人作品，不在 MIT 许可证范围内，也不附带任何 HoYoverse 知识产权的使用权。本项目与 HoYoverse 无关，也未获其认可。
