#!/usr/bin/env bash
# memstore_backup.sh <name>
#
# Back up the WHOLE memtest memory store (markdown files, .meta.sqlite and its
# -wal/-shm, .trace.jsonl, .embeddings.json) to
#   $SNAPSHOT_DIR/<name>-<YYYYmmdd-HHMM>.tgz
# and print the path. Refuses to overwrite an existing snapshot. Never deletes
# anything. Run it with memtest-gw stopped so the SQLite files are consistent
# (it only warns otherwise).
#
# Paths (overridable, for tests):
#   MEMTEST_STATE  test profile state dir   (default ~/.openclaw-memtest)
#   SNAPSHOT_DIR   where snapshots go        (default ~/.openclaw-memtest-snapshots)
#   MEMTEST_UNIT   systemd unit of the gw    (default memtest-gw)
set -euo pipefail

name="${1:-}"
if [[ -z "$name" || ! "$name" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "usage: $(basename "$0") <name>   (name: letters, digits, . _ -)" >&2
  exit 2
fi

MEMTEST_STATE="${MEMTEST_STATE:-$HOME/.openclaw-memtest}"
SNAPSHOT_DIR="${SNAPSHOT_DIR:-$HOME/.openclaw-memtest-snapshots}"
MEMTEST_UNIT="${MEMTEST_UNIT:-memtest-gw}"
store="$MEMTEST_STATE/memkit"

# The live profile is never ours to touch.
case "$(cd "$MEMTEST_STATE" 2>/dev/null && pwd -P || echo "$MEMTEST_STATE")" in
  "$HOME/.openclaw" | "$HOME/.openclaw/"*) echo "refusing: MEMTEST_STATE points at the live profile ~/.openclaw" >&2; exit 2 ;;
esac

if [[ ! -d "$store" ]]; then
  echo "no store at $store — nothing to back up" >&2
  exit 0
fi

if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet "$MEMTEST_UNIT"; then
  echo "warning: $MEMTEST_UNIT is running; the SQLite files may be mid-write (stop it first for a clean snapshot)" >&2
fi

mkdir -p "$SNAPSHOT_DIR"
out="$SNAPSHOT_DIR/$name-$(date +%Y%m%d-%H%M).tgz"
# noclobber: creating the file fails if it already exists, atomically.
if ! ( set -C; : > "$out" ) 2>/dev/null; then
  echo "refusing: $out already exists" >&2
  exit 1
fi
if ! tar -czf "$out" -C "$MEMTEST_STATE" memkit; then
  echo "tar failed; partial file left at $out (not deleted)" >&2
  exit 1
fi
tar -tzf "$out" >/dev/null   # readable?
echo "$out"
