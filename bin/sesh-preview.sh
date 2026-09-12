#!/usr/bin/env bash
# Usage: sesh-preview.sh STATE_DIR SESSION_ID
# Renders the tail of an opencode session transcript from the SQLite database.
set -euo pipefail

state_dir=${1:-}
session_id=${2:-}
snapshot="$state_dir/snapshot.jsonl"
JQ_BIN=${SESH_JQ:-jq}

[ -n "$state_dir" ] && [ -n "$session_id" ] || { echo "(no session selected)"; exit 0; }
[ -f "$snapshot" ] || { echo "(no session snapshot available)"; exit 0; }
case "$session_id" in ses_[A-Za-z0-9]*) ;; *) echo "(no transcript for this row)"; exit 0;; esac
"$JQ_BIN" -se --arg sid "$session_id" 'any(.sessionId == $sid)' "$snapshot" >/dev/null 2>&1 \
  || { echo "(selected session is no longer in this snapshot)"; exit 0; }

DB_PATH=${SESH_DB:-}
if [ -z "$DB_PATH" ]; then
  OPENCODE_BIN=${SESH_OPENCODE:-opencode}
  if command -v "$OPENCODE_BIN" >/dev/null 2>&1; then
    DB_PATH=$("$OPENCODE_BIN" db path 2>/dev/null || true)
  fi
  [ -n "$DB_PATH" ] || DB_PATH="$HOME/.local/share/opencode/opencode.db"
fi
[ -f "$DB_PATH" ] || { echo "(opencode database is unavailable)"; exit 0; }

SQLITE_BIN=${SESH_SQLITE:-}
if [ -z "$SQLITE_BIN" ] && command -v sqlite3 >/dev/null 2>&1; then SQLITE_BIN=sqlite3; fi
SQL="SELECT m.data AS msg, p.data AS part FROM part p JOIN message m ON m.id = p.message_id WHERE p.session_id = '$session_id' ORDER BY p.time_created DESC LIMIT 200;"
if [ -n "$SQLITE_BIN" ]; then
  rows=$("$SQLITE_BIN" -json "$DB_PATH" "$SQL" 2>/dev/null) || rows=''
else
  OPENCODE_BIN=${SESH_OPENCODE:-opencode}
  rows=$("$OPENCODE_BIN" db "$SQL" --format json 2>/dev/null) || rows=''
fi
[ -n "$rows" ] || { echo "(no displayable transcript messages)"; exit 0; }

# Text parts only, oldest first, with role headers. Control bytes are stripped
# with tr (byte-safe for UTF-8: only 0x00-0x1F and 0x7F are removed).
rendered=$(printf '%s' "$rows" | "$JQ_BIN" -r '
  (if type == "array" then . else [] end)
  | reverse | .[]
  | ((.msg | try fromjson catch {}) | .role? // "") as $role
  | (.part | try fromjson catch {}) as $p
  | select(($p.type? // "") == "text")
  | ($p.text? // "") | select(type == "string" and length > 0)
  | (if $role == "user" then "# You" elif $role == "assistant" then "# Opencode" else "# Message" end) + "\n\n" + .
' 2>/dev/null | tr -d '\000-\010\013\014\016-\037\177' | tail -120) || rendered=''
[ -n "$rendered" ] || { echo "(no displayable transcript messages)"; exit 0; }

resolve_glow() {
  local configured=${SESH_GLOW:-} candidate
  if [ -n "$configured" ]; then
    case "$configured" in /*) [ -x "$configured" ] && printf '%s\n' "$configured" ;; esac
    return 0
  fi
  candidate=$(command -v glow 2>/dev/null || true)
  case "$candidate" in /*) [ -x "$candidate" ] && printf '%s\n' "$candidate" ;; esac
  return 0
}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GLOW_BIN="$(resolve_glow)"
if [ -n "$GLOW_BIN" ] && [ -f "$SCRIPT_DIR/../themes/glow-dark-clean.json" ]; then
  glow_rendered=$(printf '%s\n' "$rendered" | "$GLOW_BIN" -s "$SCRIPT_DIR/../themes/glow-dark-clean.json" -w "${FZF_PREVIEW_COLUMNS:-80}" - 2>/dev/null) && printf '%s\n' "$glow_rendered" || printf '%s\n' "$rendered"
else
  printf '%s\n' "$rendered"
fi
