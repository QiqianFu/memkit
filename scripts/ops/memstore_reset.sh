#!/usr/bin/env bash
# memstore_reset.sh <backup-name> [seed-dir]
#
# Start a test run from the seeded initial memory:
#   1. abort if memtest-gw is running (this script never starts or stops it);
#   2. back up the whole current store with memstore_backup.sh <backup-name>;
#   3. remove the store directory ($MEMTEST_STATE/memkit);
#   4. copy the seed's user/ and assistant/ trees into $MEMTEST_STATE/memkit/main/,
#      touch every file (mtime = now), and write one .meta.sqlite row per file:
#      created/updated = the file's last `times` entry (the story's real time),
#      importance = the file's frontmatter `importance` (seeds use 1 = pinned,
#      no forgetting; memkit would otherwise back-fill 0.5, and the forgetting curve
#      bury the seed from the first turn — see personas/yuzuha/memory_seed/README.md);
#   5. print the file count.
# Never touches ~/.openclaw.
#
# Paths (overridable, for tests):
#   MEMTEST_STATE  test profile state dir   (default ~/.openclaw-memtest)
#   SNAPSHOT_DIR   passed to memstore_backup.sh (default ~/.openclaw-memtest-snapshots)
#   SEED_DIR       seed directory            (default personas/yuzuha/memory_seed; the 2nd arg wins)
#   MEMKIT_DIR     memkit code, for src/meta.ts (default: this repository)
#   NODE_BIN       node 24                   (default `node` on PATH)
#   MEMTEST_UNIT   systemd unit of the gw    (default memtest-gw)
#   SKIP_UNIT_CHECK=1  no systemd (e.g. macOS): you confirm the gateway is stopped
set -euo pipefail

name="${1:-}"
if [[ -z "$name" || ! "$name" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "usage: $(basename "$0") <backup-name> [seed-dir]" >&2
  exit 2
fi

here="$(cd "$(dirname "$0")" && pwd)"
MEMTEST_STATE="${MEMTEST_STATE:-$HOME/.openclaw-memtest}"
SEED_DIR="${2:-${SEED_DIR:-$here/../../personas/yuzuha/memory_seed}}"
MEMKIT_DIR="${MEMKIT_DIR:-$(cd "$here/../.." && pwd)}"
MEMTEST_UNIT="${MEMTEST_UNIT:-memtest-gw}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node || true)"
store="$MEMTEST_STATE/memkit"
main="$store/main"

case "$(cd "$MEMTEST_STATE" 2>/dev/null && pwd -P || echo "$MEMTEST_STATE")" in
  "$HOME/.openclaw" | "$HOME/.openclaw/"*) echo "refusing: MEMTEST_STATE points at the live profile ~/.openclaw" >&2; exit 2 ;;
esac

# 1. The gateway must be stopped: it holds the store open and would keep writing.
if [[ "${SKIP_UNIT_CHECK:-}" == 1 ]]; then
  echo "SKIP_UNIT_CHECK=1: assuming the test gateway is stopped" >&2
elif ! command -v systemctl >/dev/null 2>&1; then
  echo "abort: systemctl not found, cannot check that $MEMTEST_UNIT is stopped (stop it yourself, then SKIP_UNIT_CHECK=1)" >&2
  exit 1
elif systemctl --user is-active --quiet "$MEMTEST_UNIT"; then
  echo "abort: $MEMTEST_UNIT is running — stop it first (systemctl --user stop $MEMTEST_UNIT)" >&2
  exit 1
fi

# Check the seed before changing anything.
if [[ ! -d "$SEED_DIR/user" && ! -d "$SEED_DIR/assistant" ]]; then
  echo "abort: no user/ or assistant/ in seed dir $SEED_DIR" >&2
  exit 1
fi
seed_count="$(find "$SEED_DIR/user" "$SEED_DIR/assistant" -name '*.md' -type f 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$seed_count" -eq 0 ]]; then
  echo "abort: seed dir $SEED_DIR has no memory files" >&2
  exit 1
fi

# 2. Back up (memstore_backup.sh refuses to overwrite and never deletes).
if [[ -d "$store" ]]; then
  backup="$("$here/memstore_backup.sh" "$name")"
  if [[ -z "$backup" || ! -s "$backup" ]]; then
    echo "abort: backup failed, store left untouched" >&2
    exit 1
  fi
  echo "backup: $backup"
else
  echo "no existing store at $store (nothing to back up)"
fi

# 3. Clear.
rm -rf "$store"

# 4. Inject the seed.
mkdir -p "$main"
for side in user assistant; do
  [[ -d "$SEED_DIR/$side" ]] && cp -R "$SEED_DIR/$side" "$main/"
done
find "$main" -type f ! -name '*.md' -delete   # only memory files (e.g. stray .DS_Store)
find "$main" -name '*.md' -type f -exec touch {} +

if [[ -n "$NODE_BIN" && -f "$MEMKIT_DIR/src/meta.ts" ]]; then
  "$NODE_BIN" --input-type=module -e '
    const [root, memkit] = process.argv.slice(1);
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const { MetaStore } = await import(path.join(memkit, "src/meta.ts"));
    const meta = new MetaStore(root);
    const now = Date.now();
    let n = 0;
    for (const side of ["user", "assistant"]) for (const type of ["principle", "event"]) {
      const dir = path.join(root, side, type);
      let names = [];
      try { names = readdirSync(dir); } catch { continue; }
      for (const f of names.filter((x) => x.endsWith(".md"))) {
        const text = readFileSync(path.join(dir, f), "utf8");
        const m = /^importance:\s*(.+)$/m.exec(text);
        const imp = m ? Number(JSON.parse(m[1])) : 0.5;
        // The story real time stays the file time (last times entry); a seed
        // with importance 1 is pinned (no forgetting), so an old date is harmless.
        const t = /^times:\s*(\[.*\])$/m.exec(text);
        const times = t ? JSON.parse(t[1]).map((x) => Date.parse(x)).filter(Number.isFinite) : [];
        const at = times.length ? Math.max(...times) : now;
        meta.created(`${side}/${type}/${f.slice(0, -3)}`, at, Number.isFinite(imp) ? imp : 0.5);
        n++;
      }
    }
    console.log(`meta rows: ${n} (created/updated = last times entry of the file, importance from frontmatter)`);
  ' "$main" "$MEMKIT_DIR" 2>&1 | grep -v ExperimentalWarning | grep -v "trace-warnings" || true
else
  echo "warning: node or $MEMKIT_DIR/src/meta.ts not found — no meta rows written; memkit will back-fill importance 0.5 and the frontmatter dates" >&2
fi

count="$(find "$main" -name '*.md' -type f | wc -l | tr -d ' ')"
echo "seeded $count memory files into $main (seed: $SEED_DIR)"
echo "memtest-gw NOT started"
