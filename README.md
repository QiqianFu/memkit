# memkit

**English** | [简体中文](README.zh-CN.md)

**A memory plugin for OpenClaw role-play companions that does not let the character fake memory** — plus a complete example character, 浮波柚叶 (Ukinami Yuzuha) from *Zenless Zone Zero*, for a long-running one-on-one WeChat chat.

**The one idea.** A single LLM call can produce fluent text that *sounds* like
the character remembers what you said last week while fabricating it. In
memkit, what the character knows about the player and their shared past comes
**only** from recalled evidence: the answering model has no tools and sees only
the persona, the current conversation and the evidence; all memory writes
happen in one ingest step after the turn; every pass/fail decision is a
discriminative judgment (Jev), and the generative model (DeepSeek) only writes.

## How it works

The ingest → retrieve → answer pipeline:

| Stage | Where it runs in OpenClaw | Discriminative calls (Jev) | Generative calls (DeepSeek) |
|---|---|---|---|
| **ingest** | `agent_end` hook, by segment: each turn is first judged against the turns since the last record (*did the topic change?*, Noul); only then is that segment recorded. `before_reset` / `session_end` flush the rest | *worth storing?* (Noul on the segment; the character's own concrete statements about itself count) + *whose memory?* (Choice: user / assistant / both / empty, same request; empty = skip, both = run the rest once per side; what the role-play character says about its own day, likes, plans, people and promises is the assistant side, its persona-card facts and hidden monologue are not); then the candidates — BGE's 10 files of that side most similar to the segment, plus up to 5 more: files this session's recent segments wrote and lexical matches on topic/summary — and Jev judges each in its own request: *related to what is being recorded?* (Noul, no "new" option) | gets the related files (P ≥ 0.5), most similar first, at most 3, and decides per file as JSON: `append` the new lines, `edit` the whole corrected body (both name the file's uri exactly, with a re-rated importance), leave it, or `new` files at a legal uri `<side>/<principle\|event>/<name>`; `{"files": []}` when the related files already hold everything. A reply that breaks these rules is sent back once with what was wrong; a `new` named like an existing file is sent back once with that file shown |
| **retrieve** | `before_prompt_build` hook, before every turn | first *does answering need memory not already in the conversation?* (Noul; the state carries the topic's already-recalled files) — no → nothing recalled this turn; yes → BGE-M3 recalls the top 10 files of both sides by similarity × (1 + importance) × forgetting; then ONE request per file — state = the whole conversation, question = the file: *relevant to this conversation?* Only files that pass become evidence | looks at the first recall's summaries and either keeps the query or rewrites it (JSON `{"rewrite": …, "query": …}`, guided by the writer's summary rules); a rewrite recalls again and the two recalls are merged. Never decides what passes |
| **answer** | the main agent — no tools, minimal answering prompt (`mainAgent: "answer-only"`) | — | — (evidence is appended to the current request in a `<memkit-recall>` block) |

**Time awareness.** The recall gate's request carries a second Noul, *is this turn highly time-related?* (`time_related`: a day, a period, an order of events, an agreed date, a birthday, 上次/昨天/周末…). When it fires, the dates the message names are resolved to `YYYY-MM-DD` by hard-coded rules in `src/dates.ts` (no model call; "today" is the date in the host's time envelope `[Sun 2026-11-01 10:32 GMT+8]`, else the host's local date): 今天/明天/后天/昨天/前天, 周X/星期X/礼拜X with 这/上/下 prefixes, 上/这/下个周末, X月X日/X号, 明年/去年, and explicit dates. Files whose topic/summary/body name one of those days (or were written on it) are ranked by those hits and up to `timeFiles` of them take the first places of the 10 candidates; BGE fills the rest, and the Jev judgment is unchanged (its state gets a `time_reference` with what the words resolved to). Nothing resolvable → the normal path, with `time_related` still traced. On the write side the writer must put full timestamps in entries — `2026-11-08（周日）13:00 …`: absolute date, its weekday, and the clock time when the conversation gives one (it is given the segment's date, weekday and time) — and a new entry that has relative time words but no absolute date, or a dated entry (with a year) whose weekday is missing or wrong, is sent back once through the writer's corrective round, then accepted. **Titles carry no time**: a file's topic and uri name never contain a date, month, weekday, weekend, clock time or relative time word (「周日见约定」 → 「六分街看片之约」); time goes into the entries. A `new` (or a renamed topic) that breaks this is sent back once with the reason; still timed after that, it is kept and traced as `title_time` (stripping would mangle proper names such as a film title). The same-name check compares titles with their time words removed too, so 「六分街看片约定」 collides with an older 「周日六分街看片约定」. Every ingest Jev judgment sees when the segment was said: the gate/scope and per-file related states carry `spoken_at` (date, weekday, clock) and each user turn's `time`, and a candidate file shows its write times (`written_at`, local with weekday).

**What the recall gate counts as "needs memory".** The conversation Jev sees is only a recent window (`historyChars`), so the gate's yes-criteria spell out two cases on their own besides "asks about the past and the conversation/recalled files lack it": (1) the user points back — 「之前/上次/早上/我跟你说过/我不是说了吗/你说过/你答应过/还记得吗」; (2) the user names a person, work, thing, place or arrangement as if it were known, and the conversation never told what it is — a name that appears in the conversation without its story counts as not told. Without (2) the gate stayed below 0.5 whenever the name was already visible (long-2: 「我早上不是说了吗，男主在桥上放烟花那个」 0.45, after the player had just named the film). The per-file relevance question was not the problem there (the two files scored 0.84–0.95 on the same turns) and is unchanged. Details: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) §2, item 31.

BGE only recalls; nothing reaches the answering model or the writer without
a Jev judgment. Code decides the rest: thresholds, recall size, which files a
write may touch (only those shown to the model). File vectors are cached in
`<store>/.embeddings.json` and re-embedded only when a file changes. Without
an embedding service (no token, or a failing request) recall falls back to BM25.

**Segments are durable jobs.** `agent_end` stores the full User/Assistant pair
and the host run id before calling any model. A topic/size boundary seals an
immutable segment; the gate decision and each side's validated write plan are
saved in SQLite. Each planned action has a stable id. Successful actions are
not regenerated or replayed when another file or the other side fails.
Only successful or explicitly skipped segments enter the committed tail.
Invalid JSON and missing required updates leave the segment available for retry.
A conflicting uncommitted edit is regenerated
against the current file, without repeating already completed actions.

Automatic processing is limited to **three attempts per segment** by default
(`ingest.maxAttempts`, including the first attempt). Attempt counts and the last
error survive restarts. On exhaustion the segment becomes `quarantined`: its
original transcript stays in `.meta.sqlite`, but it no longer calls models or
blocks later segments. After fixing its cause, an operator can explicitly call
`engine.retrySegment(segmentId)` to reset the budget while keeping completed
actions and plans. Ordinary observations and flushes never reset the budget.
An attempt includes the existing bounded JSON-format/conflict retries; it is not
a count of individual HTTP requests.

Only a session's boundaries are serialized. Different sessions can call Jev and
DeepSeek concurrently; the shared store lock covers short state transitions and
file/database commits. Changed file snapshots are rebased at write-back. Hooks
pass `captureTimeoutMs` as a duration, started after acquiring the session slot
and persisting the input. An explicitly supplied external AbortSignal still
retains its caller's deadline.

The file body and its `memkit_actions` receipt are persisted together by atomic
rename (with file/directory sync). SQLite also records the completed action;
the file receipt covers a crash between rename and that database commit. The
receipt's segment id links back to the full source turns and their speaker/run
ids in `.meta.sqlite`. Existing markdown and old pending buffers remain readable.
On each file update, old acknowledged action ids are compacted to a recent
window of **20**. Older ids without a SQLite receipt are also kept until recovery
acknowledges them: a blind slice could discard the only proof of an interrupted
write. The SQLite receipts themselves remain durable. Existing large headers
are compacted on their next update, not by a startup rewrite of the whole store.

**Idle sessions are recorded.** A session with unrecorded turns and no new
message for `idleFlushMinutes` (default 20) has them recorded as one segment —
nothing came after them, so there is no topic change to ask Jev about. A
background timer (one per gateway process, checking every minute) does this
for every agent store, including sessions left pending before a restart, and
skips a session whose turn is under way. A failed segment is retried a full
idle window after its last attempt, so a short model outage cannot use up its
retry budget. Unrecorded turns are not recalled: memkit serves one user, who
talks in one session, where those turns are already in context.

A size boundary links the next segment to the preceding segment's written
files. Those files stay available to Jev even if BGE's shortlist misses them;
the related-or-not state identifies the continuation. Ingest's BGE query includes
**both User and Assistant**, with explicit labels and a bounded share for each
speaker. DeepSeek may propose up to three new files per side in one JSON reply;
a reply that is still invalid after one corrective round writes nothing, and
the segment stays unfinished for a later attempt.

**One topic, one file.** BGE's shortlist alone often missed the file of the
very same topic (a 354-turn role-play run ended with `我的生日`, `我的生日_2`,
`我的生日_3`, `虾饺` / `虾饺请客` / `虾饺食量` …: 125 files in an hour). So the
candidates Jev judges also include, up to `ingest.extraCandidates` (5) beyond
BGE's `ingestCandidates`, the files this session's last 3 recorded segments
wrote and the files whose topic/summary share key terms (CJK bigrams / words,
BM25) with the segment, taken in turn; a size continuation's files come on top.
Each judged candidate records its source (`bge` / `continuation` / `recent` /
`lexical`) in `IngestResult.options` and the trace. A `new` whose name — or
topic — an existing file of that side already has never becomes `<name>_2`:
the writer is asked once more with that file shown, to write into it or pick
a distinguishable name; if it still names the exact uri, its lines are
appended to that file. The store itself refuses to create on a taken uri (a
`Conflict`, which the segment's rebase turns into an update of that file).
Old `_N` files still load. And the writer may write nothing: with related files
shown, `{"files": []}` means they already hold everything the segment says (a
repeat, a re-ask answered from memory); the segment completes as **nothing new**
(a `skip` action with reason `nothing new`, `nothingNew: true` in the trace).
With no related file an empty list is sent back — what passed the gate must go
somewhere.

**Recall markup in a reply is never kept.** The answering model sometimes
imitates the injected evidence and writes `<memkit-recall>…</memkit-recall>`
into its own reply, once with a wholly invented memory. `message_sending`
removes such blocks (and a lone tag, by the monologue rules) from every
outbound message, in every mode; ingest removes them from the assistant text
before Jev, BGE or the writer see it.

**Evidence is mid-term memory for its topic.** Before each answer, Jev decides
whether the message starts a new topic (the ingest segment boundary), in
parallel with retrieval; only files not already recalled in this topic are
appended (`appendContext`) as a recall block tagged with the turn's run id. The
block stays in the conversation at that turn while the topic lasts, so a
follow-up needs no fresh recall and the prefix stays byte-identical (the
provider's prefix cache keeps hitting). When the topic changes, or the
segment's dialogue plus its blocks pass `segmentChars`, the previous segment is
sealed before the answer and the memkit context engine drops its blocks — from
the history it assembles and, after the turn, from the transcript.

**The main agent only answers.** It gets no tools and a system prompt made of
a persona (a role-play character card from `persona.file`, or a minimal
answering prompt) followed by memkit's memory rules; everything it knows about
the past is the injected evidence. With a persona the rules are written for the
character: the recall blocks are its own memories of the person it talks to,
what is not in them it does not remember (played in character, never made up),
and it never mentions memory systems or being an AI.
All writes — including "remember / correct / forget this" — happen in the
ingest step after the turn, so there is exactly one writer. This is enforced,
not requested: an e2e run with a fully-tooled agent showed it rewriting memory
files and restoring them from backups behind the memory system's back.

Two layers keep the main agent tool-less:

1. **Config (authoritative):** `tools.deny: ["*"]`, `tools.codeMode: false` and
   `tools.toolSearch: false` (deny wins over every profile/allow; code mode would
   otherwise expose `exec`, and Tool Search — on by default — still submits a
   `tool_search` tool even with `deny: ["*"]`).
2. **Plugin:** `before_prompt_build` returns `toolsAllow: []` and replaces the
   system prompt (`mainAgent: "answer-only"`, the default). Set
   `mainAgent: "host"` to keep the host's own prompt and tools and only append
   the memory rules.

OpenClaw's built-in file memory (memory-core, `MEMORY.md` / `USER.md` /
`memory/` daily notes) should be disabled so there is no second, divergent copy.

## Status

Everything in this README is implemented and covered by the offline tests
(`npm test`) and by end-to-end runs against a test OpenClaw gateway
(docs/DEVELOPMENT.md §7, 第 9/10 次: 20/20 correct, mid-term memory kept / dropped as
designed). The last offline eval on the 42-scenario gold set (v9a, real Jev +
DeepSeek + BGE) scored 90.5%; it predates the recall gate, mid-term memory and
the query rewrite, and has not been rerun since. What is deliberately left open:

- **Pure re-asks still pass the gate.** A segment in which the user only asks
  and the assistant answers from memory is judged worth storing; the writer
  may now return `{"files": []}` for it (nothing new) instead of appending an
  "asked again" line, but whether it does is the writer's call and has not
  been measured on real role-play data yet.
- **The query rewrite ("补查") has not shown its value yet.** With a small store
  the first recall already holds every file and the rewrite is skipped. To be
  validated on real role-play data with a large store.
- **Compaction and long-term memory are not yet adapted to role-play**: both are future work, as is tuning the size/evidence budgets.
- **Turn latency** on a small (2 GB) VPS is dominated by OpenClaw itself
  (8–10 s on some turns when it pages); memkit costs 0.1–0.5 s per turn plus
  the Jev / BGE / DeepSeek round trips.

## Layout

```
index.ts               OpenClaw plugin entry (hooks, memory capability, context engine; registers no tools)
openclaw.plugin.json   manifest (kind: ["memory", "context-engine"], empty tool contracts, config schema)
src/engine.ts          ingest + retrieve pipelines, topic boundary, mid-term recall blocks
src/dates.ts           rule-based date resolution, date search, writer date check
src/context.ts         context engine: strips ended topics' recall blocks from history, rewrites the transcript
src/turns.ts           per-run turn state shared by the hooks (prompt, recall block, in-flight marker)
src/store.ts           markdown file store: <root>/<user|assistant>/<principle|event>/<topic>.md
src/meta.ts            SQLite metadata: file importance/times, segment jobs, recall blocks, turn decisions
src/judge.ts           Jev client + a DeepSeek-emulated judge with the same contract
src/llm.ts             OpenAI-compatible chat client (DeepSeek)
src/embed.ts           BGE-M3 client + per-store vector cache
src/view.ts            bounded file views: topic + summary + newest entries
src/text.ts            tokenizer (CJK uni+bigrams) and BM25 (fallback recall)
src/prompts.ts         prompts, question wording, recall-block markup
src/config.ts          plugin config + env vars → MemoryEngine
src/persona.ts         persona file loading (mtime reload, fallback) + answer system prompt composition
src/monologue.ts       strips the character's hidden inner-monologue block from outbound messages (transcript keeps it), and recall markup the model wrote itself (outbound + ingest)
scripts/eval_gold.ts   offline experiment harness (inject → probe → grade)
scripts/request_log_proxy.mjs  debug proxy that logs what the host sends to the model
scripts/ops/           e2e runs against a test gateway, trace/log checkers, memory-store backup/reset
tests/                 offline tests with scripted judge/LLM (`npm test`)
data/goldset_v2.json   offline eval set (42 inject → probe scenarios)
examples/              persona card example, OpenClaw config templates (test gateway, Yuzuha on WeChat)
personas/yuzuha/       the Yuzuha character pack (see below)
docs/                  DEPLOY.md (deployment guide), DEVELOPMENT.md (design log, test results)
```

Documents:

- [docs/DEPLOY.md](docs/DEPLOY.md) — external services (Jev, BGE-M3,
  DeepSeek), a test gateway, the Yuzuha deployment on WeChat, memory-store
  backup/reset, troubleshooting.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — design decisions in order (why
  each step is the way it is), test procedure, result log (Chinese).

Memory files are plain markdown with a `key: <json>` frontmatter — readable and
editable by hand; the store picks up outside edits by mtime. Default root:
`<OpenClaw state dir>/memkit/<agentId>/`, with a JSONL decision trace in
`.trace.jsonl` next to the files.

## Install (OpenClaw ≥ 2026.10.7)

```bash
openclaw plugins install --link /path/to/memkit --force --accept-capabilities
```

The installer selects memkit for `plugins.slots.memory`. Also select it as the
context engine (`"plugins": { "slots": { "contextEngine": "memkit" } }`): that is
what keeps recall evidence out of later turns' history — without it the evidence
injected into each request is replayed as history on every following turn. Then grant hook access
(non-bundled plugins need it for `before_prompt_build` / `agent_end`), give the
hooks enough time, turn off built-in memory, and take the agent's tools away:

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

Secrets go in the state dir's `.env` (see `.env.example`):

- `DEEPSEEK_API_KEY` — generative model (default model `deepseek-flash`, `reasoning_effort: low`)
- `JEV_API_KEY` — Jev. When empty, the judge falls back to DeepSeek emulating the
  same Noul/Choice contract (`judge.backend: "auto"`); set `judge.backend: "jev"`
  to require Jev.

Note: one-shot `openclaw agent exec` retires plugins 5 s after the run, which
cuts off the `agent_end` ingest; use a running Gateway (`openclaw agent …`).

## Config

All optional; see `openclaw.plugin.json` for the schema.

| Key | Default | Meaning |
|---|---|---|
| `mainAgent` | `answer-only` | `host` keeps the host's prompt and tools |
| `answerPrompt` | built-in | system prompt for answer-only mode (memory rules are always appended); a readable `persona.file` takes precedence |
| `persona.file` | — | markdown persona card (role-play character) used as the answer-only system prompt; absolute, `~/…` or relative to the OpenClaw state dir; re-read when its mtime/size changes (no restart). Missing/unreadable → one warning, then the last loaded copy, else `answerPrompt`, else built-in. Ignored with `mainAgent: "host"`. Example: `examples/persona.example.md` |
| `persona.rules` | `auto` | memory rules appended after the persona: `auto` = role-play rules when the persona file is in effect, else the assistant rules; `roleplay` / `assistant` force one. The recall-block header follows the same choice |
| `persona.monologue.strip` | `auto` | remove the character's hidden inner-monologue block from outbound channel messages (`message_sending` hook): `auto` = when the role-play rules are in effect; `always` / `never`. The transcript keeps the block (next turn's history and ingest see the character's mood); a reply that was only monologue is not sent |
| `persona.monologue.open` / `close` | `<心声>` / `</心声>` | the block's tags, as the persona card defines them (full-width brackets and spaces inside the tag are tolerated). A lone open tag drops its paragraph; a lone close tag drops everything before it. In the ingest prompts the block is kept but labelled 「没说出口的心声」 so the writer records the mood, not the thought as words said |
| `persona.vars` | `{}` | values for the card's `{{name}}` placeholders (e.g. `{"player_name": "哲"}`); HTML comments in the card are removed before use; an unfilled placeholder is warned about once |
| `embed.baseUrl` / `apiKey` / `apiKeyFile` | — | BGE-M3 service (OpenAI-compatible `/v1/embeddings`; env `MEMKIT_EMBED_BASE_URL`, `MEMKIT_EMBED_API_KEY`). Neither a URL nor a key set, or `embed.enabled: false` → BM25 recall; a key without a URL uses `http://127.0.0.1:8000` |
| `embed.maxChars` | 6000 | characters embedded per input (BGE-M3 stops at 8,192 tokens) |
| `retrieve.recallGate` / `recallAt` | true / 0.5 | ask Jev whether new memory is needed before recalling, and the P it takes to recall |
| `retrieve.timeAware` / `timeAt` | true / 0.5 | ask `time_related` alongside the gate (one request), and the P at which the message's dates are resolved and searched |
| `retrieve.timeFiles` | 3 | at most this many date-matched files lead the `recall` candidates (BGE fills the rest) |
| `retrieve.queryRewrite` | true | DeepSeek may rewrite the recall query after seeing the first recall |
| `retrieve.recall` | 10 | files recalled per turn (ordered by similarity × (1 + importance) × forgetting), each judged in its own request |
| `retrieve.halfLifeDays` | 30 | forgetting: a file not updated for this long counts half in recall order; a file with importance 1 is pinned (no forgetting) |
| `retrieve.k` / `minScore` | 10 / 0.5 | files allowed into the evidence, and the P(relevant) a file needs |
| `retrieve.queryChars` | 1500 | recall query: current message + most recent turns |
| `ingest.ingestCandidates` | 10 | most similar files of the side by BGE (plain similarity), each judged by Jev on its own: related to what is being recorded? |
| `ingest.extraCandidates` | 5 | at most this many more candidates beyond those: files this session's last 3 recorded segments wrote, and lexical (BM25, key-term) matches on topic/summary, taken in turn. A size continuation's own files are added on top. 0 = BGE only |
| `ingest.relatedAt` / `writeFiles` | 0.5 / 3 | the P(related) a file needs to reach the writer, and at most how many (most similar first) |
| `ingest.topicShiftAt` | 0.5 | P(topic changed) at which the pending segment is recorded |
| `ingest.segmentChars` | 6000 | a pending segment longer than this is recorded without waiting for a topic change (no turn limit) |
| `idleFlushMinutes` | 20 | record a session's unrecorded turns after this many quiet minutes (0 = off) |
| `ingest.maxAttempts` | 3 | automatic processing attempts per segment, then quarantine without blocking later segments |
| `ingest.jevChars` | 11000 | characters one Jev request may carry (~8.8K tokens); a candidate file in the related question gets what the state leaves, ~4,500 with a full segment |
| `retrieve.historyChars` / `messageChars` | 2000 / 1000 | conversation and current message in a Jev state (Jev's window is ~10K tokens) |
| `retrieve.fileChars` | 6000 | one file in a retrieval judgment: summary + newest entries (same as BGE's input) |
| `retrieve.evidenceChars` | 2000 | evidence in one turn's recall block (blocks of the topic count toward `segmentChars`) |
| `retrieve.retrieval` | `judge` | `bm25` = lexical recall only, no judge (baseline) |
| `ingest.gateAt` | 0.5 | skip the turn below this P(worth storing) |
| `judge.model` | `jev-latest` | pin e.g. `jev-1.14.0` once thresholds are tuned |

## The Yuzuha character pack

`personas/yuzuha/` is a complete, tested role-play setup (all text in Chinese):

| Path | What |
|---|---|
| `card.md` | the persona card — `persona.file`; placeholders `{{player_name}}`, `{{sibling}}` |
| `CARD_DESIGN.md` | why the card is written the way it is, with canon sources for every claim |
| `memory_seed/` | 15 memory files of canon shared history, loaded into an empty store before the first chat (`scripts/ops/memstore_reset.sh`) |
| `story/` | story beats: things she brings up on her own over the days |
| `eval/` | probe conversations, the chat/probe runners and the results of three test rounds |
| `tools/` | scripts that rebuild the canon reference corpus (`corpus/`, not shipped) from public game-data dumps and the fandom wiki |
| `INDEX.md` | what the corpus contains and how it was built |

The corpus of original game text that the card was distilled from is **not**
included (it is HoYoverse's copyrighted text); `tools/README.md` shows how to
rebuild it locally. Deploying her: [docs/DEPLOY.md §4](docs/DEPLOY.md).

To make your own character, copy `examples/persona.example.md`, write who the
character is and how they talk (never facts about the player — those come from
memory), and point `persona.file` at it.

## Tests

```bash
npm test                                   # offline, no network, scripted judge/LLM
node scripts/eval_gold.ts --data data/goldset_v2.json --judge jev --retrieval judge --concurrency 4
node scripts/eval_gold.ts --data data/goldset_v2.json --judge llm --retrieval bm25    # baseline
```

End-to-end procedure against a running gateway: docs/DEVELOPMENT.md §6 and the
`scripts/ops/memkit-e2e-*.sh` scripts.

## License

Code and documentation: [MIT](LICENSE).

浮波柚叶 (Ukinami Yuzuha), *Zenless Zone Zero* and everything from its world
are the property of HoYoverse / miHoYo. The files in `personas/yuzuha/` are a
non-commercial fan work; they are not covered by the MIT license and come with
no rights to HoYoverse's intellectual property. This project is not affiliated
with or endorsed by HoYoverse.
