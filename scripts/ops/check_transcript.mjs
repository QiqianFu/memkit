// Count memkit recall blocks persisted in OpenClaw's transcript store, per session:
// on the ACTIVE branch (what legacy replay / the compactor read) vs in ALL events
// (abandoned rewrite branches included). Read-only.
//   node check_transcript.mjs <agent.sqlite> [sessionKeyLike]
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";

const [dbPath, like = "%"] = process.argv.slice(2);
const db = new DatabaseSync(dbPath, { readOnly: true });
const decode = (r) => JSON.parse(r.event_json ?? zstdDecompressSync(r.event_zstd).toString("utf8"));
const recallIn = (m) =>
  JSON.stringify(m?.content ?? "").includes("memkit-recall") ||
  String(m?.__openclaw?.modelPromptProjection?.text ?? "").includes("memkit-recall");

const sessions = db
  .prepare("select session_id, session_key from session_windows where session_key like ? order by rowid")
  .all(like);
for (const { session_id, session_key } of sessions) {
  const all = db.prepare("select seq, event_json, event_zstd from transcript_events where session_id = ?").all(session_id).map(decode);
  const activeSeqs = new Set(
    db.prepare("select event_seq from session_transcript_active_events where session_id = ?").all(session_id).map((r) => r.event_seq),
  );
  const activeRows = db
    .prepare("select seq, event_json, event_zstd from transcript_events where session_id = ? order by seq")
    .all(session_id)
    .filter((r) => activeSeqs.has(r.seq))
    .map(decode);
  const users = (evs) => evs.filter((e) => e.type === "message" && e.message?.role === "user");
  const au = users(activeRows);
  const fts = db
    .prepare("select count(*) n from session_transcript_fts where session_id = ? and text like '%memkit-recall%'")
    .get(session_id).n;
  console.log(
    `${session_key} active_users=${au.length} active_with_recall=${au.filter((e) => recallIn(e.message)).length} ` +
      `all_users=${users(all).length} all_with_recall=${users(all).filter((e) => recallIn(e.message)).length} fts_with_recall=${fts}`,
  );
}
