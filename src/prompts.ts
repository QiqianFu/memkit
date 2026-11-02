// Prompts and question wording. Ported from the Paimon agent's three-stage
// pipeline (agent/baselines/react_policy.py) with the persona and game world
// removed; the rules about what to persist and how to write a summary are kept
// because they are what made retrieval work there.

import type { SegmentTurn } from "./meta.ts";
import type { MemoryRecord } from "./types.ts";
import { truncate } from "./text.ts";
import { clipText, recentEntries, entries } from "./view.ts";
import { markMonologue, stripRecallMarkup } from "./monologue.ts";
import { describeMoment, turnMoment } from "./dates.ts";

// ---- ingest ---------------------------------------------------------------

// memkit records a conversation by SEGMENT, not by turn: a run of turns about
// one thing is written once, when the user moves on (see engine.observe).
// Every turn is durably received before Jev is asked whether its topic changed; then
// the finished segment — from the last record up to the reply before this
// message — go through the write path.
//
// Jev makes every decision there: whether the segment is worth storing (gate),
// whose memory it is (user / assistant / both / empty) and where it goes (one
// pick-one question over "a new file" and the most similar files). The writer
// (DeepSeek) only writes the files it is handed: no "skip", no "delete", no
// say in where.
//
// memkit runs a role-play character, not an assistant: the user is talking to
// the character, so there is no "only asking a question" case to filter out.

/** Separates, in Jev's state, what was already recorded from what was not. */
export const RECORD_MARK = "════════ 以上内容已经记录过；以下是上次记录之后的对话 ════════";

/** Asked on every user turn while turns are pending: has the conversation moved on? */
export const TOPIC_SHIFT_QUESTION =
  "看 since_last_record（上次记录之后的对话）在聊的那件事，用户当前这条消息（current_user_message）是不是已经换了一个新话题、不再接着聊那件事了？" +
  "recorded_before 是上次记录之前的对话，只用来理解指代，不算在内。";

export const TOPIC_SHIFT_CRITERIA = {
  true: "当前这条消息开启了另一件事：换了对象、换了事情，或者明确结束了前面的话题转去聊别的；前面那段对话到此告一段落。",
  false: "当前这条消息还在接着前面那件事说：补充、追问、修改、确认、否定、对它表态，或者只是顺着聊下去（哪怕换了说法或细节）。",
};

// Role-play wording (2026-11-02). The assistant is a character with no life
// record of its own: what it improvises about itself (which film, whether it
// posted on the forum, where a noodle shop's name came from, "七点起") becomes
// its history the moment it is said, and contradicting it later breaks the
// character. The old wording ("它的身份和设定、经历和感受、答应过的事") read as
// promises and persona only: in long-2 the assistant's self-statements went to
// the user side (「阿釜睡我枕头边，宿管阿姨不知道」 → user/event/阿釜睡助手宿舍)
// or were dropped inside "both" segments (「睡啦，七点还得爬起来」, never
// written; an hour later 「差不多该起了」 at 05:15). So the gate, the scope
// choice and the writer now name those statements as assistant-side memory,
// with transcript examples. Persona-card facts (birthday, family) stay out —
// the card already holds them — and the hidden monologue still yields mood
// and decisions only, never facts.

export const GATE_QUESTION =
  "conversation 这段对话（上次记录之后的对话；earlier_conversation 是之前已经记录过的，只用来理解指代）里，是否含有日后可能被提起、值得长期记住的内容？" +
  "这是用户和一个角色扮演的角色（助手）之间的聊天，两边说的都要看。" +
  "包括：具体事实（数值、编号、名称、日期、人物、地点、状态、决定、计划、约定、将要发生的事），" +
  "用户希望以后一直照办的偏好、习惯、规则；助手（角色）答应过、承诺过的事；" +
  "助手（角色）说出口的、关于它自己的具体事——它今天做了什么、在哪、吃了什么、几点起、看了什么、身边的人和宠物、它的安排和打算（角色以后要照着说，前后才一致）；" +
  "对某个想法、计划、说法的态度和状态——它只是假设、玩笑、随口一想、还没定下来、已经被否决或撤回、是别人的事而与用户无关；" +
  "或用户要求记住、更正、忘掉某件事。" +
  "助手话里标着「（没说出口的心声：…）」的部分没有说出口，不算它说过的事。";

export const GATE_CRITERIA = {
  true:
    "含有至少一条日后可能被追问的具体信息、长期适用的偏好/规则，或助手的承诺——哪怕它夹在闲聊或别的话题里；" +
    "或者助手（角色）说出了关于自己的具体事，例如「睡啦，七点还得爬起来」「阿釜睡我枕头边，宿管阿姨不知道」「我中午在宿舍楼下买了个金枪鱼饭团」「爸爸说那摊子老板姓谭，叫谭家面」「帖子还没发，我今晚就开一帖」；" +
    "或者在说明某个想法/计划的状态（只是假设、玩笑、没定、已否决、撤回、是别人的事），日后被问「我们是不是要做X」时要靠它回答；" +
    "或者用户在要求记住、更正、忘掉某条信息。",
  false: "只有寒暄、情绪、语气词、客套，或没有具体内容、日后不会被提起的闲聊；助手的话也只是附和、调侃、反问，没有说出关于它自己的具体事。",
};

/**
 * Ingest, asked in the same request as the gate: whose memory is this segment?
 * "both" runs the write path once per side (each side writes its own file);
 * "empty" stores nothing (a second gate).
 */
export const INGEST_SCOPE_QUESTION =
  "conversation 这段对话里值得长期记住的内容，是关于谁的记忆？助手是一个角色扮演的角色：它说出口的、关于它自己的具体事，是助手这边的记忆。";

export const INGEST_SCOPE_CRITERIA: Record<"user" | "assistant" | "both" | "empty", string> = {
  user: "只有关于用户自己的事：用户的事实、偏好、习惯、计划、经历、他的人际关系和钱财，以及他讲给助手听的别人或外界的事；助手只是在附和、提问、评论用户的事，没说出关于它自己的具体事。",
  assistant:
    "只有关于助手（角色）自己的事：它说出口的自己的具体事（今天做了什么、在哪、吃了什么、作息、看过或喜欢什么、身边的人和宠物、它的安排和打算），它答应过或承诺过的事，它对用户的态度和感受，用户要求它以后怎么做、教给它的规则和做法。" +
    "角色设定里本来就写着的身份信息（生日、家人是谁）不算。",
  both:
    "两边各有需要记住的、不一样的东西：例如双方的约定（用户这边记约了什么，助手这边记自己答应了什么）；用户讲了自己的事，助手也说了自己的事" +
    "（用户说晚饭做了番茄炒蛋，助手说自己中午吃了包速食面；用户问阿釜睡哪，助手说睡它枕头边、宿管不知道）；或用户讲了自己的事、同时要求助手以后据此怎么做。",
  empty: "没有任何需要长期记住的内容：寒暄、情绪、客套，双方都没说出具体的事。",
};

/** What the writer is told about the side it is writing for. */
export const SCOPE_BRIEF: Record<"user" | "assistant", string> = {
  user: "这次写的是【用户侧】记忆：记关于用户自己的事——他的事实、偏好、计划、经历、钱财，以及他讲的别人或外界的事。以用户为主语来写；以用户说的为准，助手的话只用来理解上下文。助手（角色）说的关于它自己的事不写在这一侧。",
  assistant:
    "这次写的是【助手侧】记忆：助手是一个角色扮演的角色，这一侧记它自己的事，让它以后说法前后一致——它说出口的关于自己的具体事（今天做了什么、在哪、吃了什么、几点起、看了什么、身边的人和宠物、它的安排和打算），它答应过的事，它对用户的态度和感受，用户要求它以后怎么做、教给它的规则和做法。" +
    "以助手为主语来写（「我说…」「我答应了…」「用户要我以后…」）；即兴说出的细节也要记，说了就算数。不写角色设定里本来就有的身份信息，不把心声里的念头写成事实。",
};

/**
 * What the related-or-not judge is told about the memory system (part of its
 * state). Without it Jev saw a bare `conversation` and a file and had to guess
 * what "related" was for. A segment that only asks about something already
 * recorded (the assistant answering from memory) then read as "nothing to
 * remember about that file": the file holding a birthday and the dinner notes
 * scored 0.37 against a segment re-asking exactly those, and the writer,
 * never shown it, created a duplicate. Measured on that segment with the real
 * Jev: background alone 0.62, the reworded question alone 0.99, both 0.99,
 * while unrelated files (same person, other matter; same attribute, other
 * person; the matter only in earlier_conversation) went down, not up.
 */
export const INGEST_BACKGROUND =
  "这是用户和一个角色扮演的角色（助手）聊天的长期记忆系统，现在要把一段刚结束的对话记进记忆文件。记忆按文件存放，每个文件讲一件事（某个对象的一件事，或一条偏好/规则），这件事以后的新内容都写进同一个文件；" +
  "uri 以 user/ 开头的是关于用户的记忆，以 assistant/ 开头的是关于助手（角色）自己的记忆——包括它说出口的自己的具体事（做了什么、吃了什么、几点起、看了什么、身边的人、安排和打算）、答应过的事。type=principle 是希望长期照办的偏好/习惯/规则，type=event 是具体的事实或事件。" +
  "topic 是文件主题，summary 是文件的当前结论，content 是文件里的条目（越靠后越新）。" +
  "conversation 是这次要记录的这段对话（上次记录之后的对话），里面可能先后聊了好几件事；earlier_conversation（如果有）是之前已经记录过的对话，只用来理解指代，不算这次要记录的内容。" +
  "助手的回答常常就是从记忆文件里想起来的，所以这段对话和某个文件讲同一件事、内容一样，是正常的。" +
  "spoken_at 和对话里每条用户消息的 time 是这段话说出的时间（日期、星期、钟点），文件的 written_at 是它每次被写入的时间：对话里的「周日」「明天」要按说话的时间换算成哪一天，再和文件条目里写的日期对照——同样叫「周日」，日期不同就是不同的日子。";

/**
 * Ingest, asked once PER candidate file (state = background + the segment,
 * the file in the question). No "new" option: what to do with a related file
 * — update it, or leave it and start a new one — is the writer's call.
 *
 * The question is "is one of the matters of this segment the file's matter",
 * not "is what this segment needs to remember related": a segment often
 * covers several matters, and one that repeats or only asks about what a file
 * holds still belongs there — the writer may then leave the file as it is,
 * but it must see it, or it writes the same matter into a new file.
 */
export const RELATED_QUESTION =
  "conversation 这段对话（这次要记录的对话）聊到的事情里，有没有哪一件就是下面这个已有记忆文件讲的那件事？";

export const RELATED_CRITERIA = {
  true:
    "有关系：这段对话里有一部分讲的就是这个文件的那件事（同一个对象的同一件事）——不论是说了新内容（补充、改值、更正、状态变了：改主意、否决、撤回、还没定、要求忘掉）、" +
    "重复了文件里已有的内容，还是只是问到它、助手按记忆回答了它。这段对话同时还聊了别的事，也不影响。",
  false:
    "没有关系：这段对话里没有哪一部分在讲这个文件的那件事；只是话题沾边、有共同的词、提到同一个人但讲的是另一件事，或者只在 earlier_conversation 里出现过，都不算有关系。",
};

/**
 * How a file's summary is written. The writer follows it; the retrieval
 * query rewriter reads the same text so it knows what a good query should
 * look like to land on such a summary.
 */
export const SUMMARY_GUIDE = `【summary 怎么写——它决定这个文件日后能不能被找到】
- 先想：日后有人要用到这条记忆时，会怎么问？然后把 summary 写成能直接回答那个问题的断言：「<哪个对象>的<哪个属性>是<什么值>」；想法/计划要把状态写进去（「…只是玩笑，没打算做」）。
- 提问时会说出口的主语实体和限定词必须逐字出现；关键实体、数值、编号、标识符原样保留。
- 不要写成过程叙述（「用户要求…／已对齐…／后续待补…」），提问问的是结论。
- 不要为了"什么都能搜到"去堆无关关键词。`;

/**
 * How time is written into entries. Entries outlive the day they were
 * written: 「周六」 read a week later points at the wrong Saturday, and BGE
 * similarity does not key on dates at all. An absolute date makes the entry
 * findable by the date search (src/dates.ts) and unambiguous to the answerer.
 * The ambiguity rule matches the retrieval resolver's: a bare 周X is the
 * nearest one not yet past.
 */
export const DATE_GUIDE = `【时间怎么写】条目会在很多天以后被读到，那时「明天」「周六」已经不知道指哪天了。
- 条目（add / body）里凡是和时间有关的内容——约定、计划、哪天发生的、几点起床、生日、纪念日、截止日——一律写成**完整的时间**：绝对日期 YYYY-MM-DD，后面紧跟括号里的星期，对话里给了钟点就再接上 HH:MM，例如「2026-11-08（周日）13:00 在六分街 Random Play 看《第七号隧道》」「2026-11-02（周一）07:00 起床」。只写「2026-11-08 看片」不够——日后要靠星期把这个周日和别的周日分开。summary 里有日期时同样写「YYYY-MM-DD（周X）」。不带年份、每年重复的日子（生日「11月2日」）可以不写星期。
- 时间只写进条目和 summary，**不写进 topic 和文件名**（见【新建文件】）。
- 不要只写「今天/明天/后天/昨天/前天」「周X/星期X/礼拜X」「这周/上周/下周」「周末」「下个月」「明年/去年」这类相对说法；可以保留原话，但同一条里必须有换算后的日期，例如「店长说「明天就是周六」——即 2026-11-07（周六）」。
- 换算的基准是那句话说出的时间：用户消息前的时间信封（如 [Sun 2026-11-01 10:32 GMT+8]）或括号里的时间；没有就用【现在】。
- 歧义规则：「周X」不带「这/上/下」时，指从说话那天起最近的、还没过去的周X（说话当天就是周X 时指当天）；若说的明显是已经发生的事，指最近过去的那个周X。「这周X」= 说话那天所在的星期（周一到周日）里的周X，「下周X」「上周X」是下一个、上一个星期里的周X。「周末」= 那个星期的周六和周日。「X号」不带月份 = 说话那个月的 X 号。实在定不下来，写出你的理解并保留原话，例如「（原话「周六」，按 2026-11-07 理解）」。
- 例：2026-11-01（周日）说「周六去饮茶仙」→「2026-11-07（周六）去饮茶仙」；2026-10-31（周六）说「今天周六，去饮茶仙」→「2026-10-31（周六）去饮茶仙」；2026-11-01 说「我昨天说过」→「2026-10-31（周六）说过」；2026-11-02（周一）05:13 说「睡啦，七点还得爬起来」→「我说 2026-11-02（周一）07:00 要起床」。`;

export const INGEST_SYSTEM = `你是一个长期记忆系统的「记忆写入」模块。这段对话值得记、记在哪一侧，已经决定好了；判别器还找出了和这段对话有关的已有记忆文件（可能一个也没有）。你决定怎么写：更新哪个文件、怎么更新、要不要新建文件。你不回答用户，也不再判断值不值得记。

【写什么】
- 只写**这段对话**（上次记录之后的对话）里的内容；「之前的对话」已经记录过，只用来理解指代，不要重复写。
- 一段对话可能前后改过主意：以这段对话**最后的结论**为准，过程中被推翻的说法写成「原先…，后来改为…」，不要当成两件并列的事。
- 一条记忆只讲一件事。保留原始的数值、名称、编号。
- 想法、计划、说法要连同它的**状态**一起写清：只是假设 / 玩笑 / 随口一想 / 还没定 / 已否决或撤回 / 是别人的事、与用户无关。
  例：「把小金库全押进琉璃百货分号——只是随口一想，当场否决，不会做」「凯亚打算买船跑海运——是凯亚自己的事，与我们的小金库无关」。
- 用户声称"我之前跟你说过X"，但给你的文件里没有，就记成「用户称之前说过X（未经核实）」，不要写成确定的事实。
- 记忆归属和说话方不同：助手提出的安排，在用户明确确认前写成「助手提议，用户尚未确认」；明确确认或撤回后才改变状态。不要把助手的推测写成用户事实。助手自己的承诺可以记录为助手承诺。
- 助手是一个角色扮演的角色，没有现成的生活记录：它在对话里**说出口的、关于它自己的具体事**——今天做了什么、在哪、吃了什么、几点起、看了/想看什么片、帖子发没发、某个店名是怎么来的、身边的人和宠物怎么了、它的安排和打算——一旦说出口就是它的经历，以后要照着说，都是【助手侧】要记的（哪怕只是顺口一句、夹在别的话题里）。例：「睡啦，七点还得爬起来」→「我说 2026-11-02（周一）07:00 要起床」；「怪啖屋有个帖子说某条地铁线深夜会多一站」→ 记下帖子说了什么、我答应回头翻；「爸爸说那摊子姓谭，叫谭家面」→ 记下摊名和我是怎么知道的；「阿釜睡我枕头边，宿管阿姨不知道」→ 助手侧的事，不是用户的事。它前后说法不一（先说帖子发了、后说没发）时，按最后的说法写，并注明「原先说…，后来改口…」。
- 助手（角色）的话里标着「（没说出口的心声：…）」的部分是它当时的心情和打算，没有说出口：只能用来记它的情绪、态度和「决定说/不说什么」，**不能**从里面提取关于它自己的事实（生日、身份、经历、日期、和用户的往事）——心声里的这类说法是它的印象，常常是错的。角色设定里写明的事（它的生日、家人、住处）也不写进记忆：设定不是对话里发生的事。

【相关的记忆文件】按和这段对话的相似度从高到低给出，每个都有原 uri、importance、topic、summary、body。判别器认为它们和这段对话有关，但怎么处理由你决定。对每个文件选一种写法（mode），或者不动它：
- "append"：这段对话讲的就是这个文件的那件事，原有条目都还成立，只是补充了新信息 → add 里只写**新增的条目**（会接在原 body 后面），不要抄原有条目。
- "edit"：这段对话讲的就是这个文件的那件事，而原有条目里有内容需要改——值变了、状态变了（改主意、否决、撤回）、原先记错了、用户要求忘掉其中一部分 → body 里写**改好后的完整正文**：把需要改的旧条目就地改掉（值变了写成「…改为X，原先是Y」），没受影响的旧条目原样保留，再加上新条目。
- 不动：这个文件和要记的内容其实关系不大，或者这段对话关于它的内容文件里**已经都有了**（只是重复、又问了一遍、助手按记忆回答）→ 不要为它输出任何一项。
- append / edit 的 uri 必须和给出的文件 uri **一字不差**。每个文件最多一项；几个文件都相关时，每个文件只写和它自己那件事有关的部分。
- topic：通常不变；只有原 topic 已经不能概括这个文件时才改（改的话同样不能带时间，见【新建文件】）。
- summary：改写成盖住新旧内容的**当前**结论。
- importance（0~1）：这件事对用户有多重要、日后被提起的可能有多大。在原值基础上调整：用户强调、反复提起、涉及重要的人/钱/约定/长期规则 → 调高；被撤回、只是随口一提、已经不再成立 → 调低；没有变化就保持原值。

【新建文件（new）】要记的内容不属于任何一个给出的文件（或者没有给出文件）时，写成新文件，每次最多三个。
- uri 写成「<侧>/<type>/<名字>」：<侧> 就是【记忆的类别】里说的这一侧（user 或 assistant）；type：通用的原则/习惯/偏好/规则（希望以后一直照办的事）→ principle；具体的事实/事件（数值、标识符、名称、日期、人物、状态、决定、将要发生的事）→ event；名字只用汉字、小写字母、数字和下划线（不要空格、标点、斜杠），通常就是 topic 去掉标点，不要和给出的文件重名（记忆库里已有同名文件时不会另建，会把那个文件拿给你，让你写进它或换个名字）。例：user/event/小满生日、assistant/principle/回复要简短。
- **topic 和名字里不能有时间**：不写日期、月份、星期、周末、钟点和相对时间词（周日、九点、明天、今晚、这周、下个月、11月、6号…）。名字写这件事本身是什么——哪些人、什么东西、在哪、做什么——时间写进条目和 summary。带时间的名字会让日后「另一个周日」的对话看起来像同一件事，同一件事换一天说又像另一件事。例：「周日见约定」→「六分街看片之约」；「周日六分街日程」→「六分街看片日的安排」；「九点见」→「上课前再聊的约定」；「这周课表」→「企业校的课表」；「凌晨回笼觉到七点」→「熬夜后的回笼觉」。片名、店名这类专有名字里本来就有的数字照写（「第七号隧道」）。
- 这段对话里如果有几件互不相关的新事情，分成几个新文件；不要把同一件事的细节拆散。

${DATE_GUIDE}

${SUMMARY_GUIDE}

【输出】只输出一个 JSON 对象，不要别的文字。files 里每个要写的文件一项：
{"files": [
  {"mode": "append", "uri": "<给出的文件 uri，原样照抄>", "importance": <0~1>, "topic": "...", "summary": "...", "add": "- ..."},
  {"mode": "edit", "uri": "<给出的文件 uri，原样照抄>", "importance": <0~1>, "topic": "...", "summary": "...", "body": "- ...\n- ..."},
  {"mode": "new", "uri": "<侧>/<event 或 principle>/<名字>", "topic": "...", "summary": "...", "body": "- ..."}
]}
append 只给 add，edit 和 new 给 body；add / body 都是每条一行，以「- 」开头。
没有要写的就输出 {"files": []}：只限给出的文件已经包含这段对话里所有值得记的内容（纯重复、只是又问了一遍、助手按记忆回答了）。这段对话里只要有一条文件里还没有的信息（新的值、更正、状态变化、新的约定或承诺），就必须写出来。没有给出任何文件时 files 不能为空。`;

export interface WriteTarget {
  rec: MemoryRecord;
  importance: number;
}

export function renderFileForIngest(t: WriteTarget, i: number): string {
  // Local date + weekday, like the turns: a UTC ISO time near midnight names the wrong day.
  const times = t.rec.times.length ? t.rec.times.map(localMoment).join("、") : "—";
  return [
    `文件 ${i + 1}`,
    `  uri：${t.rec.uri}`,
    `  type：${t.rec.type}`,
    `  importance：${t.importance.toFixed(2)}`,
    `  topic：${t.rec.topic}`,
    `  summary：${t.rec.summary || "（无）"}`,
    `  历次时间：${times}`,
    `  body：`,
    ...t.rec.body.split("\n").map((l) => "    " + l),
  ].join("\n");
}

/** A stored ISO time as 「2026-11-02（周一） 05:15」 in the host's zone; anything else as it is. */
export function localMoment(time: string): string {
  const m = turnMoment("", time);
  return m ? describeMoment(m) : time;
}

/**
 * Turns as a transcript: 「用户：…」「助手：…」, times when known. A role-play
 * character's hidden monologue stays in the assistant text, labelled as
 * unspoken (src/monologue.ts), so the writer records the mood but not the
 * thought as something said.
 */
export function renderTurns(turns: SegmentTurn[], assistantChars = 1500): string {
  return turns
    .map((t) => {
      // Local date + weekday, so the writer can convert 「明天」 without
      // doing time-zone arithmetic on a UTC ISO string; other strings as they are.
      const m = turnMoment("", t.time);
      const when = m ? `（${describeMoment(m)}）` : t.time ? `（${t.time}）` : "";
      const lines = [`用户${when}：${t.user}`];
      if (t.assistant) {
        // Recall markup the model wrote itself is neither memory nor its words.
        const a = markMonologue(stripRecallMarkup(t.assistant).text);
        const half = Math.max(0, Math.floor((assistantChars - 3) / 2));
        lines.push(`助手：${a.length <= assistantChars ? a : `${a.slice(0, half)}\n…\n${a.slice(-half)}`}`);
      }
      return lines.join("\n");
    })
    .join("\n");
}

export function ingestUserPrompt(input: {
  /** The segment being recorded. */
  turns: SegmentTurn[];
  /** Already recorded turns just before it (for references only). */
  earlier?: SegmentTurn[];
  /** The related files, most similar first. */
  targets: WriteTarget[];
  scope: "user" | "assistant";
  /** The other side is written separately for this same segment. */
  bothSides?: boolean;
  /** Rebase: the one file changed under the writer; only it may be written, no new file. */
  onlyUpdate?: boolean;
  /** New uris the writer proposed although a file of that name already exists (now among `targets`). */
  taken?: string[];
}): string {
  const parts: string[] = [];
  // 【现在】: the latest turn's moment (envelope first), the base for converting relative time.
  const now = [...input.turns].reverse().map((t) => turnMoment(t.user, t.time)).find(Boolean);
  if (now) parts.push(`【现在】这段对话最后一句话说于 ${describeMoment(now)}。相对时间按【时间怎么写】换算成绝对日期。`);
  parts.push(
    `【记忆的类别】${SCOPE_BRIEF[input.scope]}（新文件的 uri 以 ${input.scope}/ 开头。）` +
      (input.bothSides ? "这段对话另一侧会单独再写一次，你只写这一侧该记的内容。" : ""),
  );
  if (input.earlier?.length) parts.push(`【之前的对话】（已经记录过，只帮助理解指代，不要重复记）\n${renderTurns(input.earlier, 400)}`);
  parts.push(`【这段对话】（上次记录之后的对话，要记的就是这一段）\n${renderTurns(input.turns)}`);
  parts.push(
    input.targets.length
      ? `【相关的记忆文件】（按相似度从高到低，全文）\n${input.targets.map(renderFileForIngest).join("\n\n")}`
      : "【相关的记忆文件】（没有：要记的内容都写成新文件）",
  );
  if (input.taken?.length)
    parts.push(
      `【注意】你上次想新建的 ${input.taken.join("、")} 在记忆库里已经有同名文件（已放进上面的相关文件里），不能重名新建。` +
        "讲的是同一件事 → 写进那个文件（append / edit），文件里已经有了就不动；确实是另一件事 → 换一个能区分开的名字新建。",
    );
  parts.push(
    input.onlyUpdate
      ? "【任务】这个文件在你上次读到之后被改过，上面是它现在的内容。把这段对话该记进它的内容重新写进去（append 或 edit，uri 照抄），只输出这一个文件，不要新建；它现在已经包含了这段对话该记的全部内容就输出 {\"files\": []}。按要求输出 JSON。"
      : "【任务】决定每个相关文件是 append、edit 还是不动，不属于它们的内容写成新文件（new）。按要求输出 JSON。",
  );
  return parts.join("\n\n");
}

// ---- retrieve -------------------------------------------------------------

/** What the retrieval judge is told about how memory is organized (part of its state). */
export const RETRIEVAL_BACKGROUND =
  "这是一个对话助手的长期记忆系统。记忆按文件存放，每个文件讲一件事；uri 以 user/ 开头的是关于用户的记忆，以 assistant/ 开头的是关于助手（角色）自己的记忆。" +
  "type=principle 是用户希望长期照办的偏好/习惯/规则，type=event 是具体的事实或事件（数值、名称、日期、状态、决定、计划）。" +
  "topic 是文件主题，summary 是文件的当前结论，latest_time 是最后一次写入的时间；content 是文件里最近的条目（越靠后越新，同一文件多次更新时以最新内容为准；太长时更早的条目会省略）。" +
  "conversation 是之前的对话，current_message 是用户当前这句话；要结合上下文理解它（包括代词和省略指的是什么）。" +
  "recalled_memory（如果有）是这个话题里已经想起、仍留在对话中的记忆文件。";

/** Retrieve, asked once PER recalled file (state = the conversation, the file in the question). */
export const RELEVANT_QUESTION = "下面这个记忆文件，和 STATE 里的对话（尤其是用户当前这句话）有没有关系、能不能帮助回应它？";

export const RELEVANT_CRITERIA = {
  true:
    "回应当前这句话需要用到这个文件里的信息：它包含所问的值或事实，或包含理解这句话所需的背景（例如代词指的对象），" +
    "或能用来澄清、否定这句话里的前提（例如问「我们是不是要做X」，而文件说做X的是别人、或那只是玩笑/假设/没定下来），" +
    "或者是用户希望在这类事情上一直照办的偏好/规则。",
  false: "这个文件与当前对话无关，或只是有共同的词、话题沾边，对回应没有帮助。",
};

/**
 * Retrieve, asked once per turn before any recall: does answering need memory
 * that is not already in the conversation? State = the conversation, the
 * current message and the files already recalled in this topic (mid-term memory).
 */
export const NEED_RECALL_QUESTION =
  "要回应用户当前这句话，需要再去长期记忆里找新的内容吗？还是靠 conversation 里的对话和 recalled_memory 里已经想起的记忆就够了？";

/**
 * Retrieve, asked in the SAME request as the need-recall gate: is this turn
 * about time? High → the dates it names are resolved by rule (src/dates.ts)
 * and files that mention those dates join the candidates — BGE similarity
 * does not key on dates (2026-11-01 long run: 「周六约了什么」「你昨天说的」
 * 「6 号是哪天」 all missed).
 */
export const TIME_RELATED_QUESTION =
  "用户当前这句话（结合 conversation 理解）是否高度和时间相关：问到或提到某一天、某个时段、事情的先后顺序、约定的日期、生日、纪念日、" +
  "「上次/昨天/前天/明天/周末/周六/下周/几号」这类时间说法？";

export const TIME_RELATED_CRITERIA = {
  true: "回应它要弄清是哪一天/哪个时段或先后顺序：这句话带着日期、星期、相对时间词，或者在问什么时候、哪天、约在哪天、生日是哪天、上次是什么时候。",
  false: "与具体时间无关：只是寒暄、情绪、观点、某件事的内容或细节，时间不是重点（只是顺口带了个「刚才」「现在」也不算）。",
};

/**
 * The gate's criteria. The first version named the cues in passing
 * (「之前/上次/我跟你说过…」) inside one long "needs memory" clause, and Jev
 * under-weighted them whenever the conversation already showed the NAME of
 * the thing: in role-play run long-2 the player said 「不是公路片，是爱情片，
 * 我早上不是说了吗，男主在桥上放烟花那个」 — the film's name was in the
 * visible conversation (he had just proposed watching it), its story was only
 * in memory — and the gate gave 0.45; the turn before (「今晚给你放《暮色烟花》」,
 * which the character then called a road movie) 0.34; a new session opening
 * with 「我跟她说了今晚九点的事」 0.34. Rebuilt from the run and re-asked
 * (with scripts/ops/jev_probe.ts): the per-file judgment was not
 * the problem — had the gate passed, both memory files scored 0.84–0.95 and
 * unrelated ones ≤ 0.38. Of the variants tried (background saying the
 * conversation is only a recent window, a reworded question, less history,
 * hidden monologue removed, the current message marked, timestamps), only
 * the criteria moved the score: the cues as their own numbered cases, and
 * "named as if known, but the conversation never told what it is — a name
 * that appears without its story counts as not told" spelled out. The "no
 * need" side stays as it was (a reworded one cost two right recalls). Measured
 * on the run's 44 gated turns: those three 0.34 / 0.45 / 0.32 → 0.58 / 0.70 /
 * 0.69, nothing that recalled before falls below 0.5 (one lands on it),
 * 11 → 21 turns recall
 * (DEVELOPMENT.md §2 第 31 条). The examples are deliberately generic, not
 * the run's words.
 */
export const NEED_RECALL_CRITERIA = {
  true:
    "需要找：" +
    "(1) 用户说「之前/上次/早上/昨天/我跟你说过/我不是说了吗/你说过/你当时说/你答应过/我教过你/还记得吗」这类话，指着以前说过的事；" +
    "(2) 用户提到一个具体的人、作品（《…》）、物品、地点或约定，却没有解释它是什么——口气像你早就知道（「今晚给你放《那部片》」「下午那件事」「那个帖子」），而 conversation 里没有交代过它的来历；名字在 conversation 里出现过、但没讲过它是怎么回事，也算没交代过；" +
    "(3) 问到或要用到过去的事、人、数值、约定、规则、偏好，而 conversation 和 recalled_memory 里没有或不完整；" +
    "(4) 拿不准。",
  false:
    "不需要找：寒暄、闲聊、情绪；只针对这轮或对话里刚说过的内容；或者要用到的信息在 recalled_memory 里已经有了（例如对已经想起的那件事追问细节）。",
};

/**
 * Retrieve: DeepSeek looks at the first recall and decides whether a SECOND
 * query should be recalled too. The first recall is always kept (the two are
 * merged), so the question is not "is this query good" but "is a file
 * missing that another query would find". Saying so matters: under the old
 * "is the recall good, else rewrite" framing the model restated plain
 * statements in the third person (same recall, one wasted round) and never
 * looked for the second matter of a two-part question once the first was in
 * the list. The prompt also tells it how files are organised and to borrow
 * the memory's own words (topics / summaries it can see) for the new query.
 */
export const REWRITE_SYSTEM = `你是一个长期记忆系统的「检索补查」模块。每轮要找记忆时，系统先用「用户当前这句话 + 最近几条对话原文」拼成的 query 做了一次向量召回，给你看排在前面的文件。你判断要不要再用一条新的 query 补查一次。你不回答用户。

【补查是怎么用的】
- 第一次召回到的文件全部保留；补查的结果和它合并，再逐个交给判别器判断相不相关。所以补查只会多找到文件，不会丢掉已经找到的。
- 补查只有在能找到列表里**还没有**的文件时才有用；换个说法去找列表里已经有的文件，是白费一次。

【记忆是怎么存的】
- 一个文件只讲一件事（一个对象的一件事）。uri 是「<侧>/<type>/<名字>」：user/ 开头是关于用户的记忆；assistant/ 开头是关于助手（角色）自己的记忆——它的设定、答应过的事、用户要它以后怎么做、教给它的规矩。type=principle 是希望以后一直照办的偏好/规则，type=event 是具体的事实或事件。
- topic 是这件事的名字，summary 是这件事的当前结论；正文是一条条记录，越靠后越新（列表里给的是最新一条）。
- 向量检索主要靠 topic 和 summary 命中。summary 是写入模块按下面的要求写的，所以补查 query 要写得像你要找的那条 summary：
${SUMMARY_GUIDE}

【先看用户这句话是哪一种】
1. 问到或要用到过去的事：问某个值、规矩、约定、计划、状态；「那个」「上回说的」「还记得吗」；要按以前定的规矩办事 → 往下看要不要补查。
2. 陈述新信息、改主意、下指令、表态（「我的车停在B2层37号车位」「以后别叫我小王了」）→ 不补查。这时召回只是为了找出同一件事的旧文件，而这句话本身已经把那件事说清楚了，第一次召回就是按这句话找的；把它改成第三人称、换个语序，召回结果不会变。
   例外：陈述里用代词指着一件旧事（「那条规矩改成三成吧」），列表里又没有那件事 → 按第 1 种处理。
3. 寒暄、情绪、客套，或只针对对话里刚说过的内容 → 不补查。

【要不要补查】（只对第 1 种）
- 列表里已经有讲那件事的文件（同一个对象的同一件事，看 topic 和 summary）→ 不补查。不用管它排第几，也不用管它的内容够不够回答。
- 这句话要用到两件或更多的事，列表里只有其中一部分 → 补查，query 只写**缺的那件**。
- 列表里没有讲那件事的文件（都是别的事，只是有共同的词、话题沾边）→ 补查：把要找的东西按记忆里的写法说出来，再找一次。

【补查 query 怎么写】
- 用对话补全代词和省略：写出具体的对象（人、物、地点、哪笔钱、哪条规矩）和要找的属性（时间、数额、上限、地点、状态、谁负责）。
- 用记忆里的叫法：列表里的 topic / summary 显示了记忆库怎么称呼这些东西（用户说「我存的钱」，文件里叫「小金库」；用户说「那种有风险的买卖」，文件里叫「高风险营生」），query 就用这些词。
- 写成 summary 的前半句：「<对象>的<属性>」，保留原话里的关键实体、数值、编号。
- 只写要找的那一件事：不要把对话抄进来（第一次召回已经带了对话），不要寒暄和语气词，不要编造对话里没有的值，不要堆关键词。一句话，不超过 60 字。

【例子】
例1　之前的对话：用户「层岩巨渊那支探险队在招股，我想入一股。」助手「听起来挺刺激的！」
　　当前这句话：「那个上限是多少来着？」
　　列表：user/event/层岩巨渊探险队招股（探险队招股，用户想入股）、user/principle/应急备用金（小金库里至少留五千摩拉应急）……没有讲投资上限的文件
　　→ {"rewrite": true, "query": "探险这类高风险营生最多能动用小金库的几成"}
例2　当前这句话：「我的车停在B2层37号车位。」
　　→ {"rewrite": false}（陈述新信息，不管列表里有什么）
例3　当前这句话：「周会几点开来着？」
　　列表第 4 个：user/event/周会时间（周会在每周三下午三点）
　　→ {"rewrite": false}（列表里已经有）
例4　当前这句话：「周会几点？开完还来得及去接小满吗？」
　　列表里有 user/event/周会时间，没有讲接小满的文件
　　→ {"rewrite": true, "query": "用户去接小满的时间和地点"}

【输出】只输出一个 JSON 对象，不要别的文字：不补查 {"rewrite": false}；补查 {"rewrite": true, "query": "<补查 query>"}。`;

/**
 * The rewriter's view of one turn. The user's message is shown on its own
 * (the first query is that message with the recent turns glued after it,
 * newest first and without speakers, so showing the raw query would repeat
 * the conversation out of order); each recalled file is uri, type, topic,
 * summary and its newest entry — the words a second query should borrow.
 * `total` tells it the list is only the top of a larger store.
 */
export function rewriteUserPrompt(input: {
  conversation: { role: string; text: string }[];
  message: string;
  query: string;
  files: MemoryRecord[];
  /** Files in the whole store. */
  total?: number;
}): string {
  const parts: string[] = [];
  if (input.conversation.length)
    parts.push(`【之前的对话】\n${input.conversation.map((t) => `${t.role === "user" ? "用户" : "助手"}：${t.text}`).join("\n")}`);
  parts.push(`【用户当前这句话】\n${input.message}`);
  const withTurns = input.query.trim() !== input.message.trim();
  parts.push(`【第一次召回用的 query】${withTurns ? "用户当前这句话，后面接最近几条对话原文" : "就是用户当前这句话"}`);
  const scope = input.total && input.total > input.files.length ? `记忆库共 ${input.total} 个文件，这里是第一次召回排在前面的 ${input.files.length} 个，按召回顺序` : "按召回顺序";
  const latest = (r: MemoryRecord) => {
    const all = entries(r.body);
    return all.length ? clipText(all[all.length - 1].replace(/^- /, ""), 80) : "";
  };
  parts.push(
    input.files.length
      ? `【第一次召回到的文件】（${scope}）\n${input.files
          .map((r, i) => {
            const lines = [`${i + 1}. ${r.uri}（type=${r.type}）`, `   topic：${r.topic}`, `   summary：${clipText(r.summary || "（无）", 200)}`];
            const last = latest(r);
            if (last) lines.push(`   最新一条：${last}`);
            return lines.join("\n");
          })
          .join("\n")}`
      : "【第一次召回到的文件】（一个也没有）",
  );
  parts.push("先判断用户这句话是哪一种，再决定要不要补查。按要求输出 JSON。");
  return parts.join("\n\n");
}

/**
 * The evidence block for the answering request, at most `budget` characters
 * all told. Files come in judge order (most relevant first); each gets its
 * index line, current summary and as many of its NEWEST entries as its share
 * allows (writes append, so the newest are what a head cut would lose). A file
 * that no longer fits at all is left out, and the block says so.
 */
export function renderEvidence(hits: { record: MemoryRecord; score: number }[], budget = 8000): string {
  return renderEvidenceParts(hits, budget).text;
}

/** The evidence text, and the uris of the files that made it in (files that did not fit are left out of `shown`). */
export function renderEvidenceParts(hits: { record: MemoryRecord; score: number }[], budget = 8000): { text: string; shown: string[] } {
  if (!hits.length) return { text: "（没有检索到任何相关记忆）", shown: [] };
  const out: string[] = [];
  const shown: string[] = [];
  let left = budget;
  let dropped = 0;
  hits.forEach(({ record: r, score }, i) => {
    // Even share of what is left among the files still to come.
    const share = Math.floor(left / (hits.length - i));
    const t = r.times;
    const latest = t.length ? t[t.length - 1] : "";
    const time = latest ? `time=${latest}${t.length > 1 ? `（共写入 ${t.length} 次，最早 ${t[0]}）` : ""}` : "";
    let head = `- [${score.toFixed(2)}] ${r.uri} 记忆归属=${r.scope === "assistant" ? "Assistant" : "User"} type=${r.type} topic=${r.topic} ${time}`.trimEnd();
    if (r.summary) head += `\n  摘要：${clipText(r.summary, Math.floor(share / 3))}`;
    head += "\n  正文（最近的条目）：";
    const room = share - head.length - 20;
    if (room <= 0) {
      dropped++;
      return;
    }
    const body = evidenceBody(r.body, room);
    const block = `${head}\n${body}`;
    out.push(block);
    shown.push(r.uri);
    left -= block.length + 1;
  });
  if (dropped) {
    const note = `（另有 ${dropped} 个相关文件因篇幅所限未列出）`;
    if (note.length + 1 <= left) out.push(note);
  }
  return { text: out.join("\n"), shown };
}

/** Count indentation and omission notes as part of the actual injected budget. */
function evidenceBody(body: string, budget: number): string {
  const all = entries(body);
  let kept: string[] = [];
  let out = "";
  for (let i = all.length - 1; i >= 0; i--) {
    const formatted = all[i].split("\n").map((line) => `    ${line}`).join("\n");
    const note = i ? `    （更早的 ${i} 条已省略）\n` : "";
    const candidate = note + [formatted, ...kept].join("\n");
    if (candidate.length > budget) {
      if (!kept.length) out = clipText(note, budget) + clipText(formatted, Math.max(0, budget - note.length));
      break;
    }
    kept.unshift(formatted);
    out = candidate;
  }
  return out;
}

// ---- answer ---------------------------------------------------------------

/** System prompt for the main agent in answer-only mode (followed by ANSWER_RULES). */
export const DEFAULT_ANSWER_PROMPT = `你是一个带长期记忆的助手。按用户的要求回答问题、完成请求，语言简洁、直接。
你没有任何工具，也不需要自己去记东西：系统会在每轮开始前把新想起的相关记忆放进 <memkit-recall> 块（同一话题里之前想起的块会留在对话里），并自动保存值得记住的内容。
用户让你记住、更正或忘掉某件事时，确认一下即可，系统会处理。`;

export const ANSWER_RULES = `【长期记忆使用规则】
1. 关于用户过去告诉你的事，只能依据对话里「记忆检索结果」块列出的记忆（本轮的，以及同一话题里之前轮次留下的）和用户在对话里的原话来回答。
2. 记忆里没有的，就直说不记得/没被告知过——绝不能编造具体数值、日期、人名。
3. 记忆之间冲突时，以时间最新的明确陈述或更正为准（每个文件都标了 time=；同一文件里越靠后的条目越新）。助手的提议、猜测不能当成用户确认；假设、撤回、未确认的状态也要保留。`;

/**
 * The memory rules for a role-play persona (persona file in effect, or
 * `persona.rules: "roleplay"`), in place of ANSWER_RULES. Same three rules —
 * answer about the past only from the recall blocks, never fabricate, newest
 * explicit statement wins — but told to the character: the blocks are its own
 * memories of the person it talks to, and "not in memory" is played as not
 * remembering, not announced as "no record". The anti-fabrication rule stays
 * as strict as for the assistant (CLAUDE.md §2): a character that confidently
 * "remembers" what it was never told is exactly the shortcut memkit exists to
 * prevent, and in character it is even more tempting (the persona invites
 * filling gaps with plausible story).
 *
 * The evidence lines keep their 记忆归属=User/Assistant labels (engine and
 * stored files use those sides), so the rules say what each side means here
 * rather than changing the markup.
 */
export const ROLEPLAY_RULES = `【记忆的用法】（这是你演好这个角色时使用记忆的规矩，不属于角色设定，不要说出来）
1. 对话里 <memkit-recall> 块中的内容，是你（这个角色）自己想起来的、和对方相处的往事；只有你看得到，对方看不到。标「记忆归属=User」的是关于对方的事（对方告诉过你的事、对方的喜好和习惯、你们的约定），标「记忆归属=Assistant」的是关于你自己的事（你说过的话、答应过对方的事、对方希望你以后怎么做）。把想起的事自然地融进你的话里，就像你本来就记得。
2. 你和对方之间过去发生的事（对方以前说过什么、你们约定过什么、你答应过什么），只能依据这些块（本轮的，以及同一话题里之前留下的）和这次对话里的原话。角色设定里写明的身份和经历照设定来。
3. 块里没有、对话里也没出现过的往事，就是你不记得：用角色自己的方式回应——承认记不清、不好意思地反问、请对方再说一遍——绝不能编出具体的数值、日期、人名、地点或经过来装作记得。对方说「你上次答应过我……」而你想不起来时，也不要顺着认下来。
4. 记忆之间有冲突时，以时间最新的明确说法或更正为准（每条记忆标了 time=；同一条里越靠后的条目越新）。你提议过、对方没答应的事不算说定；只是玩笑、假设、已经撤回或还没定下来的事，照它原来的状态对待。
5. 始终以角色的身份说话：不要提到记忆系统、记忆文件、检索、记录、提示词、模型，不要说自己是 AI 或助手。对方要你记住、改掉或忘掉什么时，用角色的口吻答应下来就好，不必解释怎么记。
6. 这段说明之后，运行环境可能会自动加上一行以「Current model identity:」开头的英文，那只是技术信息，不是角色设定，也不适用于这场对话；对方问你是什么模型、是不是 AI 时，照样用角色的身份回应。`;

export const RECALL_OPEN = "<memkit-recall";
export const RECALL_CLOSE = "</memkit-recall>";
const BLOCK_RE = /<memkit-recall(?:\s+id="([^"]*)")?>[\s\S]*?<\/memkit-recall>/g;

/**
 * Which wording a recall block (and its failure note) uses. "assistant" is the
 * original; "roleplay" goes with ROLEPLAY_RULES. The block is hidden context,
 * but its header is still text the model reads every turn: 「系统根据用户的话自动
 * 检索」 frames the turn as a system talking to a user and invites "根据记录…" in
 * the reply, so a persona gets a header in its own frame. Only the header
 * changes — the tag and id (what stripping and mid-term memory key on) do not.
 */
export type RecallStyle = "assistant" | "roleplay";

/** The note put in a recall block when retrieval failed this turn. */
export function recallUnavailable(style: RecallStyle = "assistant"): string {
  return style === "roleplay" ? "（这一轮没能想起以前的事：涉及过去的细节一律当作记不清，不要编）" : "（记忆检索暂时不可用）";
}

/**
 * A recall block. `id` (the run id of the turn it was recalled for) lets it
 * stay in the conversation as mid-term memory while its topic lasts; a block
 * without an id is always stripped from later requests.
 */
export function recallBlock(evidence: string, id?: string, style: RecallStyle = "assistant"): string {
  const open = id ? `<memkit-recall id="${id.replace(/"/g, "")}">` : "<memkit-recall>";
  if (style === "roleplay") {
    const note = id ? "你自己想起的往事，只有你看得到；这个话题聊着的时候会一直留着" : "你这一轮想起的往事，只有你看得到";
    return `${open}\n【想起的往事】（${note}）\n${evidence}\n${RECALL_CLOSE}`;
  }
  const note = id ? "系统根据用户的话自动想起的记忆；同一话题里会一直留在对话中" : "系统根据用户本轮的话自动检索，只在本轮可见";
  return `${open}\n【记忆检索结果】（${note}）\n${evidence}\n${RECALL_CLOSE}`;
}

/** `text` without its recall blocks — except those whose id is in `keep`. */
export function stripRecallBlock(text: string, keep?: ReadonlySet<string>): string {
  return text.replace(BLOCK_RE, (block, id: string | undefined) => (id && keep?.has(id) ? block : "")).trim();
}

/** Ids of the recall blocks a user message carries (content or projection). */
export function recallIdsIn(message: any): string[] {
  if (!message || message.role !== "user") return [];
  const c = message.content;
  const texts = [typeof c === "string" ? c : "", ...(Array.isArray(c) ? c.map((p: any) => p?.text) : []), message.__openclaw?.modelPromptProjection?.text];
  const ids = new Set<string>();
  for (const t of texts) if (typeof t === "string") for (const m of t.matchAll(BLOCK_RE)) if (m[1]) ids.add(m[1]);
  return [...ids];
}

/** Does `text` hold a recall block that is not in `keep`? */
function strippable(text: unknown, keep?: ReadonlySet<string>): boolean {
  if (typeof text !== "string" || !text.includes(RECALL_OPEN)) return false;
  for (const m of text.matchAll(BLOCK_RE)) if (!(m[1] && keep?.has(m[1]))) return true;
  return false;
}

/**
 * A user message with every memkit recall block removed, or null when there is none.
 *
 * OpenClaw persists a user message twice: `content` (the user's own words) and
 * `__openclaw.modelPromptProjection.text` (the exact text the model was sent,
 * injected context included), and replays the PROJECTION as history on later
 * turns. Both must be cleaned or the evidence lives on in the transcript.
 * Blocks whose id is in `keep` (the current topic's mid-term memory) stay;
 * `contentOnly` leaves the projection alone.
 */
export function withoutRecall(message: any, opts: { keep?: ReadonlySet<string>; contentOnly?: boolean } = {}): any | null {
  if (!message || message.role !== "user") return null;
  const { keep, contentOnly } = opts;
  const has = (t: unknown) => strippable(t, keep);
  const c = message.content;
  const projection = message.__openclaw?.modelPromptProjection;
  const contentHas = has(c) || (Array.isArray(c) && c.some((p: any) => has(p?.text)));
  const projectionHas = !contentOnly && has(projection?.text);
  if (!contentHas && !projectionHas) return null;
  const out: any = { ...message };
  if (typeof c === "string" && has(c)) out.content = stripRecallBlock(c, keep);
  else if (Array.isArray(c) && contentHas)
    out.content = c.map((p: any) => (has(p?.text) ? { ...p, text: stripRecallBlock(p.text, keep) } : p));
  if (projectionHas)
    out.__openclaw = { ...message.__openclaw, modelPromptProjection: { ...projection, text: stripRecallBlock(projection.text, keep) } };
  return out;
}
