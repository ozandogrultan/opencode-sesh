#!/usr/bin/env bash
# List sessions waiting on the user: unanswered agent questions and runs
# stuck with a tool still marked running. Server-independent: it reads the
# opencode SQLite store directly, so it sees every session — not just ones
# owned by a running TUI server, whose in-memory permission/question state
# is invisible cross-project.
#
# A session waits when it is not archived, is not a fork child, and either
#   - has a `question` tool part that never completed with no later user
#     message in the same session (awaiting an answer, errored included), or
#   - has a `tool` part still marked `running` older than STUCK_AFTER_MS
#     (awaiting approval, or orphaned by a dead server).
#
# Usage: sesh-waiting.sh [--json]
#   default prints a human table; --json prints [{id,reason,title,directory,updated}]
# Keep NEEDS_INPUT_SQL in sync with the TUI sidebar copy in tui/sesh-panel.tsx.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCODE_BIN=${SESH_OPENCODE:-opencode}
JSON=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --json) JSON=1 ;;
    --help) echo "usage: ${0##*/} [--json]"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

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

DB_PATH=$(resolve_db) || { echo 'sesh: session database unavailable' >&2; exit 1; }
[ -f "$DB_PATH" ] || { echo 'sesh: session database unavailable' >&2; exit 1; }

NOW_MS=$(python3 -c 'import time; print(int(time.time() * 1000))' 2>/dev/null || date +%s000)
STUCK_BEFORE=$((NOW_MS - 600000))

# NEEDS_INPUT_SQL (shared heuristic — keep in sync with tui/sesh-panel.tsx).
read -r -d '' QUERY <<SQL || true
SELECT s.id AS id, s.directory AS directory, s.title AS title, s.time_updated AS updated,
  CASE WHEN EXISTS (
    SELECT 1 FROM part p
    WHERE p.session_id = s.id
      AND json_extract(p.data, '\$.type') = 'tool'
      AND json_extract(p.data, '\$.tool') = 'question'
      AND COALESCE(json_extract(p.data, '\$.state.status'), 'pending') != 'completed'
      AND NOT EXISTS (
        SELECT 1 FROM message m
        WHERE m.session_id = s.id
          AND json_extract(m.data, '\$.role') = 'user'
          AND m.time_created > p.time_created)
  ) THEN 'question' ELSE 'stuck' END AS reason
FROM session s
WHERE COALESCE(s.time_archived, 0) = 0
  AND s.parent_id IS NULL
  AND (EXISTS (
    SELECT 1 FROM part p
    WHERE p.session_id = s.id
      AND json_extract(p.data, '\$.type') = 'tool'
      AND json_extract(p.data, '\$.tool') = 'question'
      AND COALESCE(json_extract(p.data, '\$.state.status'), 'pending') != 'completed'
      AND NOT EXISTS (
        SELECT 1 FROM message m
        WHERE m.session_id = s.id
          AND json_extract(m.data, '\$.role') = 'user'
          AND m.time_created > p.time_created)
  ) OR EXISTS (
    SELECT 1 FROM part p2
    WHERE p2.session_id = s.id
      AND json_extract(p2.data, '\$.type') = 'tool'
      AND json_extract(p2.data, '\$.state.status') = 'running'
      AND p2.time_created < $STUCK_BEFORE))
ORDER BY s.time_updated DESC;
SQL

if [ -n "$SQLITE_BIN" ]; then
  # Read-only: sesh never writes the store on this path (archive writes go
  # through `opencode db`, hard deletes through `opencode session delete`).
  ROWS=$("$SQLITE_BIN" -json -readonly "$DB_PATH" "$QUERY")
else
  command -v "$OPENCODE_BIN" >/dev/null 2>&1 || { echo 'sesh: neither sqlite3 nor opencode is available' >&2; exit 1; }
  ROWS=$("$OPENCODE_BIN" db "$QUERY" --format json)
fi

# sqlite3 -json prints nothing (not []) when no rows match.
[ -n "$ROWS" ] || ROWS='[]'

if [ "$JSON" = 1 ]; then
  printf '%s\n' "$ROWS"
  exit 0
fi

JQ_BIN=${SESH_JQ:-$(command -v jq || true)}
[ -n "$JQ_BIN" ] || { echo 'sesh: jq is required for the table view (or use --json)' >&2; exit 1; }
COUNT=$(printf '%s' "$ROWS" | "$JQ_BIN" -r 'length')
if [ "$COUNT" = 0 ]; then
  echo 'No sessions are waiting on you.'
  exit 0
fi
printf '%s' "$ROWS" | "$JQ_BIN" -r --argjson now "$NOW_MS" '
  def ago(ms): ((($now - ms) / 1000) | floor) as $s
    | if $s < 60 then "now"
      elif $s < 3600 then "\($s / 60 | floor)m"
      elif $s < 86400 then "\($s / 3600 | floor)h"
      else "\($s / 86400 | floor)d" end;
  def reason(t): if t == "question" then "awaiting answer" else "run stuck" end;
  .[] | "\(.id)\t\(reason(.reason))\t\(.title // "untitled")\t\(.directory)\t\(ago(.updated)) ago"
' | while IFS=$'\t' read -r id reason title dir age; do
  printf '%s  \033[33m%s\033[0m  %s  \033[90m%s · %s\033[0m\n' "$id" "$reason" "$title" "$dir" "$age"
done
