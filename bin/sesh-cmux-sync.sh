#!/usr/bin/env bash
# Name each cmux workspace after the opencode session it is running.
#
# cmux records the session behind every terminal surface (its resume
# `checkpoint_id`), so the mapping needs no bookkeeping: for each surface whose
# checkpoint is an opencode session (`ses_…`), rename its workspace to that
# session's current title. Titles are the opencode session title (the source of
# truth) unless it is still the pre-first-turn placeholder, which is skipped.
#
# cmux-only: exits cleanly when the cmux CLI is unavailable. Renames are
# lossless (a title), so there is no confirmation; --dry-run previews instead.
#
# Usage: sesh-cmux-sync.sh [--dry-run] [--json]
set -euo pipefail

OPENCODE_BIN=${SESH_OPENCODE:-opencode}
CMUX_BIN=${SESH_CMUX:-cmux}
dry_run=0
emit_json=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --json) emit_json=1 ;;
    --help) echo "usage: ${0##*/} [--dry-run] [--json]"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v "$CMUX_BIN" >/dev/null 2>&1 || { echo 'sesh: cmux is not available' >&2; exit 1; }
export CMUX_QUIET=1

resolve_db() {
  if [ -n "${SESH_DB:-}" ]; then printf '%s\n' "$SESH_DB"; return 0; fi
  local from_cli=''
  if command -v "$OPENCODE_BIN" >/dev/null 2>&1; then
    from_cli=$("$OPENCODE_BIN" db path 2>/dev/null || true)
  fi
  if [ -n "$from_cli" ] && [ -f "$from_cli" ]; then printf '%s\n' "$from_cli"; return 0; fi
  if [ -f "$HOME/.local/share/opencode/opencode.db" ]; then printf '%s\n' "$HOME/.local/share/opencode/opencode.db"; return 0; fi
  return 1
}

SQLITE_BIN=''
if [ -n "${SESH_SQLITE:-}" ]; then
  SQLITE_BIN=$SESH_SQLITE
elif command -v sqlite3 >/dev/null 2>&1; then
  SQLITE_BIN=sqlite3
fi

JQ_BIN=${SESH_JQ:-$(command -v jq || true)}
[ -n "$JQ_BIN" ] || { echo 'sesh: jq is required' >&2; exit 1; }

DB_PATH=$(resolve_db) || { echo 'sesh: session database unavailable' >&2; exit 1; }
[ -f "$DB_PATH" ] || { echo 'sesh: session database unavailable' >&2; exit 1; }

# 1. Every terminal surface cmux knows about, with its workspace.
SURFACES=$("$CMUX_BIN" tree --json --all 2>/dev/null | "$JQ_BIN" -c '
  [ .windows[]?.workspaces[]? as $w
    | $w.panes[]?.surfaces[]?
    | select(.type == "terminal" and (.ref | type) == "string")
    | {surface: .ref, workspace: $w.ref} ]') || SURFACES='[]'
[ -n "$SURFACES" ] || SURFACES='[]'

# 2. The opencode session each surface is running (cmux resume checkpoint).
PAIRS='[]'
while IFS=$'\t' read -r surface workspace; do
  [ -n "$surface" ] || continue
  checkpoint=$("$CMUX_BIN" surface resume show --surface "$surface" --json 2>/dev/null \
    | "$JQ_BIN" -r '.restore_record.checkpoint_id // empty' 2>/dev/null || true)
  case "$checkpoint" in
    ses_[A-Za-z0-9]*) ;;
    *) continue ;;
  esac
  PAIRS=$(printf '%s' "$PAIRS" | "$JQ_BIN" -c \
    --arg ws "$workspace" --arg sid "$checkpoint" \
    '. + [{workspace: $ws, session: $sid}]')
done < <(printf '%s' "$SURFACES" | "$JQ_BIN" -r '.[] | [.surface, .workspace] | @tsv')

if [ "$(printf '%s' "$PAIRS" | "$JQ_BIN" 'length')" = 0 ]; then
  echo 'No cmux workspace is running an opencode session.'
  exit 0
fi

# 3. Session titles (one query) and current workspace titles.
IN_LIST=''
for id in $(printf '%s' "$PAIRS" | "$JQ_BIN" -r '.[].session'); do
  case "$id" in
    ses_[A-Za-z0-9]*) IN_LIST="$IN_LIST'$id'," ;;
    *) echo 'sesh: unexpected session id shape' >&2; exit 1 ;;
  esac
done
IN_LIST=${IN_LIST%,}
if [ -n "$SQLITE_BIN" ]; then
  TITLE_ROWS=$("$SQLITE_BIN" -json -readonly "$DB_PATH" "SELECT id, title FROM session WHERE id IN ($IN_LIST);")
else
  TITLE_ROWS=$("$OPENCODE_BIN" db "SELECT id, title FROM session WHERE id IN ($IN_LIST);" --format json)
fi
[ -n "$TITLE_ROWS" ] || TITLE_ROWS='[]'

CURRENT=$("$CMUX_BIN" workspace list --json 2>/dev/null | "$JQ_BIN" -c \
  '[.workspaces[] | {workspace: .ref, title: (.custom_title // .title // "")}]') || CURRENT='[]'
[ -n "$CURRENT" ] || CURRENT='[]'

# 4. Keep only the real renames: a non-placeholder session title that differs
#    from what the workspace already shows.
FINAL=$(printf '%s' "$PAIRS" | "$JQ_BIN" -c \
  --slurpfile sessions <(printf '%s' "$TITLE_ROWS") \
  --slurpfile current <(printf '%s' "$CURRENT") '
  ($sessions[0] | map({key: .id, value: .title}) | from_entries) as $byId
  | ($current[0] | map({key: .workspace, value: .title}) | from_entries) as $shown
  | [ .[]
      | ($byId[.session] // "" | gsub("^ +| +$"; "")) as $t
      | select($t != "" and ($t | test("^New session\\b"; "i") | not))
      | select(($shown[.workspace] // "") != $t)
      | . + {title: $t} ]')

COUNT=$(printf '%s' "$FINAL" | "$JQ_BIN" 'length')
if [ "$COUNT" = 0 ]; then
  echo 'Every cmux workspace already matches its session.'
  exit 0
fi

if [ "$emit_json" = 1 ]; then
  printf '%s\n' "$FINAL"
  exit 0
fi

printf '%s' "$FINAL" | "$JQ_BIN" -r '.[] | "\(.workspace)\t\(.title)"' | while IFS=$'\t' read -r ws title; do
  printf '%s → %s\n' "$ws" "$title"
done

if [ "$dry_run" = 1 ]; then
  printf 'Would rename %s workspace(s) (--dry-run: nothing changed).\n' "$COUNT" >&2
  exit 0
fi

renamed=0
while IFS=$'\t' read -r ws title; do
  if "$CMUX_BIN" workspace rename "$ws" --title "$title" >/dev/null 2>&1; then
    renamed=$((renamed + 1))
  else
    echo "sesh: could not rename $ws" >&2
  fi
done < <(printf '%s' "$FINAL" | "$JQ_BIN" -r '.[] | [.workspace, .title] | @tsv')
echo "Renamed $renamed workspace(s)."
