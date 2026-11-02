# memkit 开发文档

记录 memkit 的设计、到目前为止的改动和测试方法，按时间顺序写成，后面的决定覆盖前面的。
用户向的安装说明见 [README.md](../README.md)，部署见 [DEPLOY.md](DEPLOY.md)。文中「服务器」指开发时跑测试 gateway 的一台 2 GB 内存的 VPS。

最后更新：2026-10-29

---

## 1. 这是什么

memkit 是一个 **OpenClaw 记忆插件**（占用 `plugins.slots.memory`），最早是从作者之前一个「教派蒙理财」的游戏 agent 里
把 ingest → retrieve → answer 的记忆机理抽出来做成通用的；之后为绝区零浮波柚叶的微信陪聊做了角色扮演适配（第 27 条起）。
下表是最初的设计，后面的条目逐步替换了它。

| 阶段 | 在 OpenClaw 里的位置 | 用什么模型 | 做什么 |
|---|---|---|---|
| **retrieve** | `before_prompt_build` hook，每轮开始前 | **只用 Jev** | 一个检索 agent：每轮一个 Jev 请求，Choice 选工具（open / answer / empty），每个候选文件一个 Noul 当参数（要不要打开），多轮 = 多跳 |
| **answer** | 主 Agent 本身 | DeepSeek（OpenClaw 的主模型） | 只负责作答：**没有任何工具**，系统提示词被替换成最简作答提示词，证据追加在本次请求末尾 |
| **ingest** | `agent_end` hook，每轮结束后 | Jev 判别 + DeepSeek 生成 | 一个 Jev 请求同时问「值不值得记」(Noul) 和「并入哪个已有文件」(Choice)；值得记才让 DeepSeek 选 new/append/rewrite/delete/skip 并写正文和 summary |

**唯一写入者是 ingest。** 主 Agent 不能写记忆（也没有工具能写），用户说「记住/更正/忘掉」时主 Agent 只确认，由 ingest 执行。

## 2. 关键设计决定（及原因）

按时间顺序，后面的覆盖前面的：

1. **（已被第 12 条替代）Jev 替代 embedding。** Jev 是纯判别模型（state + 若干命名问题，一次请求并行作答，返回校准概率）。
   检索不再有向量：候选文件直接拿去问 Jev。存储量大时才用 BM25 粗筛（CJK 一字+二字切词），只为把对的文件放进候选，不负责相关性判断。
2. **核心直接用 TypeScript 写进插件**（不起 Python 常驻进程）——服务器只有 1.9G 内存。插件零第三方依赖。
3. **DeepSeek 用 `deepseek-flash` + `reasoning_effort: low`。** `deepseek-chat` 已不存在；思考模式下不支持 `tool_choice: "required"`，所以 ingest 用 `auto` + 没调工具时追问一次。推理 token 计入 `max_tokens`，各处上限都留了余量。
4. **主 Agent 不给写工具 → 再到完全不给任何工具。** 第一次端到端时，主 Agent 用通用文件/exec 工具绕过 memkit，从备份包和 git 历史"恢复"记忆、直接改 memkit 文件。光靠提示词约束不住。现在：
   - 配置层（权威）：`tools: { profile: "minimal", deny: ["*"], codeMode: false, toolSearch: false }`。`toolSearch` 默认开启，`deny:["*"]` 拦不住它，必须显式关。
   - 插件层：`before_prompt_build` 返回 `toolsAllow: []` 并用 `systemPrompt` 整个替换主 Agent 的系统提示词（`mainAgent: "answer-only"`，默认）。`mainAgent: "host"` 保留宿主的提示词和工具，只追加记忆规则。
   - 已用记录代理抓到真实请求确认：发给 DeepSeek 的请求里没有 `tools` 字段，系统提示词只有我们那份 + OpenClaw 追加的一行模型身份说明。
5. **OpenClaw 自带记忆删掉。** memory-core 停用，`MEMORY.md` / `USER.md` / `memory/` 删除，AGENTS.md 的记忆段落改成 memkit 说明（answer-only 模式下 AGENTS.md 其实已不进提示词）。
6. **ingest gate 只看用户的话**，不看助手回复（助手一句「已经记下了」曾让 gate 打 0 分）。gate 的放行条件包括「要求记住/更正/忘掉」，否则「忘掉 X」会被直接跳过。
7. **（已被第 12 条替代）检索 = 纯 Jev 的 agent，看完整对话。** 原先是「BM25 + Jev 相关性 + Jev 路由 + DeepSeek 写下一跳检索词」。现在检索里没有 DeepSeek、没有自由文本检索词：
   - state：`background`（记忆系统怎么组织的）、`conversation`（完整历史，超 `historyChars` 从最早截）、`current_message`、`opened_memories`（已打开文件全文）、`round` / `rounds_left`。
   - 问题：`tool`（Choice: open/answer/empty）+ `open_<i>`（每个未打开候选一个 Noul），同一个请求里问（Jev 文档推荐的 speculative fan-out）。
   - 代码保证工具和参数一致：answer 但什么都没打开 → 当 open；open 但没有文件够分 → answer/empty。
   - 多跳：打开的文件全文进入下一轮 state，顺着「A 属于 B」打开 B；BM25 粗筛的查询文本也包含已打开文件的正文。
8. **证据追加在本次请求末尾**（`appendContext`），系统提示词保持逐字不变 → 前缀缓存能命中。
9. **证据只在本次请求可见：memkit 同时是 context engine**（`kind: ["memory", "context-engine"]`，`plugins.slots.contextEngine = "memkit"`，实现在 `src/context.ts`）。
   证据仍走 `appendContext`，OpenClaw 会把它冻结进用户消息的 `__openclaw.modelPromptProjection` 并在后续轮次重放；context engine 堵住两条重放路径：
   - `assemble()`：给模型的历史是**副本**，去掉每条历史用户消息 `content` 和 projection 里的 `<memkit-recall>` 块。声明了 `before-current-turn-entry-v1` 围栏后，assemble 只拿到本轮之前的历史（围栏失效时整轮走 legacy、根本不调 assemble），本轮消息由宿主之后追加，自带本轮证据 → **每个请求恰好一个块**。
   - `maintain()`（每轮被接受后、bootstrap 时、压缩前后）：扫活动分支，把所有带检索块的用户条目用 OpenClaw 的 `rewriteTranscriptEntries`（建分支 + 重新追加）改写成干净版本。所以不经过本引擎读活动分支的路径——**legacy 降级重放、内置压缩器、以后换引擎**——看到的也是干净历史。扫分支而不是记账，被取消的轮次、重启前的轮次、启用引擎前的旧会话都会在下一次 maintain 时被清掉。原始条目只留在废弃分支上（数据库里不是物理删除）。
   - **有轮次在跑时不改写**（进程级 in-flight 标记，`before_prompt_build` 置位、该 run 最终成功的 `agent_end` 清除）：改写会替换正在进行的那轮的 admitted 条目、破坏围栏（实测溢出压缩时报过 "admission is no longer a visible message"）。
   - `commitTurn`：只按 `advancementKey` 原子、幂等地记账——SQLite（`<state>/memkit/_context/committed.sqlite`，WAL），`advancementKey` 是主键，一条 `INSERT OR IGNORE` 由数据库判定 committed/duplicate，所以多个插件实例（热重载、每次注册新建）、多个进程共用同一文件也不会丢记录或重复提交；**不写长期记忆**，写入仍只在 `agent_end`。
   - 压缩：`ownsCompaction: false`，`compact()` 调 `delegateCompactionToRuntime()`。
10. **一轮只检索一次，重试复用；用户原话首次绑定后不变**（`src/turns.ts` 的 `TurnState`）。 OpenClaw 重试一轮（临时 5xx、溢出压缩后）会重新触发 `before_prompt_build`，提示词变成合成的 "Continue the current task…"。按 runId 绑定第一次 attempt 的原话、缓存本轮检索块并复用；首次检索失败时重试会重新检索，但用的仍是原话，ingest 也用原话。否则会拿合成提示去检索（实测证据丢失、模型答「没有记录」），ingest 也会把它当用户原话。缓存是进程级（`globalThis`），因为重试那次可能由新注册的插件实例处理。
12. **召回改用 BGE-M3，放行仍由 Jev 逐个文件判断**（2026-10-27，替代第 1、7 条）。
   - **检索**：召回查询 = 当前这句话 + 最近的对话（共 `queryChars`=1500 字，当前句在前，代词才能落到对的文件），BGE 取余弦最高的 `recall`=10 个文件；
     然后**每个文件单独一次 Jev 请求**（并行）：state（Statement）= `background` + `conversation`（完整历史，超 `historyChars` 从最早截）+ `current_message`，
     question = 这个文件（topic/summary/times/正文前 `bodyChars`=4000 字），Noul「这个文件和对话有没有关系、能不能帮助回应」。P ≥ `minScore`=0.5 才进证据。
   - **写入**：先单独问 gate（state 只有用户原话）；过了 gate 才用用户原话做 BGE 召回 `ingestCandidates`=6 个文件，再逐个问 Jev「是不是同一件事（该并入/更正/删除它）」，
     P ≥ `sameTopicAt`=0.5 的才给 DeepSeek 看（最高的那个给全文作目标，其余给摘要），写操作也只能碰这些文件。
   - **BGE 长度上限**：服务端 8,192 token，超出会静默截断。我们在发送前按字符截断（`embed.maxChars`=6000，中文约 1 字 1 token），被嵌入的始终是文件开头的 topic + summary + 正文。
   - **向量缓存**：`<store>/.embeddings.json`，按 uri + 被嵌入文本的 sha1 缓存，文件内容变了（追加会改 summary 和正文）才重嵌，删掉的文件会被清掉。正常一轮只嵌入 1 条查询。
   - **降级**：没有 token、`embed.enabled: false` 或 BGE 请求失败时，召回退回 BM25（轨迹里记 `recall_fallback`），Jev 判断不变，不会让这一轮失败。
   - **去掉了 open/answer/empty 路由和多跳**：新流程是一次召回 + 逐个判断。代价是「A 属于 B → 再去找 B」这种多跳没有了（只能靠 B 自己也被 BGE 召回到前 10）。
   - **服务**：任意 OpenAI 兼容的 BGE-M3 `/v1/embeddings` 服务（开发时是实验室 GPU 上的服务，经反向 ssh 隧道到服务器的 `127.0.0.1:8000`），token 从文件读取，不复制进配置。

13. **写入的所有判断都归 Jev，DeepSeek 只负责写**（2026-10-28）。
   - Jev 一次请求问两题：`worth_storing`（值不值得记；判据里明确包括「想法的状态」——只是假设/玩笑/随口一想/没定/已否决/撤回/是别人的事）和 `only_asking`（这轮是不是只在提问/求助/寒暄）。`gate = min(worth, 1 − only_asking)` ≥ `gateAt` 才写。
   - 记哪个文件：BGE 召回后逐个问 Jev「是不是同一件事」，最高且 ≥ `sameTopicAt` 的就是**目标文件**。DeepSeek 只看到这一个文件。
   - DeepSeek 没有 `memory_skip`；有目标文件时可用 append / rewrite / delete（**一律作用在目标文件上，工具里没有 uri 参数**——之前让模型自己抄 uri，它会抄成「【event/x】」「memory://event/x」，被校验拒掉、更新静默丢失，这是 v6 那次知识更新掉到 12/16 的原因），以及给同一轮里无关的事用 memory_new；没有目标文件时只能 memory_new。
   - 写入时把用户**之前说的话**（最近 3 句，只取用户的、不取助手的）一并给 Jev 和 DeepSeek，用来理解「那是他自己的事儿」「算了，先放一放」指的是什么。DeepSeek 只写用户这轮自己说出的内容。

14. **文件元数据、加权召回、Jev 单选落点、JSON 写入**（2026-10-28，替代第 12 条的召回排序和第 13 条的落点/写法）。
   - **元数据**：`<store>/.meta.sqlite`（`src/meta.ts`），每个记忆文件一行：`created_at`、`updated_at`（毫秒）、`importance`（0~1，CHECK 约束）。新建文件默认 0.5。重要性**不落盘到 markdown**。没有行的文件（旧文件、手工建的）第一次被看到时补一行（时间取 frontmatter，重要性 0.5），文件删掉了行也会清掉。
   - **检索召回排序**：`rank = max(0, 相似度) × (1 + importance) × 0.5^(距上次更新的天数 / halfLifeDays)`，按 rank 取 top `recall`=10，之后仍然逐个文件问 Jev、P ≥ `minScore` 才放行。`halfLifeDays` 默认 30（30 天没更新的文件权重减半）。BM25 降级时同样加权。轨迹里每个召回文件记 `similarity / importance / forgetting / rank / p`。
   - **写入去掉 `only_asking`**：memkit 跑的是角色扮演，用户在和角色说话，不存在"只是在提问"的情况。gate 只问 `worth_storing`。
   - **落点由 Jev 一道 choice 题决定**：只按相似度（不加重要性和遗忘）召回最相近的 `ingestCandidates`=6 个文件，和「新建文件」一起作为选项，**一次请求**问 Jev 写到哪。按概率排序，最高的是目标；第二名与第一名相差 ≤ `pairWithin`=0.2 时也选上——所以可能是一个文件、两个文件，或一个文件 + 新建。库是空的时直接新建，不问。
   - **DeepSeek 只写，按 JSON 输出**：给它选中的文件（标号 A/B）各自的 importance、topic、summary、body，它输出 `{"updates":{"A":{mode, importance, topic, summary, add|body}}, "new":[{type, topic, summary, body}]}`。`updates` 以标号为键，同一个文件只可能有一个版本（最初用数组，DeepSeek 偶尔给同一个文件出两项，v6b 里出现过一次）。importance 用来更新元数据；新建文件重要性固定 0.5。
     - 每个文件由 DeepSeek 按实际情况选写法：`append`（默认）——旧条目都还成立，只写这轮新增的条目，代码接在原正文后面，DeepSeek 不重抄旧条目；`edit`——旧条目里有内容因这轮的话要改（值变了、状态变了、记错了、要忘掉一部分），写出改好后的完整正文。
     - 没有 delete——Jev 判定相关的文件没有理由整份删掉。写入只能落到 Jev 选中的文件：标号不认识的、没要求新建却新建的都会被拒并记进 actions。轨迹里保存 DeepSeek 的完整原始回复。
   - 更新改了 topic 时 uri 不变（文件不改名）。
   - 写入解析的容错（都是看轨迹里的完整原始回复查出来的）：body / add 也接受字符串数组（DeepSeek 时不时这么写；之前直接拒掉，整条新记忆丢失，「这个月添了两万五千摩拉」两次都因此答不出）；括号放错把 `"new"` 套进 `updates` 里时照样当新建列表处理。
   - 离线评测（真 Jev，42 个场景，append/edit 版本）：v7c 97.6%、v7d 97.6%。知识更新 16/16 和 16/16；两次失败都是回答漏了一个要点，记忆本身是对的。写入里 edit 约 26 次、append 约 7 次，写入失败 0 次（v7c 的那 1 次就是上面说的括号问题，内容没丢）。每轮写入约 1.6 s。
   - 离线评测（真 Jev，42 个场景，2026-10-28，整份重写版本）：v6a 92.9%（39/42）、v6b **100%**。v6a 的三题失败里，两题记忆写对了、是回答措辞（多推断一句 / 漏说一个要点），一题是开头那句自嘲在 gate 拿了 0.48，差一点没过 0.5，背景没记下来。落点判断很干脆：正确的文件拿到 0.93~0.96。两轮共 264 次写入，"两个目标"（第二名在 0.2 以内）一次也没触发——现有场景每轮只讲一件事，这条分支只有单测覆盖。平均检索 0.25 s，每轮写入 1.6~1.7 s。

15. **写入的并发安全、新文件不合并、各处长度预算**（2026-10-28）。
   - **没有工具了**：DeepSeek 拿不到任何工具，只输出 JSON。`new` 只有在 Jev 选了「新建」时才会被接受；否则整项被拒（`no new file was asked for`）。新文件**永远是独立的文件**：topic 渲染出的 uri 已被占用时改用 `<slug>_2`，不会再像以前那样合并进一个 Jev 没选中的旧文件（这是之前留下的一个绕过口）。
   - **读目标 → Jev → DeepSeek → 写回是一个临界区**：同一个记忆库的写入在进程内用进程级锁排队（插件重注册后的新引擎也共用这把锁），后一轮读到的是前一轮写完的文件。跨进程靠版本号：`.meta.sqlite` 每个文件有 `version`，每次写入 +1；写回时在 `BEGIN IMMEDIATE` 事务里核对读取时的版本、写文件、更新元数据，版本变了就是 Conflict，这一轮从头重来（最多 3 次）。每个记忆库在进程内只有一个 SQLite 连接，避免同进程两个连接在事务期间互相同步阻塞。
   - **有界视图 = 主题 + 当前 summary + 最新的条目**（`src/view.ts`）：写入是往正文末尾追加的，从头截断会恰好丢掉最新的条目。BGE 输入、Jev 判断、落点选项、注入的证据都用这个视图，太长时省略的是**最早**的条目，并注明省略了几条。
   - **预算**（字符）：
     - BGE 每条输入 6000（`embed.maxChars`）。XLM-R 的 sentencepiece 切出的 token 数不会超过字符数，6000 字 ≤ 8192 token；服务端若仍在 `truncated` 里报告截断，就把那条截短到 3/4 重新嵌入（最多 4 次），被嵌入的始终是我们选定的完整文本。
     - Jev 检索判断：文件视图 `fileChars`=6000（和 BGE 一样长）+ 对话 `historyChars`=2000 + 当前消息 `messageChars`=1000，一个请求约 9.5K 字符以内。实测这类文本约 0.8 token/字（6000 字 = 4841 token），在 Jev 的 10K 上下文内。之前 `historyChars` 是 12000，在线上长对话里其实可能超出 Jev 的上限。
     - Jev 写入：用户原话 2000、之前的话每句 400；落点选项共用 `placeChars`=6000（6 个候选时每个 1000）。
     - 注入的证据：总预算 `evidenceChars`=8000，按 Jev 的排序把剩余预算平分给后面的文件，每个文件给摘要 + 最新条目，历次时间只写最后一次和总次数；一个文件都放不下时注明「另有 N 个相关文件未列出」。
   - 回归评测（真 Jev，v8a）：95.2%（40/42），知识更新 16/16、检索 10/10；写入 132 次失败 0 次，未发生冲突重试。两题失败是老面孔：idk2_nearmiss_2 回答多断言了一句，ss2_thirdparty_2 评分员返回空结果。评测场景都很短，这次的长度预算和并发保护只由单测覆盖。
   - **还没做**：文件继续变长后的分块；DeepSeek 的 edit 仍然看到并重写整份正文（DeepSeek 上下文很大，暂时不是问题）。

16. **记忆分 User / Assistant 两侧；写回时核对文件内容本身**（2026-10-28）。
   - **目录多一级**：uri = `<scope>/<type>/<slug>`，scope ∈ `user`（关于用户：他的事实、偏好、计划、经历、钱财，他讲的别人/外界的事）、`assistant`（关于助手/角色自己：设定、经历、它答应过的事、用户要它以后怎么做）。scope 取自路径，不写进文件。这个分类以后会有更多作用，现在只用来分流读写。
   - **写入**：gate 和「这是谁的记忆」在**同一个 Jev 请求**里问（Noul + Choice：user / assistant / both / empty）。empty 不写（第二道门）。both 就把「召回 → Jev 选落点 → DeepSeek 写」**两侧各走一遍**：候选只来自那一侧，DeepSeek 被告知这次写哪一侧、以谁为主语、另一侧会单独写，所以两侧写出的是各自不同的文件。
   - **召回**：先问 Jev 一道 Choice「回应这句话要查哪一边」（state 同检索判断）。empty = 这轮不需要记忆，直接不召回（不调 BGE、不逐文件判断，证据写「本轮不需要检索记忆」）；user / assistant 只在那一侧召回；both（以及拿不准）两侧一起召回、统一排序。代价是检索多一次串行的 Jev 请求（约 0.2 s）。
   - **旧库迁移**：没有 scope 这一级的旧文件（`<root>/<type>/x.md`）第一次读取时移到 `user/` 下，`.meta.sqlite` 里的行也改成 `user/` 前缀，重要性和时间保留。
   - **跨进程读取窗口**：第 15 条用版本号核对，但正文（`store.all()`）和版本号（`meta.sync()`）是分开读的，中间被别的进程写入就会漏判。现在去掉版本号，写回时在同一个写事务（`BEGIN IMMEDIATE`，跨进程互斥）里**重新从磁盘读目标文件**，与当初读到并给 DeepSeek 看的内容逐字比对（两边都经 parse → serialize 规整后取 sha1），不一致就是 Conflict，这一侧从头重来。没有「先读这个、后读那个」的窗口，手工改文件也能发现。
   - 本轮只跑了单测（57 个），没有实测。

17. **按「段」记录，而不是逐轮记录**（2026-10-28）。逐轮写入时，连续几轮讨论同一件事会被反复路由、改写，既重复消耗 token，又容易在中间状态留下重复文件。
   - **每个会话一个缓冲区**（`.meta.sqlite` 的 `segments` 表，按 sessionKey）：`pending` 是上次记录之后、还没写进记忆的轮次，`tail` 是上次记录的最后 `tailTurns`=3 轮（只用来理解指代）。不靠宿主 transcript 里的位置定位，因为压缩和清理会改写它；进程重启后仍在。
   - **每个用户轮次**（`agent_end`）调 `observe()`：有 pending 时先问 Jev 一道 Noul「当前这条消息是不是换了新话题」。state 按顺序是 `recorded_before`（已记录的前文）→ `mark`（醒目的分隔线「以上内容已经记录过；以下是上次记录之后的对话」）→ `since_last_record` → `current_user_message`。P ≥ `topicShiftAt`=0.5 就把 pending 这一段（上次记录到**上一条助手回复**为止）送进写入流程；当前这轮成为新一段的第一轮。没换话题就把当前这轮加进 pending，不写。
   - **段的上限**：pending 超过 `segmentTurns`=16 轮或 `segmentChars`=4000 字（助手回复按 800 字计）时不问 Jev、直接记录，保证 Jev 的输入有界。
   - **收尾**：`before_reset`、`session_end`（会话换了 key 才算，压缩只换 id 不算）调 `flush()` 记录剩下的 pending。离线评测在每个场景最后 flush。没有新消息也没有重置的会话，最后一段要等下一条消息来了才记录（之前那段在本会话的聊天记录里仍然可见）。
   - **记录失败**时 pending 保留、当前轮照样加入，下一次换话题或 flush 时再试。
   - **写入流程本身**（`ingestSegment()`）照旧，只是对象从「一轮」变成「一段」：gate + 类别（user/assistant/both/empty）一次请求，state 是这段对话的用户和助手原话（`conversation`）加已记录的前文（`earlier_conversation`）；每侧召回 → Jev 选落点 → DeepSeek 写。DeepSeek 看到的是整段对话，以这段对话**最后的结论**为准，过程中被推翻的写成「原先…后来改为…」。
   - **落点不再限 top1/top2**：所有与第一名相差 ≤ `pickWithin`=0.2 的选项都选上（可能是多个文件，也可能是若干文件 + 新建），标号 A、B、C…。
   - **Jev 请求预算** `jevChars`=9000 字：落点选项分到的是 state 用剩下的部分（至少 1800 字），取代了固定的 `placeChars`。
   - 之前「gate 只看用户的话、不看助手回复」的做法改了：一段对话里助手的承诺本身就是助手侧要记的内容。
   - 本轮只跑了单测（62 个），没有实测。

18. **段落提交恢复、待整理内容可见性、Assistant 路由**（2026-10-29；覆盖第 17 条的接收和失败处理顺序）。
   - `observe()` 先保存完整 User/Assistant 原话和 `runId`，再判断边界；同一个 session/runId 重复回调不会重复入队。正文只在送入模型时裁剪，原始来源留在 SQLite。
   - `segments` 保存开放段落；封存段落进入 `segment_jobs`，有稳定 ID、前文、续段关联、gate/scope 决策和 sealed/committed/skipped 状态。`MetaStore.segment()` 汇总开放段落与未提交任务，旧 pending 数据兼容。
   - 每侧先验证整份写入输出，再保存 `write_plans`；每个新建/更新动作都有稳定 ID 和 `write_receipts`。一侧成功另一侧失败、某个文件失败，重试只补未完成动作。无效 JSON、缺少要求的文件、超出每侧三个新文件等都不能推进 tail。
   - 文件里的 `memkit_actions` 和正文一起临时文件落盘、fsync、原子 rename、目录 fsync；随后记录 SQLite receipt。即便在 rename 后、数据库提交前被 SIGKILL，恢复时也不会重复追加或重复创建。已有文件冲突时，只重新生成尚未提交的那个文件的更新。
   - 正常整理仍由换话题、长度/轮数上限、reset、session_end 触发。本次选择**待整理内容参与检索**，没有新增空闲模型任务。开放段落和失败任务以原始对话形式跨同一 agent 的会话召回，仍需 Jev 放行；标注双方说话方与时间，较新的明确更正优先于旧记忆，助手提议不等于用户确认。
   - 已整理文件和待整理段落共用一次 query embedding，各取最多 `recall` 个候选；最终仍受 `k` 和总证据字数限制。向量缓存按完整清单清理，不能因为查询其中一侧而清掉另一侧的缓存。
   - 长度切分保存 `continuationOf`，上段成功写过的文件补入后续候选，并告知 Jev 是同一话题续段；中间一段被 gate 跳过时向前寻找最近的关联文件。原来的 Choice + `pickWithin=0.2` 策略保留。
   - ingest 的 BGE query 包含有角色标记的 User 和 Assistant，分别留出预算，长回复同时保留开头和末尾。写入提示词区分记忆归属、说话方和确认状态；动作 ID 可追溯到完整来源段落。
   - 验证使用离线模型替身和故障注入（包括真正 SIGKILL 子进程），另外通过已安装 OpenClaw SDK 做了 hook 注册、原话绑定、重复回调、reset flush 的本地检查。没有调用真实模型做大规模评测，也没有重启 Gateway。

19. **限制失败重试、缩小共享锁、压缩文件动作标记**（2026-10-29）。
   - `ingest.maxAttempts` 默认 3（包含首次处理），尝试次数与最后错误写入 `segment_jobs`。格式校验失败、模型异常和写回失败都计入；耗尽后标为 `quarantined`，不再自动调用模型，也不阻塞后续段。原文仍纳入 pending 检索。旧表自动增加字段，不清空已有任务。
   - `retrySegment(id)` 是显式恢复入口：重置隔离段的预算，保留已完成动作和计划；后续普通消息不会重新激活它。晚提交的旧段不会把近期 tail 倒退。仅差 tail 更新、所有动作已有回执时，可直接完成，无需再花一次模型尝试。
   - 模型调用只占会话自己的队列；不同会话并行。`MetaStore.exclusive()` 统一保护短暂的状态操作与文件写回事务，避免移除旧全库锁后，同一 SQLite 连接上的另一会话操作混入正在执行的事务。并发读取产生旧快照时由写回内容核对和局部重做处理。
   - hook 传入 `{ timeoutMs }`，在会话排队完成、输入保存之后才创建超时信号；外部主动传入的 AbortSignal 仍按调用者期限取消。
   - 文件更新时保留最近 20 个 `memkit_actions`，窗口外只有已存在 SQLite 回执的 ID 才能删除。未确认 ID 是崩溃恢复依据，可能临时让总数超过 20，确认后在后续更新中清掉。数据库回执不删除；旧文件头在下次写入时整理，不启动全库改写。
   - 测试覆盖：持续漏文件与异常的隔离、隔离后跨会话检索、重启保持预算、显式恢复、不同会话同时进入 Jev/DeepSeek、同文件并发冲突、排队不消耗超时、事务失败不回滚其他会话原话，以及超过 20 次更新后的已确认/未确认动作恢复。

20. **检索排除本会话尚未入库的内容；段长度只按字数**（2026-10-29）。
   - `retrieve()` 接收当前会话（插件里是 sessionKey）：本会话的开放段和正在处理的封存段不再作为待整理内容召回——它们就在本会话的上下文里，再注入一次既重复占用证据预算，也分散回答模型的注意力。其他会话的待整理内容照常召回；本会话**被隔离**的段仍可召回（已退出整理流程，原文可能早已不在上下文里）。
   - `segmentChars` 4000 → 6000，去掉 `segmentTurns`：角色扮演的发言和微信一句话差不多长，轮数不是问题，字数才是 Jev 输入的上界。
   - `jevChars` 9000 → 11000（约 8.8K token，Jev 能稳定处理 10K）：一整段（6000 字）放进 state 后，落点判断的 6 个候选文件仍能分到约 3000 字。
   - 单测 95 个通过；没有实测。

21. **idle flush；撤掉「待整理内容参与检索」**（2026-10-29，覆盖第 18 条的检索部分和第 20 条的会话排除）。
   - memkit 是单 agent、单用户，用户基本只在一个会话里对话，没有跨用户、跨会话的需求；本会话没整理的内容本来就在它的上下文里。所以检索只看已整理的记忆文件，待整理的原文不再参与召回（`retrieve()` 也不再接收 session）。
   - **idle flush**：一个会话 `idleFlushMinutes`=20 分钟没有新消息、又有没整理的轮次时，直接把它们当作同一段——之后没有新消息，也就没有「换话题」要问 Jev——`flush()` 封存成一段并走写入流程。
   - 实现：gateway 进程里一个进程级定时器（插件重注册只替换 tick），每分钟扫一次 memkit 根目录下每个 agent 的库，所以重启前遗留的待整理会话也会被处理；有轮次在进行中的会话跳过（它的 agent_end 自己会 observe）；`gateway_stop` 清掉定时器。`idleFlushMinutes: 0` 关闭。
   - 失败的封存段按「上次尝试」时间退避：距上次尝试满一个 idle 窗口才再试（`segment_jobs.attempted_at`），否则一分钟一次的 tick 会在模型短暂故障的几分钟内用光 3 次重试预算、把段隔离。
   - 被隔离的段不再能被检索到，原文留在 `.meta.sqlite` 里，修好原因后用 `retrySegment()` 重新入队。
   - 验证：单测 91 个；在服务器上用已安装的 OpenClaw SDK 加载插件、假 key（不调真实模型）做了冒烟：定时器启动、空闲会话被封存并尝试写入、进行中的会话被跳过、`gateway_stop` 后定时器清除。没有实测。

22. **写入落点改成逐文件独立判断，由 DeepSeek 决定怎么写**（2026-10-29，覆盖第 14 条的 Choice 落点和第 17/19 条的 `pickWithin`）。
   - 召回：这一侧按纯相似度取前 `ingestCandidates`=10 个文件（不乘 importance 和遗忘）；长度切开的续段，上一段写过的文件照旧补进候选。
   - Jev：去掉 new 选项，每个候选文件一个独立请求（Noul `related`）：「这个文件和这段对话要记的内容有没有关系」。state 是这一段（加续段说明），文件视图按 `jevChars` 剩下的预算给。
   - 交给 DeepSeek：P ≥ `relatedAt`=0.5 的文件按相似度从高到低，最多 `writeFiles`=3 个；没有相关文件时只能新建。
   - DeepSeek 输出 `{"files": [...]}`，每个要写的文件一项：`append`（add，只写新增条目）/ `edit`（body，改好后的完整正文）的 uri 必须和给出的文件一字不差，每个文件最多一项；关系不大的文件可以不动；`new` 的 uri 必须合法：`<侧>/<principle|event>/<名字>`，名字已是 slug 形式（只有字母、数字、下划线），最多 3 个；撞名由 store 加 `_2`。新文件 importance 仍是默认 0.5。
   - 校验不过（uri 不对、mode 不认识、缺字段、files 为空）时，把错误逐条发回 DeepSeek 再要一次；第二次仍不过就一条都不写，这次尝试算失败（段任务计入重试次数）。冲突重写（rebase）只允许输出那一个文件的 append/edit。
   - `IngestResult.targets` 现在是交给 DeepSeek 的相关文件；`options` 是每个候选的 similarity 和 P(related)。
   - 验证：单测 90 个（删掉 Choice/pickWithin 相关用例，新增逐文件判断、按相似度截 3 个、非法回复退回重写、10 个候选）。
   - **实测 jev-v9a（2026-10-29，真 Jev `jev-latest` + DeepSeek + BGE，42 场景）：38/42 = 90.5%**（知识更新 15/16、检索 9/10、诚实不知道 8/8、store_skip 6/8；检索 0.33 s，写入每轮 1.9 s）。
     - 写入路径本身没出错：113 段，0 次写入失败；逐文件判断 76 次，相关 19 个（P 0.61、其余 0.92–0.99），不相关 57 个（最高 0.17，含 cos 0.63 的近邻文件），两边分得很开。交给 DeepSeek 的文件：0 个 82 次、1 个 17 次、2 个 1 次；DeepSeek 对给出的相关文件全部更新（edit 17、append 2），没有放着不动的；新建 94 个。
     - 4 个失败都不在落点上：gu_highrisk_cap_two_to_three（用户定的规矩写进了 assistant 侧，检索时 scope 只看 user，没召回）；rt2_plain_1（探测句「我教你…一次打赏最多给多少」被检索 scope 判成 empty，没召回）；ss2_joke_1（玩笑段 gate 0.83 但写入 scope 判成 empty，被第二道门丢掉）；ss2_thirdparty_1（回答正确，评分员嫌没提「凯亚用他自己的赏金」）。前三个都是 scope 判断的问题。

23. **检索去掉「查哪边」这一步**（2026-10-29，覆盖第 15 条的检索 scope）。
   - 原来检索前先问 Jev 一道 Choice（user / assistant / both / empty），只在选中的一侧召回，empty 直接不召回。v9a 里两次失败就出在这里：用户教给助手的规矩写进了 assistant 侧、提问时被判成只查 user；「我教你……最多给多少」被判成 empty。没有更多先验，Jev 分不清一句话需要哪一侧的记忆，判错一次就整侧看不到。
   - 现在每轮直接在两侧所有文件里 BGE 召回前 10（相似度 × (1 + importance) × 遗忘），每个文件一个 Jev 请求判断相关，P ≥ 0.5 放行。不相关的文件靠逐文件判断挡住；寒暄也照样召回和判断（多 10 个并行 Jev 请求，约 0.3 s）。
   - 写入端的 scope（user / assistant / both / empty）不变。`RetrieveResult` 去掉了 `scope` 字段，`NO_RECALL` 和检索 scope 的提示词删除。
   - 以后可以再想更好的办法（比如更强的先验），目前先这样。单测 90 个。

24. **中期记忆：召回块在同一话题里留在对话中**（2026-10-31，覆盖第 8/9 条「证据只在本轮可见」）。
   - 长期记忆是记忆文件，短期记忆是上下文 + 压缩摘要；中期记忆 = 当前话题（ingest 的未封存段）里召回过的记忆块。块挂在它被召回的那一轮用户消息上（OpenClaw 冻结进 projection 的原位），话题内一直留着，像 ReAct 的工具结果一样保持前缀不变、KV cache 连续；话题结束（段被封存）时整段话题的块一起清掉。
   - 块带 id：`<memkit-recall id="<runId>">`。`.meta.sqlite` 的 `recall_blocks` 记录当前未封存段里每轮的块（id、文件 uri、字数）；`seal()` 后只保留仍在段里的轮次（和正在回答的这一轮）的块。没有 id 的块（无 runId、或关了 autoCapture 走旧路径）照旧只在本轮可见。
   - **话题判断提前到回答前**：`before_prompt_build` 里 `recallTurn()` 同时跑「话题是否切换」（Jev，判据和以前一样）和检索。切换或超长就当场封存上一段（块随之失效），这一轮就不会带着旧话题的记忆回答；决定存在 `turn_decisions`，agent_end 的 `observe()` 直接沿用，不再问 Jev。封存的段仍在 agent_end 里写入。判断失败时不记决定，由 `observe()` 照旧补判。
   - 检索照旧每轮跑（降频以后再做），但本话题里已经出现过的文件不再注入；没有新文件时这一轮不加块。「出现过」只算真正渲染进块里的文件：被 `evidenceChars` 预算挤掉的文件（块里只有「另有 N 个未列出」）不记为已展示，本话题后面的轮次还能放进来。
   - **长度**：块的字数和对话一起算进 `segmentChars`（6000），超了就切段、清块；`evidenceChars` 从 8000 降到 2000（之后做压缩时再细调）。
   - context engine：`assemble()` 只去掉不在当前话题集合里的块，以及正在进行的这一轮自己的块（溢出重试时合成的 continue 消息会再带一份）；同一 id 在历史里出现两次只留第一份。`maintain()` / `compact()` 只改写已结束话题的块。`before_message_write` 只清 `content`（重试 prompt），不碰 projection。
   - **话题判断实际在 `assemble()` 里做**（2026-10-31 e2e 发现）：OpenClaw 每轮先调 context engine 的 `assemble()`（带本轮 `prompt`，`deferredTurn.prompt`），约 25 ms 后才跑 `before_prompt_build`，而且一轮只组装一次（之后走缓存）。原先在 hook 里判断，旧话题的块要晚一轮才从请求里消失。现在 `assemble()` 先调 `prepareTurn` → `engine.decideBoundary(session, prompt)`（按 prompt 存决定，10 分钟内按文本匹配；宿主可能给 prompt 加前缀，所以包含也算），再读中期记忆集合；hook 里 `recallTurn` 按文本接管这个决定并记上 runId，`observe()` 再按 runId 复用。正在进行的轮次重试时（合成 continue prompt）`assemble` 不判断。宿主没传 prompt 时退回 hook 里判断。
   - 单测 103 个（`tests/midterm.test.ts`）。端到端见 §7「第 9 次」。

25. **检索降频：先判断要不要召回；召回后 DeepSeek 可以改写 query**（2026-10-31）。
   - **门（Jev，Noul `need_recall`）**：每条用户消息先问「靠对话和已经想起的记忆就够了，还是要再去找」。state 是检索背景、对话、当前这句话，加上 `recalled_memory` = 本话题里还留在对话中的记忆文件（中期记忆）。P < `recallAt`=0.5 就这一轮不召回、不加块；判据里「拿不准」算要找，Jev 没给答案也算要找。
   - 话题判断和门并行跑。门看到的是判断前的块；只有「话题结束把块清掉了，而门正是因为这些块才说不用找」这一种情况才重问一次门（不带那些块）。不要召回时省掉 BGE、10 个逐文件判断和下面的 DeepSeek 调用。
   - **改写（DeepSeek，JSON）**：要召回时，第一次 BGE 召回前 10 后，把用户这句话、对话、当前 query 和这 10 个文件的 uri/topic/summary 预览交给 DeepSeek，输出 `{"rewrite": false}` 或 `{"rewrite": true, "query": "..."}`。改写后用新 query 再召回一次，两次结果取并集：每个文件只出现一次、取较高的排序分，再按分取前 10，逐个交给 Jev 判断——改写只会多出候选，不会丢掉第一次的好文件。DeepSeek 失败或回复不可用就沿用原 query。
   - 改写提示词里放了写入时给 DeepSeek 的「summary 怎么写」（抽成共用常量 `SUMMARY_GUIDE`，写入和改写读同一段），让它知道 summary 是「<对象>的<属性>是<值>」的断言，query 应该补全代词和省略、写成能命中这种 summary 的说法。
   - 代价：要召回的轮次多一次 DeepSeek 调用（deepseek-flash，几百 ms 到一两秒）。离线评测 `eval_gold` 直接调 `retrieve()`，门和改写都会生效；v9a 里检索 scope 判成 empty 漏召回的那类问题，现在落到这道门上，要重点看。
   - 配置：`retrieve.recallGate` / `recallAt` / `queryRewrite`。单测 101 个。端到端见 §7「第 9 次」；离线评测还没跑。

26. **第 9 次 e2e 的三个问题分别处理**（2026-10-31，三个子代理并行）。
   - **写入侧 Jev 的 related 判断**：输入是完整的（整个文件、整段对话都在预算内），问题是问法。原问题「这段对话里要记住的内容和这个文件有没有关系」——纯重问的段没有新内容要记，Jev 就判成无关（0.37），writer 没看到文件，新建了重复的。改成「这段对话聊到的事情里，有没有哪一件就是这个文件讲的那件事」，判据写明重复、只是问到也算，并给写入侧加了和检索侧一样的背景（`INGEST_BACKGROUND`：文件是什么、conversation 是要记录的段、earlier_conversation 只是上下文、助手的回答常来自记忆文件）。真 Jev 对比（3 次）：`小满生日` 0.37 → 0.99；无关文件（同人不同事、同事不同人、只在 earlier_conversation 出现的）反而更低（0.05–0.28 → 0.02–0.13）。测试 `tests/related.test.ts`。
   - **改写提示词**：原来问「召回效果好不好，不好就改写」，但第一次召回总是保留，第二个 query 只能多出文件，所以真正的问题是「有没有列表里缺的文件」。改成「检索补查」：先判断用户这句话是哪类（要用过去信息 / 陈述、指令 / 寒暄），陈述句不补查；需要补查时只写缺的那件事，借用列表里 topic / summary 的叫法，写成 summary 的前半句，≤60 字；加了 4 个例子。给 DeepSeek 的预览补了 type、最新一条、库里总文件数，不再把原 query（消息 + 对话）重复展示。真 DeepSeek 对比 7 个用例：陈述句不再改写，两件事只命中一件的问题会补查缺的那件，原本对的没变。另加一条保护：第一次召回已包含库里全部文件时跳过 DeepSeek（合并结果不可能变）——小库（含离线评测的场景）里改写因此不会触发。
   - **耗时归因**：trace 事件带 `ms`（topic_shift / gate / rewrite / judge / 写入侧 judge、write、segment_done，judge 另带 `bgeMs`）；`recallTurn()` 返回 `timings`；`MEMKIT_DEBUG` 下每轮一行 `memkit: recall run=… total boundary gate bge rewrite judge block=`，agent_end 一行 observe 耗时，assemble 行带 `ms`/`boundaryMs`，transcript cleaned 行带 readMs/rewriteMs；代理日志每行加 `ms`/`ttfbMs`/`status`（代理要重启）；`scripts/ops/turn_timing.py <trace> [proxy.jsonl]` 按轮打印各模块耗时。

27. **人设写进系统提示词：`persona.file` + 角色扮演版记忆规则**（2026-11-01）。项目转向微信陪伴 GalGame，回答模型要以角色身份说话，记忆仍由 memkit 提供。
   - **人设来源**（`src/persona.ts`）：`persona.file` 是一份 markdown 人设卡（绝对路径、`~/…`，或相对 OpenClaw 状态目录）。启动时读一次，之后每轮 `stat` 一次，mtime 或大小变了就重读——改人设卡不用重启 gateway。优先级：可读且非空的 `persona.file` > 内联 `answerPrompt` > 内置 `DEFAULT_ANSWER_PROMPT`。文件读不到（不存在、不是普通文件、空文件、权限）时打一条警告（同一个问题只打一次），**已经读到过就沿用上一次的内容**（编辑器「写临时文件再改名」会让文件短暂消失，不能因此掉回通用助手），从没读到过才退回 `answerPrompt` / 内置提示词，不会让 hook 失败。memkit 源码里没有任何角色文本；`examples/persona.example.md` 是一个占位角色。
   - **规则跟着人设走**（`persona.rules`，默认 `auto`）：生效的文本来自人设文件时追加 `ROLEPLAY_RULES`，否则仍是原来的 `ANSWER_RULES`——没配人设文件的配置行为与之前逐字相同（单测钉住）。`roleplay` / `assistant` 可以强制。`ROLEPLAY_RULES` 和旧规则是同样三条（过去的事只依据 recall 块和对话原话、绝不编造、以最新的明确说法为准），换成对角色说：块里是「你自己想起的、和对方相处的往事」，对方看不到；`记忆归属=User` 是关于对方的事，`记忆归属=Assistant` 是你自己说过的话、答应过的事；没想起来的就以角色的方式说记不清、反问，**不能编出具体的数值、日期、人名装作记得**，对方说「你答应过我…」而想不起时也不顺着认（CLAUDE.md §2 的反捷径原则：角色扮演反而更容易顺着人设补故事）；不提记忆系统、检索、文件、模型，不说自己是 AI。证据行里的 `记忆归属=User/Assistant` 标签没改（engine 和文件侧都按这两侧组织），由规则解释含义。
   - **recall 块的措辞**：块是隐藏上下文，但模型每轮都读到它的标题。「【记忆检索结果】（系统根据用户的话自动检索…）」把这一轮框成「系统 ↔ 用户」，容易引出「根据记录…」这类出戏的话，所以角色扮演模式下标题换成「【想起的往事】（你自己想起的往事，只有你看得到…）」，检索失败的提示换成「这一轮没能想起以前的事：涉及过去的细节一律当作记不清，不要编」。只改标题文字，`<memkit-recall id=…>` 标签不变，剥离和中期记忆不受影响。改人设只影响之后新生成的块，同一话题里已经留在对话中的块保持逐字不变。
   - **`host` 模式**不读人设文件（宿主的 SOUL.md 就是人设；配置了会警告），只追加规则；`persona.rules: "roleplay"` 时追加角色版规则。
   - **OpenClaw 的默认提示词是否被完全替换**：已在服务器上的 OpenClaw 2026.10.7 源码里核实（`dist/attempt-system-prompt-prepare-*.mjs` 的 `prepareEmbeddedAttemptPromptAssembly`）。hook 的 `systemPrompt` 整体替换 OpenClaw 自己拼的系统提示词（默认 Agent 提示、工作区引导文件、技能列表、工具说明、`extraSystemPrompt` 都在被替换的那份里）；之后 OpenClaw **无条件**追加一行 `Current model identity: <model>. If asked what model you are, answer with this value for the current run.`（`system-prompt-*.mjs` 的 `appendModelIdentitySystemPrompt`，只有模型名为空时才不加）。插件去不掉它：hook 结果在它之前；`registerTextTransforms` 的 input 替换只作用于 OpenClaw 构造基础提示词那一步（`transformProviderSystemPrompt`，在 hook 之前），流式发送时的包装对系统提示词是 `transformSystemPrompt: false`。所以只能在提示词里先行化解：`ROLEPLAY_RULES` 第 6 条说明那行是技术信息、被问到是什么模型时仍以角色回应。另外用户消息可能被宿主加上时间戳/渠道前缀（`engine.ts` `samePrompt` 的注释），在 user 轮里，不在系统提示词里。memkit 自己的 context engine `assemble()` 不返回任何系统提示词附加内容。
   - 单测 120 个（`tests/persona.test.ts`：优先级、mtime 重载、缺文件回退与只警告一次、改名期间沿用旧内容、路径解析、无人设时提示词不变、角色版规则保留反编造、块标题）。另用桩 SDK 加载 `index.ts` 冒烟：人设文件 → `systemPrompt` 以人设开头 + 角色版规则、`toolsAllow: []`；无人设 → 原提示词；host → 只追加旧规则并警告。没有实测。

11. **`agent_end` 每个 attempt 触发一次**，失败的 attempt 也报 `success:true`；只有最后一条 assistant 消息 `stopReason` 不是 `error`/`aborted` 的那次才算这一轮结束（清缓存和 in-flight 标记、ingest）。这个 hook **始终注册**：`autoCapture: false` 只关 ingest，不能连带关掉轮次结束的清理，否则 in-flight 标记永不清除、活动分支再也不会被改写。

28. **角色的隐藏心声：回复里先想后说，发出前剥掉**（2026-11-01）。针对角色扮演的几个已知毛病（回答坍缩成最典型的一句、口癖堆砌、情绪永远一个样、人设越温柔越顺着用户），人设卡要求回答模型每次先在 `<心声>…</心声>` 块里写角色此刻的心情、注意到了什么、想要什么、决定说什么和不说什么，再写可见的回复（test-time scaling 的一种：想清楚再开口）。心声不能到玩家手里，但**其他地方都保留**：转录里留着（下一轮的历史带着角色上一轮的情绪），记录代理的日志里也留着（可以检查它到底在想什么）。
   - **只在出站剥**：OpenClaw 的 `message_sending` hook（`PluginHookMessageSendingEvent.content` → 返回 `content` 替换；微信插件 `applyWeixinMessageSendingHook` 每次发送前都跑它），`before_message_write` 不动心声。`src/monologue.ts`：成对的块全部去掉；只有开标签时，去掉从开标签到本段结尾（第一个空行）的内容，没有空行就去到末尾；只有闭标签时，去掉它之前的全部内容（模型漏写开标签时，闭标签之前几乎一定是心声）——两种情况都是宁可少发也不能把心声漏出去；剥完为空（整条回复都是心声）就取消发送并打警告，沉默好过泄露。标签匹配容忍全角尖括号、标签内空格、`</ 心声>`（DeepSeek 偶尔这么写）。标签可配（`persona.monologue.open/close`，默认 `<心声>` / `</心声>`，以人设卡为准）；`persona.monologue.strip` 默认 `auto`＝角色扮演规则生效时才剥。
   - **流式**：微信插件声明 `capabilities.blockStreaming: true`（`channel.js`，按段合并 `minChars 200 / idleMs 3000`），即回复可能按段先后发出，每段各过一次 `message_sending`。按上面的规则，被切开的心声每一段都会被某条规则去掉（测试「streamed pieces」），但更稳的是在微信渠道上关掉分块流式：`channels.<weixin>.streaming.block.enabled: false`（`streaming-*.mjs` `resolveChannelStreamingBlockEnabled`），整条回复一次发出；再配 `streaming.chunkMode: "newline"`（`chunk-*.mjs`，按空行切成多条消息）就得到人设卡要的「短句连发」。上线时按这个配。
   - **写入侧**：心声留在转录里就会进 ingest，而 `ROLEPLAY_RULES` 把 Assistant 侧解释成「你说过的话、答应过的事」——没说出口的念头有被记成「说过 / 答应过」的风险。所以 `renderTurns` 用 `markMonologue` 把块改写成「（没说出口的心声：…）」再给 Jev 和 writer：情绪和「决定不提」保留，但明确不是说出口的话。
   - **人设卡的占位符**：`persona.vars` 填 `{{player_name}}` 这类占位符（同一张卡服务不同部署），HTML 注释（给人看的部署说明）在读取时去掉，没填的占位符原样保留并警告一次（`renderPersona`）。
   - **测试 gateway 的 HTTP chatCompletions 端点不经过 `message_sending`**：e2e 脚本拿到的是带心声的原文，检查脚本自己剥，或者直接看心声（这正是 e2e 要看的东西）。

29. **一个话题一个文件：写入候选不只看 BGE、撞名不再加 `_2`、writer 可以什么都不写；回复里的 recall 标记一律剥掉**（2026-11-01）。依据是第 1 次 354 轮角色扮演长对话（`personas/yuzuha/eval/RESULTS.md`，记忆快照 `personas/yuzuha/eval/runs/long-1/memstore/` 和它的 `.trace.jsonl`）：约 1 小时 125 个文件，新建 125 次、更新 272 次，大量同话题重复——`assistant/event/我的生日`、`我的生日11月2日`、`我的生日_2`、`我的生日_3`；`虾饺`、`虾饺请客`、`虾饺食量`、`饮茶仙虾饺`；`路边停车`、`路边停车_2`、`路边停车周六先看`；user 侧 `夜航守望者` 两个。`_2`/`_3` 说明 writer 提了一个已存在的 uri 的 `new`，store 加后缀照建。原因有两层：BGE 的前 10 个候选里常常没有同话题的那个文件，Jev 根本没见到它，writer 只能新建；Jev 判了相关时，writer 又被要求「files 至少一项」，纯重复的段也得写点什么。另外有 2 轮回答模型自己在回复里写了 `<memkit-recall>…</memkit-recall>` 块（其中一次是完全编出来的记忆）。
   - **候选（`ingest.extraCandidates`=5）**：BGE 前 `ingestCandidates`=10 之外，再补最多 5 个：本会话最近 3 个已完成段写过的这一侧文件（新的段在前；话题隔几段又回来，多半还该写进当时那个文件），和 topic/summary 与这段对话共享关键词的文件（BM25，只算至少两个字符的 token——CJK 二字词或整词——单字几乎每个文件都能命中）。两个来源轮流取，去重，满 5 个为止；长度续段的文件照旧另加（数量受 writer 每段的上限约束）。`ingestCandidates` 的含义不变，仍只指 BGE 的那部分。一段最多 15 + 续段个 Jev 请求，并行，预算有界。每个被判的候选在 `IngestResult.options` 和 trace 的 judge 事件里带来源：`bge` / `continuation` / `recent` / `lexical`（trace 的 options 元组第 4 项；旧的读取脚本只取前 3 项，不受影响）。不在 BGE 前 10 的候选按它真实的相似度参与「最多 3 个、相似度高的先」的截取。
   - **撞名**：writer 提的 `new` 的名字（不论 type）或 topic 的 slug 和这一侧已有文件的名字 / topic 相同，就把那些文件加进相关文件，**带着全文重问 writer 一次**（提示里写明「已有同名文件：同一件事就写进它、已经有了就不动；确实是另一件事就换个能区分的名字」），trace 记 `new_taken`。没选「直接把 new 改成对那个文件的 append」：writer 没看过那个文件，直接追加会重复已有条目；它的 summary 只概括新内容，替换上去会丢掉原结论；而且同名不一定是同一件事（「邻居家的猫叫团子」撞上「猫」），只有看过文件的 writer 能分。重问只在撞名时多一次 DeepSeek，代价小。重问后仍然提了**完全相同的 uri**（store 唯一建不了的情况）才兜底：把它的条目追加到那个文件（有自己对该文件的 update 就并进去），保留原 summary 和 topic；只是 topic 撞了的，writer 已经看过文件、选了别的名字，照常新建。
   - store 的 `create` 不再加 `_N`：uri 被占就抛 `Conflict`。段任务里是计划之后、提交之前被别的会话占了 uri 的竞态，`commitPlan` 现有的 rebase 把这一步重写成对那个文件的 append/edit；直接 `ingest()` 里由 `ingestSegment` 的冲突重试重新规划（这时就会走上面的撞名流程）。旧库里已有的 `_N` 文件照常读取（文件名就是 uri）。
   - **writer 可以什么都不写**：给了相关文件时，`{"files": []}` 合法，表示这段对话的内容文件里都有了（重复、又问了一遍、助手按记忆回答）；这一侧的结果是一条 `{op: "skip", ok: true, reason: "nothing new"}`，trace 的 write 事件带 `nothingNew: true`，段任务存一个空计划（重试和恢复不会再调 writer），整段都没写时状态是 `skipped`，`segment_done` 带 `nothingNew`。**新信息仍然一定写**：提示词写明「只要有一条文件里还没有的信息（新的值、更正、状态变化、新的约定或承诺）就必须写」；没有给出任何相关文件时空列表不合法，按校验错误退回重写——过了门的内容没有别处可去。rebase 时 writer 返回空也按 nothing new 记回执。同一个回复里重复的 `new` uri 现在按校验错误退回。
   - **recall 标记**：`stripRecallMarkup`（`src/monologue.ts`，和心声共用同一套块规则 `stripBlocks`：成对的块整块去掉；孤立的开标签去到本段结尾，孤立的闭标签去掉它之前的全部，宁可少发）。开标签匹配任意属性（`<memkit-recall id="…">`、`<memkit-recall>`），容忍全角尖括号和空格。出站：`message_sending` **无条件**先剥 recall 标记（不看 `persona.monologue.strip`、不看是否角色扮演模式），再按原规则剥心声；剥完为空就取消发送并警告。ingest：`observe()` 落盘前就从助手回复里去掉（之后 Jev 的话题判断、gate、BGE 查询、writer 都看不到），`ingestSegment` 和 `renderTurns` 再各剥一次（旧库里已落盘的段、直接调用 `ingest()`、rebase 用的 `job.turns`）。和心声不同，它在写入侧不保留、不标注：它既不是记忆，也不是角色说过的话。
   - 没做：转录里那条助手消息仍带着编出来的块（下一轮回答模型在历史里会看到它）；`before_message_write` 只清用户消息里的块。要不要对助手消息也清，看 OpenClaw 助手消息的 content 结构再定。
   - 单测 144 个（`tests/engine.test.ts`：词法 / 最近段候选及来源、上限；撞名重问后换名、重问后仍撞名追加并保留 summary、topic 撞名、store 拒绝撞名且旧 `_N` 可读、计划后被占 uri 的 rebase；纯重复 nothing new、新信息必写；编造的 recall 块不进段、Jev、writer。`tests/monologue.test.ts`：剥 recall 标记的各种形态、`renderTurns`）。另用桩 SDK 加载 `index.ts` 冒烟：host 模式下 `message_sending` 也剥 recall 块、不动心声，只有块时取消发送；角色扮演模式两者都剥。没有实测。

30. **时间感知：门上加一问「和时间有关吗」，日期用硬规则换算，写入一律绝对日期**（2026-11-01）。证据：354 轮的角色扮演长对话（`personas/yuzuha/eval/RESULTS.md` 第 1 次长对话，快照 `runs/long-1/memstore/`）里，凡是和时间有关的都答不好——「周六约了什么」「你昨天说的」、生日、「六号是哪天」。原因有两层：条目写的是相对时间（「店长周六把盒子借我」「明天白天再对」「我昨晚讲过今天要上课」），读到时已经不知道相对的是哪天；BGE 的相似度根本不看日期，「周六」和一条写着 11-07 的条目不会靠近。memkit 之前没有任何时间处理。
   - **门的第二问（Jev，Noul `time_related`）**：和 `need_recall` 放在**同一个请求**里（多一个问题，不多一次请求）：这句话是否高度和时间相关（某一天、某个时段、先后、约定的日期、生日、上次/昨天/周末…）。门关掉时单独问一次。Jev 没给答案算不相关。P ≥ `timeAt` 才走下面的日期路径；门说不用召回时照旧不召回（时间答案仍记在结果和 trace 里）。
   - **日期换算是硬编码规则，不调模型**（`src/dates.ts`）："今天"取用户消息的时间信封（`[Sun 2026-11-01 10:32 GMT+8]`），没有信封取宿主本地日期（engine 的 `now` 可注入）。支持今天/明天/后天/大后天/昨天/前天/大前天（含今晚、昨晚、明早等）、周X/星期X/礼拜X 及「这/本/上/上上/下/下下（个）」前缀（周一到周日为一周）、「上/这/下（个）周末」= 那周的周六和周日、X月X日/号（可带「明年/去年/今年」或四位年份）、「上个月/下个月/这个月」+ X号、裸的 X号 = 本月、显式 `2026-11-02` / `2026/11/2`。歧义：不带前缀的「周X」= 本周的周X，若已经过去再加上下周的周X（周日说「周六」可能是昨天，也可能是下周六——两天都搜，让 Jev 判）。配了信封的日期本身不算提到的日期。**为什么不用模型**：哪天是「下周三」是算术，不是判断；规则确定（固定场景可复现）、零成本、每一步都能在 trace 里核对；让模型换算，它会自信地算错，这正是 CLAUDE.md §2 要消灭的捷径。规则换算不出的（「上次」「那天」「明年」单独出现）就不换算，退回普通路径，trace 里仍记 `time_related` 触发了。
   - **按日期找文件**：对库里每个文件数日期命中——topic / summary / body 里出现 `2026-11-07`、`2026-11-7`、`11月7日`、`11月7号`（旧条目的写法；`11月2日` 不会命中 `11月21日`）算正文命中，`times:` 里某次写入的本地日期（或 ISO 字面前缀）落在这些天算写入命中。排序：正文命中多的在前（**说到**那天比**写于**那天更强），再按写入命中，再按最近更新。取前 `timeFiles`（默认 3）个，候选 = 这 n 个 + BGE 的前 (10 − n) 个（去重；日期文件少于 n 时 BGE 补满），再照常逐个交给 Jev 判相关。有日期匹配时 BGE 对全库排一次序，日期文件带着自己真实的相似度进 trace。逐文件判断的 state 多一个 `time_reference`（今天是哪天、「周六 = 2026-10-31（周六）或 2026-11-07（周六）」），让 Jev 能把「周六」和写着 11-07 的条目对上。trace：`gate` 带 `time`，新事件 `time`（p、today、每个说法换算成的日期、按日期找到的文件及命中数、实际用了哪几个），`judge` 的 recalled 里日期文件带 `dated: {text, times}`；`RetrieveResult.time` 同样内容。
   - **写入一律绝对日期**：writer 系统提示词加了【时间怎么写】（`DATE_GUIDE`）：条目里和时间有关的内容写成 `YYYY-MM-DD`，星期有意义时括号注明；相对说法可以保留原话，但同一条里必须有换算后的日期；以那句话说出的时间为基准；歧义规则（裸「周X」= 最近的、还没过去的那个，说的明显是已经发生的事就取最近过去的；这周/下周/上周按周一到周日；周末 = 周六和周日；裸「X号」= 当月；定不下来就写出理解并保留原话）和三个例子。用户提示词加【现在】：这段对话最后一句话的日期、星期和时刻（信封优先，否则按宿主时区换算 ISO 时间）；`renderTurns` 里每轮的时间也从 UTC ISO 改成本地「2026-11-01（周日） 10:32」，writer 不用自己做时区换算。
   - **写入后检查**：新写的条目（append 的 add、edit 里旧正文没有的行、new 的全部）里有相对时间词而同一条没有绝对日期（`YYYY-MM-DD` / `YYYY年M月D日` / `M月D日`），就复用 writer 已有的那一次纠错回合，把问题条目列给它重写；第二次回复无论如何都接受——这是软检查，绝不因此丢掉一次写入。旧条目不检查（writer 不知道它们当初指哪天）；整段对话都没有可用时间（没有信封、时间不是 ISO，例如离线场景的「第2天」）时也不检查。
   - 配置：`retrieve.timeAware`（默认 true）/ `timeAt`（0.5）/ `timeFiles`（3）。单测 146 个（`tests/dates.test.ts`：60 行换算表含跨月跨年和闰年、日期命中计数、候选合并、门的两问接线与高低分支、无日期可换算的回退、门拒绝时的时间答案、writer 退回一次、第二次接受、无时间段不检查）。没有实测。
   - 已知局限：只从**当前这句话**换算，「那天呢」这种靠上文的指代换算不到；「这周一直在下雨」「一周一次」会被读成周一（只是多一个候选，Jev 会拒）；「3号线」会被读成 3 号；不支持「下周」「这个月」这种整段时间、「X天后」「两周前」、农历和节日名；年份只有「明年/去年/今年/前年/后年」和四位年份，「X月X日」不带年份一律取今年（年底说「1月3日」会落到今年 1 月）；宿主时区和信封不一致时以信封为准，没有信封才用宿主时区。已经写进库里的相对时间条目不会被追溯修正。

31. **写入侧：标题不带时间、条目带完整时间戳、Jev 看得到说话时间；角色自己说的事记到 Assistant 侧**（2026-11-02，只动 ingest 和 `DATE_GUIDE` / `dates.ts`）。依据是两次长对话的 trace（`personas/yuzuha/eval/runs/long-{1,2}/memstore/.trace.jsonl`）和聊天记录。
   - **时间进了标题，查证 owner 的假设**：long-2 assistant 侧 `周日见约定`、`周日六分街日程`、`九点见`、`第七号隧道观影约定` 讲的是同一个周日的不同切面。逐个看建它们的那一段：`第七号隧道观影约定` 建在第 1 段，库是空的，没有候选；`周日六分街日程`（第 4 段）那段 BGE 召回了 `第七号隧道观影约定`（cos 0.617，Jev P=0.95，交给了 writer），writer 往它里面 append 了日程，**同时**另建一个「当天日程」文件；`九点见`（第 19 段）BGE 召回了 `周日见约定`（P=0.58，交给了 writer），writer 判断是另一件事（周一 09:00 再聊，确实是）新建。这两例就是 owner 说的「BGE 召回了、DeepSeek 判成不同的事」，而且判得不算错。`周日见约定`（第 6 段）不一样：BGE 召回了 `第七号隧道观影约定`（P=0.31）和 `周日六分街日程`（P=0.16），**Jev 判了不相关**，writer 根本没看到——那段聊的是「七点起」，「周日见~」只是收尾一句。真正的毛病在标题带时间之后：`周日见约定` 建好后又被判了 9 段，P ≥ 0.5 的有 5 段（0.50 / 0.93 / 0.52 / 0.80 / 0.58，聊的是暮色烟花、马蹄糕、街机厅，只因为提到了周日），其中 3 次交到 writer 手里，**一次也没写进去**（文件到最后只有 1 条）——标题里的「周日」让 Jev 把不同的事当成同一件。反过来同一件事换一天说就换一个标题：long-1 125 个文件里 20 个名字带时间，`周六饮茶仙请客` / `下周六饮茶仙与放映会` / `明天饮茶仙与放映会` / `下周六之约` / `下周六放映会` 是同一个周六（在不同的日子说成「明天」「下周六」），`周五怪啖屋主讲场` / `周五怪啖屋第一场` / `周五第一场主讲` / `周五讲故事` 是同一场；long-2 24 个里 7 个。long-2 的候选几乎全来自 BGE（judge 行里非 bge 来源只有 3 个），第 29 条的补充候选这次没起作用。
   - **标题规则**：writer 提示词【新建文件】加「topic 和名字里不能有时间」（日期、月份、星期、周末、钟点、相对时间词），名字写这件事是什么，时间写进条目和 summary，附五个改名例子（「周日见约定」→「六分街看片之约」…）；专有名字里本来的数字照写（「第七号隧道」）。`dates.ts` 的 `timeWordsIn` 找标题里的时间词，防住常见误判：序数和更长的数（「第七号」「十七号」）、编号的东西（「3号线」「5号楼」）、数量（「有一点」「差一点」）；不认「深夜」「午夜」这类时段词（它们也是名字的一部分，「午夜第九站台」）。校验：`new` 的名字或 topic、update 改动后的 topic 带时间，就走 writer 已有的那一次纠错回合（和 `dateComplaints` 同一轮，`writerComplaints` 合并两类意见；标题检查不看这段有没有时间）。**第二次仍带时间就照原样接受、trace 记 `title_time`**（`[uri, 标题, 时间词]`），不剥：纠错意见已经点名了那几个词，writer 还留着的，多半是规则误读的专有名字（片名、店名），从名字里硬切一个词会得到错的或空的标题（「九点见」→「见」），还可能在撞名检查之后造出新的撞名；标题带时间伤的是去重，切坏标题伤的是正确性。
   - **撞名（第 29 条）**：`takenFiles` 比较的名字多了「去掉时间词」的版本（`titleKeys`：文件名、topic 的 slug，以及两者去掉时间词后的 slug），所以新的不带时间的「六分街看片约定」会撞上旧库里的「周日六分街看片约定」，两个都不带时间的标题照旧按原样撞；去掉时间词后不到两个字的（「九点见」→「见」）太泛，不参与比较。撞上之后仍是第 29 条的重问流程，`foldTaken` 只在 uri 完全相同时兜底，不变。
   - **条目带完整时间戳**：`DATE_GUIDE` 改成「绝对日期 + 括号里的星期 + 对话给了钟点就接 HH:MM」（「2026-11-08（周日）13:00 在六分街 Random Play 看《第七号隧道》」），只写「2026-11-08 看片」不够；不带年份、每年重复的日子（生日「11月2日」）可以不写星期；歧义规则不变。`weekdayProblems` 检查新写的条目里每个带年份的日期：没写星期（日期前后紧挨着的「周X/星期X/礼拜X」都算）或星期写错（星期是算出来的，错了就是错了）都是一条意见，进同一个纠错回合，第二次照样接受。只在这段对话有可用时间时检查（同第 30 条）。
   - **Jev 看得到说话时间**：写入侧所有 Jev 判断（gate/scope、逐文件 related；话题判断也带上了）的 state 里，每条用户消息带 `time`（本地「2026-11-02（周一） 05:16」，信封优先），gate/scope 和 related 的 state 多一个 `spoken_at`（「这段对话说于 … 至 …；对话里的「今天」「周日」「九点」都以说话的时间为准」）。related 判断里候选文件的视图把 UTC 的 `latest_time` 换成 `written_at`：最近 8 次写入时间，本地时间带星期（UTC 的 `21:15Z` 在上海已经是第二天，直接给会让 Jev 差一天）；`INGEST_BACKGROUND` 说明 `spoken_at` / `written_at` 怎么用：同叫「周日」，日期不同就是不同的日子。检索侧的文件视图不变。writer 看到的文件「历次时间」也从 UTC ISO 改成本地带星期。整段都没有可用时间时（离线场景的「第2天」）state 和以前一样。
   - **角色自己的即兴为什么没存住（owner 的问题 3）**：先数 scope。long-1 的 trace（145 段，含同一个库里的探针会话）：both 85、user 22、assistant 24、empty 12（全是探针里的「在吗」「你是 AI 吧」）、gate < 0.5 跳过 2；long-2（20 段）：both 14、user 5、assistant 1、empty 0。也就是说**多数段 scope 是包含 assistant 的**，丢失有三种：(a) 判成 `user` 的段里助手说了自己的具体事——long-2 day01 t25「睡我枕头边…宿管阿姨不知道就行」整段判 user，被写成 `user/event/阿釜睡助手宿舍`（关于助手的事进了用户侧）；day02 t21「周日我当面问铃」（user）；long-1 day03 t2–4「今天我在店里理货，爸爸进了一批新瓷」→「我还在宿舍赖着」（user，只更新了 `user/event/六分街录像店`）；day09 t12「我中午在宿舍楼下买了个饭团，金枪鱼的」（user）。(b) both 的段里 assistant 侧 writer 只记承诺和约定，丢了顺口的自述——long-2 第 1 段（17 轮）里「睡啦，七点还得爬起来」没有写，assistant 侧只写了观影约定和旧唱片，两分钟后（05:15）她说「差不多该起了」自相矛盾。旧措辞「它的身份和设定、经历和感受、答应过的事」读起来就是「设定 + 承诺」。(c) 写了但仍然矛盾——long-1 的谭家面（`assistant/event/老面摊摊名待问爸爸`）和怪啖屋发帖（`assistant/event/老韦的帖子`、`怪啖屋与网名`）其实都进了 assistant 侧，后来的矛盾来自没召回或再次即兴，不是 ingest 的问题（检索另有人在改）。
   - **措辞改法**：gate 问题和判据写明「这是用户和一个角色扮演的角色之间的聊天，两边说的都要看」，把「助手说出口的、关于它自己的具体事（今天做了什么、在哪、吃了什么、几点起、看了什么、身边的人和宠物、安排和打算）」列为值得记，判据里放了 5 个转录里的例子（七点起、阿釜睡枕头边、金枪鱼饭团、谭家面、帖子今晚开），false 一侧加「助手的话也只是附和、调侃、反问」；scope 问题点明「角色说出口的关于自己的具体事是助手这边的记忆」，user 改成「只有关于用户自己的事…助手只是在附和、提问、评论」，assistant 列出具体事并排除「角色设定里本来就写着的身份信息（生日、家人是谁）」，both 加转录例子（番茄炒蛋 / 速食面；阿釜睡哪）；`INGEST_BACKGROUND` 改成角色扮演的说法，assistant/ 包括角色说出口的自己的事；writer 的 `SCOPE_BRIEF` assistant 侧写明「即兴说出的细节也要记，说了就算数」，user 侧写明不记助手自己的事；【写什么】加一条带四个转录例子的规则，前后说法不一就按最后的写并注明「原先说…，后来改口…」。心声只给情绪和决定、不出事实的规则不变；Jev 的 `conversation` 里助手的心声现在也和 writer 一样标成「（没说出口的心声：…）」（之前 Jev 看到的是原始 `<心声>` 标签）。说话人标签保持「用户：/助手：」——记忆文件和 `ROLEPLAY_RULES` 都按 User/Assistant 两侧组织，改称呼没有收益。
   - 单测 173 个（新增 `tests/ingest_time.test.ts` 14 个：标题时间词识别与误判、`new` 带时间退回一次、第二次仍带时间保留并记 `title_time`、改名带时间退回而旧标题不管、去掉时间词后撞名、太短的键不撞、星期缺失/写错、日期缺星期退回一次、gate/scope/related 的 `spoken_at` 和逐条 `time`、心声标注、`written_at` 本地时间、无时间段 state 不变、writer 看到本地历次时间、gate/scope/writer 角色扮演措辞；改了 2 个旧用例：scope both 的标题去掉「明天」、related 的文件视图字段 `written_at`）。没有实测：措辞对真 Jev 的 scope 分布和 writer 是否真的记下顺口的自述，要在下一次长对话里看 trace（数 user / both 的比例，查「七点起」这类句子有没有进 assistant 侧，`title_time` 出现几次）。

32. **召回门的判据：把「指着以前说的话」和「只露了名字、没交代来历」单列出来**（2026-11-01）。起因是第 2 次长对话（`personas/yuzuha/eval/RESULTS.md`「第 2 次长对话」）day02 t9：玩家说「不是公路片，是爱情片，我早上不是说了吗，男主在桥上放烟花那个」，库里有 `user/event/暮色烟花` 和 `assistant/event/暮色烟花汇报约定`（day01 t27–28 写的），她却答「我这边可没收到，是不是发错人了」。
   - **先把请求原样复原**（运行记录未随开源版发布；工具是 `scripts/ops/jev_probe.ts`，当时在 `personas/yuzuha/eval/runs/long-2/jev-miss/`：`reconstruct.ts` 用 `.meta.sqlite` 里持久化的写入计划按 trace 顺序重放出当时的记忆库，用 jsonl 里的原话和带心声的原始回复拼对话，再跑 memkit 自己的 `retrieve()`、录下发给 Jev 的请求；`scripts/ops/jev_probe.ts` 在服务器上重问真 Jev）。复原的请求重问出来和 trace 里记的数逐个对得上（44 个门、9 个逐文件判断，差 ≤ 0.03）。
   - **RESULTS.md 里那两轮的数对错了轮次**：「门 0.29」是 t11（两个文件已在中期记忆里，不召回是对的），「门 0.62、Jev 给《暮色烟花》0.35」是 t15（问生日想吃什么，0.35 是对的）。真实情况：t9 门 **0.45**（差一点没过）、t8（「今晚给你放《暮色烟花》」，她随后说成「公路片」）门 **0.34**；t10 门 0.80，两个文件判 **0.94 / 0.92**、注入了——t10 的「想起来了」是有记忆支撑的。另一处同类漏判：day03 t1 新会话开头「我跟她说了今晚九点的事」门 **0.32**。
   - **逐文件判断不是问题**：假如 t8/t9 门过了，两个文件 0.84–0.93，同一库里的无关文件（`地质层蛋饼`、`伊埃斯`）0.07–0.16，`周日六分街看片约定` 0.38–0.72（t8 那句话里有「周日补」）。逐文件的变体（问法改成「当前这句话说的那件事是不是这个文件的那件事」、加时间戳、对话只留 4 条、只给 summary 不给条目、把当前这句标进对话里）对目标文件都在 ±0.04 以内；不给对话时 §7 第 8 次那种省略主语的追问（「周会在哪个会议室？」→「那几点开？」）从 0.99 掉到 0.80——Jev 是用对话的，第 8 次的 0.01 在现在的背景和问法下复现不出来（合成请求 0.99）。所以逐文件的问题和 state 都没改。
   - **门的变体，一次改一样**（t8 / t9 / d3t1 三个漏判 + 5 个不该召回的轮）：背景里说明「conversation 只是最近一段」、改问题措辞、去掉 recalled_memory、对话只留 4 条、去掉心声、把当前这句标进对话、加时间戳——都在 ±0.08 以内（只有 d3t1 上问题措辞 +0.09），没有一个让 t8 过线；只有**判据**动得了：把提示词单列成编号的几种情况（①「之前/早上/我跟你说过/我不是说了吗/你说过/你答应过/还记得吗」；②提到具体的人、作品、物品、地点、约定却不解释，口气像你早就知道，而 conversation 没交代过来历——**名字出现过、没讲过是怎么回事，也算没交代过**；③原来那条；④拿不准）。例子只用通用的（「今晚给你放《那部片》」「下午那件事」「那个帖子」），不用这次对话里的原话。「不需要找」那一侧保持原样：试过改写成「在讲一件新的事 / 接着刚商量的事」，t17、t18（顺带提到阿釜、周日那顿点心）从 0.56 / 0.54 掉到 0.45 / 0.48。另试过在同一请求里加第二问「有没有提到一个默认你知道的东西」，对 t2 这类闲聊误报 0.74，没用。
   - **前后对比**（同一 44 个门、同样的对话和记忆库，只换判据）：t8 0.34 → **0.58**，t9 0.45 → **0.70**，d3t1 0.32 → **0.69**；原来召回的轮次没有掉到 0.5 以下（d2t3 0.53 → 0.50，压线；那一轮在原跑里召回了也没有文件过判断）。召回轮次 11 → 21 / 44：新增的 10 轮里 7 轮确实指着旧事（「你不是说七点起吗」「你说的那种怪谈开头」「周日的虾饺升级…那张唱片」「《第七号隧道》你是不是偷偷看过了」「铃在《空洞探险家》上…」等），2 轮是顺带提到已知的东西（伊埃斯当支架），1 轮是对刚说过的帖子追问（d2t28 0.48 → 0.70）。代价是这些轮多一次 BGE + 逐文件判断，以及可能的一次 DeepSeek 补查（约 0.3–2 s）；逐文件判断照旧把无关文件挡在外面。门过了以后，t9 的两个文件 0.92 / 0.93，d3t1 0.94 / 0.95。
   - 观察到但没改：新会话（对话为空）时逐文件判断偏松，d3t1 上 `地质层蛋饼` 0.48、`周日六分街看片约定` 0.64（那句话讲铃、饭团、冰箱）。
   - 单测 160 个（新增 1 个：门的判据含回指提示词和「名字出现过不算交代过」、例子不含这次对话的原话，门的 state 和逐文件问题不变）。没有实测（没跑 gateway），数都是用复原请求重问真 Jev 得到的。

33. **importance 1 = 固定，不遗忘**（2026-11-02）。种子记忆（`personas/yuzuha/memory_seed/`，官方剧情里两人共同的往事）要保留剧情的真实时间（2025 年夏），而召回排序里 forgetting = 0.5^(距上次更新天数/30)，一年多前的文件权重约 1e-5，第一轮就被压到底。用户的决定：时间保留真实的，重要性直接设成 1。于是 `weigh()` 里 importance ≥ 1 的文件 forgetting 固定为 1（其余不变）；`memstore_reset.sh` 写 meta 时 created/updated 取文件 `times` 的最后一项（剧情时间），不再改成注入时刻。

## 3. 代码结构

```
memkit/
├── index.ts                 OpenClaw 插件入口：hooks（before_prompt_build / message_sending / before_message_write / agent_end）、memory capability、context engine 注册；不注册任何工具
├── openclaw.plugin.json     manifest：kind=["memory","context-engine"]，contracts.tools=[]，configSchema
├── src/turns.ts             TurnState：每轮原话、检索缓存、in-flight 标记（进程级共享）；attemptAnswered
├── src/context.ts           context engine：assemble 清历史检索块、maintain 改写活动分支、commitTurn 幂等记账、compact 委托宿主
├── src/engine.ts            MemoryEngine：ingest()、retrieve()（Jev agent）、answer()（仅离线评测用）
├── src/dates.ts             时间感知：时间信封、相对日期硬规则换算、按日期找文件、候选合并、写入日期检查
├── src/embed.ts             BGE-M3 客户端（/v1/embeddings，base64，发送前截断）、向量缓存 EmbeddingIndex、token 读取
├── src/meta.ts              文件元数据（<root>/.meta.sqlite）：创建时间、最后更新时间、重要性；写回用的跨进程写事务
├── src/view.ts              有界视图：主题 + summary + 最新的条目（BGE / Jev / 证据共用）
├── src/judge.ts             Judge 接口；JevJudge（POST https://api.typesafe.ai/v1/systemone）；LlmJudge（DeepSeek 模拟同一接口）
├── src/llm.ts               OpenAI 兼容 chat 客户端（DeepSeek），支持 tools / json / reasoning_effort
├── src/store.ts             文件存储：<root>/<user|assistant>/<principle|event>/<slug>.md，frontmatter 每行 `key: <json>`；write（整份写入）/upsert/rewrite/remove，按 mtime 感知外部修改
├── src/prompts.ts           所有提示词和问题措辞；recallBlock / stripRecallBlock / withoutRecall
├── src/text.ts              tokenize（CJK 一字+二字）、bm25Rank、slug
├── src/config.ts            插件配置 + 环境变量 → MemoryEngine
├── src/persona.ts           人设文件读取（mtime 重载、读不到时回退）+ 回答模型系统提示词的拼装（人设 + 记忆规则）
├── src/monologue.ts         角色隐藏心声块的剥除（只用于出站消息，转录保留）；回答模型自己写出的 recall 标记的剥除（出站 + ingest）
├── examples/persona.example.md  占位人设卡
├── src/http.ts              postJson（重试 429/5xx/529）
├── tests/                   node:test 离线测试（OverlapJudge / ScriptedLlm 假模型；context.test.ts 用假转录测 context engine）
└── scripts/
    ├── eval_gold.ts         离线评测：注入对话 → 探测问题 → 评分
    ├── request_log_proxy.mjs 调试用记录代理：记录请求体（不记请求头）并转发；`touch <log>.fail-next` 让下一个请求返回 503（测重试）
    └── ops/                 服务器运维脚本（见 §5）
```

存储默认根目录：`<OpenClaw 状态目录>/memkit/<agentId>/`，同目录有 `.trace.jsonl` 决策轨迹（每次 judge/写入一行）。

## 4. 配置项

见 [openclaw.plugin.json](openclaw.plugin.json) 的 configSchema 和 README 的表格。环境变量（放在 profile 状态目录的 `.env`，gateway 启动时加载）：

| 变量 | 用途 |
|---|---|
| `DEEPSEEK_API_KEY` | ingest 的生成模型（默认 `deepseek-flash`） |
| `JEV_API_KEY`（或 `TYPESAFE_API_KEY`） | Jev。**为空时自动退回 DeepSeek 模拟**（`judge.backend: "auto"`）。真 key 自 2026-10-28 起在测试 profile 的 `.env` 里；§7 表中更早的行是模拟 Jev 的结果 |
| `MEMKIT_LLM_MODEL` / `MEMKIT_LLM_BASE_URL` / `MEMKIT_LLM_REASONING_EFFORT` | 覆盖生成模型 |
| `MEMKIT_JUDGE` | `auto` / `jev` / `llm` |
| `JEV_MODEL` / `JEV_BASE_URL` | 覆盖 Jev 模型/地址（默认 `jev-latest`） |
| `MEMKIT_EMBED_BASE_URL` / `MEMKIT_EMBED_API_KEY` / `MEMKIT_EMBED_API_KEY_FILE` | BGE 地址和 token（两者都没配 → BM25；只配 token → `http://127.0.0.1:8000`）；`MEMKIT_EMBED=off` 关掉 BGE、用 BM25 召回 |
| `MEMKIT_DEBUG` | 打印调试日志：before_prompt_build（是否复用检索）、agent_end（stopReason）、assemble / commitTurn / transcript cleaned / deferred |

## 5. 部署

见 [DEPLOY.md](DEPLOY.md)：外部服务、测试 gateway（下文的 `memtest` profile，端口 18799）、记录代理、柚叶上线配置、记忆库备份/重置。

开发时的两条教训：
- 小内存机器（1.9 GB）上**不要同时跑两个 gateway**：曾经因此把整台机器拖到 ssh 都连不上。测试 gateway 用 `systemd-run` 加 `MemoryHigh`/`MemoryMax` 限额。
- 同步代码不要带 `--delete`：服务器上的副本有时会被直接修改，先 dry-run 看差异。

## 6. 测试方法

### 离线单测（本地，几秒）

```bash
node --test tests/*.test.ts      # 全部通过（npm test 同）
node --check index.ts                          # index.ts 依赖 OpenClaw SDK，只做语法检查
```

### 离线评测（服务器，约 10 分钟，不需要 gateway）

```bash
scripts/ops/run_eval.sh <judge:llm|jev|auto> <retrieval:judge|bm25> <run-name>
```

42 个场景（Paimon gold set v2，中文）：每个场景用新存储逐轮 ingest 注入对话，再用探测问题 retrieve + answer，DeepSeek 评分员对照 gold 判对错。

### 端到端（测试 gateway）

1. 同一台机器上的其他 gateway 先停；按需起记录代理并把 memtest 的 deepseek baseUrl 指过去。
2. 清空测试记忆：`rm -rf ~/.openclaw-memtest/memkit`。
3. 起测试 gateway（见上）。
4. `WAIT=20 scripts/ops/memkit-e2e-http.sh`（10 轮，覆盖：陈述、跨会话回忆、组合两条记忆、更正、同会话追问、诚实说不知道、忘掉）。每次运行用新的 session key（`RUN_ID`），不会看到旧对话。
5. 核查：回答；`.trace.jsonl`（每次写入都应来自 ingest）；记录代理日志；工作区没有新文件/新 git 提交。
6. 测完：停测试 gateway。

### context engine 验收（服务器，测试 gateway + 记录代理）

```bash
: > /tmp/model-requests.jsonl
bash scripts/ops/memkit-e2e-ctx.sh                        # 1 个写入会话 + 同会话 3 轮 + 2 个并发会话
python3 scripts/ops/check_ephemeral.py /tmp/model-requests.jsonl   # 每个请求：recall_in_history=0、recall_at_end=True；同会话前缀逐字一致
node scripts/ops/check_transcript.mjs ~/.openclaw-memtest/agents/main/agent/openclaw-agent.sqlite '%ctx-<RUN_ID>-%'
#   active_with_recall 必须为 0（活动分支干净）；all_with_recall>0 是废弃分支上的原始条目，正常
```

其他场景的触发方法：
- **重试**：`touch /tmp/model-requests.jsonl.fail-next` 后发一轮 → 代理日志里两次请求的证据应完全相同、各一个块；`.trace.jsonl` 里这一轮只有一次 ingest，user 是原话。
- **手动压缩**：`openclaw --profile memtest sessions compact <sessionKey> --token <token> --json`（HTTP 发 `/compact` 只会被当成普通消息）。小会话要临时设 `agents.defaults.compaction.keepRecentTokens` 很小才真的会摘要。
- **自动 / 溢出压缩**：临时给 deepseek-flash 配 `contextTokens: 4000`（最小值 4000），并把 `agents.defaults.compaction.model` 设成不受限的 `deepseek/deepseek-v4-pro`（否则摘要也被 4000 卡住），连发几篇长文。测完恢复配置。
- **取消**：`curl --max-time` 设在检索之后、回答之前（约 9 s）。
- **legacy 降级**：把 `plugins.slots.contextEngine` 改成 `"legacy"`（热加载），给已清理和未清理的会话各发一轮看历史。

## 7. 结果记录

### 离线评测（42 场景，Jev 由 DeepSeek 模拟）

| 版本 | 准确率 | 检索 | 知识更新 | 诚实不知道 | store_skip | 平均检索耗时 |
|---|---|---|---|---|---|---|
| 纯 BM25 基线 | 78.6% | 9/10 | 15/16 | 6/8 | 3/8 | <1 ms |
| v1：Jev 相关性 + 「证据够不够」 | 83.3% | 10/10 | 15/16 | 7/8 | 3/8 | 4.7 s |
| v2：+ Jev 路由（continue/answer/empty）、空跳早停、相关性含「澄清/否定前提」 | 90.5% | 9/10 | 16/16 | 8/8 | 5/8 | 4.5 s |
| v3：纯 Jev 检索 agent，open/answer/empty + 逐文件 open | 85.7% | 10/10 | 16/16 | 8/8 | 2/8 | 2.5 s |
| v4：BGE-M3 召回前 10 + 每个文件单独一次 Jev 判断 | 81.0% | 10/10 | 16/16 | 7/8 | 1/8 | 2.0 s |
| v5（模拟 Jev）：写入判断全归 Jev（含想法状态、只在提问），DeepSeek 只写到目标文件，带用户之前的话 | 97.6% / 92.9%（两次） | 10/10 | 16/16 | 8/8 / 6/8 | 7/8 | 1.6–1.7 s |
| **v5 + 真 Jev（`jev-latest`，2026-10-28）** | **100% / 97.6%**（两次） | **10/10** | **16/16** | **8/8** | **8/8 / 7/8** | **0.25 s** |

真 Jev 那次的唯一失败（ss2_thirdparty_2）回答其实是对的（「没有……是菲谢尔自己的事，跟小金库没关系」），是评分员两次都返回空结果被记成错——两次实际都是 42/42。
真 Jev 下检索平均 0.25 s（模拟版 1.7 s），写入每轮 1.5 s（模拟版 4.6 s），平均每题放行 0.93 个文件。

v4 和 v3 的差距仍在 store_skip（这一类在几次运行之间一直在 1/8–5/8 之间波动）和 1 个 honest_idk（idk2_nearmiss_2：放行了两个相近文件，回答过度推断「重云一分没掏」）。v4 端到端 10 轮全对（见下），每轮都走 BGE 召回，Jev 给无关文件 ≈0.01、相关文件 0.98–0.99。

v3 比 v2 少的全在 store_skip（ingest 的 gate 跳过了玩笑/假设/别人的事，之后无法明确否认），与检索无关；这一类在两次运行之间本身波动较大。

### 端到端（测试 profile）

- 第 3 次（主 Agent 零工具）：9/9 正确；日志无工具调用；工作区无新文件；5 次写入全部来自 ingest（3 new、1 rewrite、1 delete）。
- 第 4 次（记录代理）：确认请求无 `tools`、系统提示词为我们的作答提示词。
- **第 8 次（v5 + 真 Jev `jev-latest`，2026-10-28）**：10/10 正确。写入：纯提问轮次 only_asking 0.73–0.98 全部没写（模拟 Jev 时误写的「小满哪天过生日？」这次 0.93，没写）；更正、忘掉都命中了正确的目标文件（0.99 / 0.98）；共写 5 次，没有重复文件。检索：相关文件 0.96–0.99、无关 ≈0.01。单次 Jev 请求约 0.2 s。
  一处弱点：同会话追问「那几点开？」时，周会文件 cos 0.41 被召回，但 Jev 给了 0.01（没放行）；回答是靠对话历史答对的。也就是说 Jev 对「省略主语的追问」不太会借助 state 里的对话去判断相关性。
- **第 9 次（中期记忆 + 召回门 + query 改写，2026-10-31）**：脚本 [scripts/ops/memkit-e2e-midterm.sh](scripts/ops/memkit-e2e-midterm.sh)（单会话 13 轮：6 轮陈述各换一次话题触发写入，再 7 轮同话题追问 / 换话题），然后开一个只问问题的新会话 7 轮。检查工具：`check_midterm.py`（代理日志里每轮请求带了哪个 id 的块、历史里哪些保留/清掉）、`trace_summary.py`（trace 里的话题判断 / 门 / 改写 / 注入 / 写入）。
  - 第一次跑发现旧话题的块晚一轮才清掉——`assemble()` 先于 hook（见第 24 条），改成在 `assemble()` 里判断后重跑：换话题那一轮的请求里旧块已经不在（`assemble … stripped=1/2`），Jev 的话题判断每轮只跑一次，`agent_end` 后 `maintain()` 把结束话题的块从转录活动分支改写掉（`transcript cleaned entries=1/2`），当前话题的块留在活动分支上（`active_with_recall=1`，符合预期）。
  - 新会话 7/7 正确（种子不在上下文里，全靠召回）：周会→几楼（门 0.06 不召回，块保留）→生日（换话题，旧块当场清掉，召回小满生日）→晚饭（门 0.13 不召回：小满生日文件里已经带了避开花生的记录）→上限（Jev 判 0.38 当作同话题，门 0.9 召回，新块只含新文件）→车位（换话题，两个旧块清掉）→几层（门 0.15 不召回）。7 轮里 3 轮没召回，召回的 4 轮各注入 1 个文件。
  - 单会话 13 轮也全对，但种子都在上下文里，门对提问一律说不用找（0.09–0.22），只注入了一次块——这类测试看不出召回，只看机制。
  - 改写：陈述句常被改写成「用户的 X 是 Y」（无害，多一次 DeepSeek）；提问时召回预览里已有正确文件，没改写过。真正含糊的 query（「上回定的那个上限」）BGE 也直接命中了，改写的价值还没在 e2e 里体现。
  - **没修的问题**：(1) 纯提问的段也被写入：`组周会` 被 append 了两条「用户又追问了一次…」；生日问答段里 Jev 给 `小满生日` 的 related 只有 0.37（文件里已经有一样的内容），writer 于是新建了重复的 `女儿小满生日`。之前拿掉的 `only_asking` 挡的就是这类，要不要在 gate 判据里把「用户只是在问、助手靠记忆回答」排除掉，待定。(2) 每轮 10 s 上下，不召回的轮次也一样，没有定位是主模型还是别的（第 8 次是 2–4 s）；下次关掉 `MEMKIT_DEBUG` 对比。
- **第 10 次（第 26 条三项修复后，2026-10-31）**：同第 9 次的两段（种子 13 轮 + 新会话 7 轮），20/20 正确。
  - related 修复生效：生日问答段里 `女儿小满生日` 0.99、`花生过敏` 0.98，writer 追加到原文件，没有再新建重复文件；7 个文件无重复。
  - 中期记忆机制同第 9 次：同话题块保留、换话题当场清掉（`stripped=1`）、转录随后改写干净；新会话 7 轮里 3 轮门说不用召回。
  - 改写一次都没触发：库只有 7 个文件 ≤ recall 10，第一次召回已包含全部，按保护跳过。要看改写得用大库（真实数据）。
  - **耗时**：memkit 每轮 0.07–0.48 s（boundary 0.08–0.13、gate 0.07–0.19、BGE 0.13–0.26、逐文件判断 0.10–0.15）；主模型（代理 `ms`）0.6–2.1 s；写入在回复之后异步跑 1.2–4.6 s，不计入。客户端看到的 2–3 s 轮次就是这些的和；10–14 s 的轮次多出的 8–10 s 全在请求到达后、memkit `assemble` 之前，那段窗口 gateway 没有任何日志，同时 OpenClaw 自己报 memory pressure critical（RSS 1.0 G，swap 峰值 781 M，zram 用了 290 M）。结论：是 1.9 G 机器上 gateway 换页，不是 memkit；换大一点的机器或减小 gateway 内存再看。
  - 仍存在：纯提问的段也会追加一条「用户又问了一次」（writer 提示词要求 files 至少一项，纯重问也得写点东西）；待定要不要允许 writer 对没有新信息的段什么都不写。
- 第 7 次（v5，2026-10-28）：10/10 正确；纯提问轮次 `only_asking` 0.95–0.98，没写入；但「我女儿小满哪天过生日？」被模拟 Jev 判成 worth 0.95 / only_asking 0.1，写了一条「生日未知」的文件——换真 Jev 后要重点看这类。
- 第 6 次（BGE 召回 + 逐文件 Jev，2026-10-27）：10/10 正确；`.embeddings.json` 缓存生效（每轮只嵌入查询，文件改动后才重嵌）；context engine 仍保证每个请求 `recall_in_history=0`。
- 第 5 次（纯 Jev 检索 + 完整对话）：10/10 正确；同会话追问「那是第几层？」能靠上下文检索到对应文件；每轮 4–18 s。
- 插件开销：gateway 内存开/关 memkit 差异在噪声内（≈1.05G）；需要回忆的问题开 memkit 反而更快（16.8 s vs 25.2 s），闲聊多约 1 s。

### context engine（2026-10-27，测试 profile）

| 场景 | 结果 |
|---|---|
| 同会话 3 轮 + 2 个并发会话 | 每个请求只有本轮一个检索块、在末尾；`recall_in_history=0`；系统提示词和历史前缀逐字一致；活动分支 `active_with_recall=0` |
| 旧的已污染会话（引擎启用前写的） | 发送前 assemble 去掉 2 个旧块；下一次 maintain（bootstrap）改写 3 条，活动分支变干净 |
| 检索中取消 | 用户消息还没落盘，无残留 |
| 回答中取消 | 留下一条带块的孤立用户消息；下一轮 OpenClaw 把它并入新用户消息（"Earlier unanswered user message"），轮后清理，活动分支干净 |
| 手动压缩（`sessions compact`） | 摘要请求里没有检索块，摘要里也没有；压缩后的 maintenance 把旧会话活动分支改干净 |
| 溢出 → 自动压缩 → 重试 | 修复前：重试请求里有两个块（合成的 continue 消息一个 + 原消息被保留一个）；修复后（assemble 去掉所有历史块）每个请求一个块 |
| 临时 503 → 重试 | 修复前：重试按 "Continue…" 重新检索 → 证据为空、答错，ingest 记成 "Continue…"；修复后复用检索（`reuse=true`），证据相同，ingest 一次、用原话 |
| 503 + 溢出压缩叠加 | 每个请求一个块；轮内 3 次 maintenance 都推迟（turn in flight），轮后清理；ingest 一次 |
| legacy 降级 | 已清理会话重放干净（`recall_in_history=0`）；从未清理过的旧会话重放出 2 个旧块——说明改写活动分支这一步是必要的 |
| 转录全文索引 `session_transcript_fts` | 一直没有检索块（索引的是 `content`） |

## 8. 已知问题与下一步

### context engine 的剩余边界

- **数据库里不是物理删除。** 改写走 OpenClaw 的分支 + 重新追加，原始条目留在废弃分支上（`check_transcript.mjs` 的 `all_with_recall`）。活动分支、全文索引、所有重放路径都是干净的；真要清除原始条目需要 OpenClaw 提供删除废弃分支的能力，或者改核心让 projection 一开始就不含证据（上一轮讨论过的方案）。
- **清理是「轮后」的。** 从证据写入到本轮被接受之间（以及最终失败、未被接受的轮次，直到同会话下一次成功的轮次），活动分支上有一条带块的用户条目。这段时间如果引擎被隔离降级到 legacy，降级后的那一轮会看到它。
- **最终失败的轮次**：in-flight 标记要等同会话下一次成功的 `agent_end` 才清除，期间该会话的改写一直推迟（assemble 照常过滤）。
- **内置压缩器读的是 `content`**（实测摘要请求没有检索块），即使活动分支还没清理。这是观察到的行为，不是文档承诺；`compact()` 里的「先清理」在宿主没传改写能力时不生效，靠的是宿主压缩后的 maintenance。
- **context engine 依赖 `plugins.slots.contextEngine = "memkit"`**；只选了 memory 槽位时证据仍会残留在历史里（退回旧行为）。
- 自动压缩那次测试里，有一轮的压缩没有经过代理发出摘要请求（1–2 s 内成功），来源没细查。

### 其他

- **真 Jev key 已配置（2026-10-28）**：端到端（第 8 次）和离线评测（v5 + 真 Jev）都跑过；表里更早的行是模拟 Jev 的。评分员偶尔两次都返回空结果（被记成错），看失败项时先看 reason 是否为空。key 放在测试 profile 的 `.env`（`JEV_API_KEY=`，测试 gateway 和 `run_eval.sh` 都读它）。
- **store_skip 类**（玩笑、假设、第三方的事）：ingest gate 把它们跳过，之后被问「我们是不是要做 X」时只能答不记得、不能明确否认。要不要把这类话也存成 event，是取舍问题，待定。
- **gate 偶尔把纯提问判成值得记**（如「小满哪天过生日？」gate 0.95），后面 DeepSeek 会 skip，无害但浪费一次调用。
- **ingest 不吃主对话的前缀缓存**（用户提过，先放着）。
- 一次性 `openclaw agent exec` 在回合结束 5 s 后强制回收插件，会打断 `agent_end` 的 ingest；只用常驻 gateway 测。
- **检索质量（模拟 Jev）**：同一问题在新会话里有时判 empty（例：「我对什么过敏？」round1 判 empty，而另一会话里判 open）；拿到真 Jev key 后重测。
- `answer-only` 模式会让主 Agent 失去原有人设（SOUL.md）、工具和技能——人设现在由 `persona.file` 提供（第 27 条）；OpenClaw 在替换后的系统提示词末尾无条件追加一行模型身份说明（插件去不掉），由角色规则第 6 条化解，见第 27 条。
