#!/usr/bin/env bash
# Usage: sesh-preview.sh STATE_DIR SESSION_ID
# Renders an opencode session transcript, newest messages first.
set -euo pipefail

state_dir=${1:-}
session_id=${2:-}
snapshot="$state_dir/snapshot.jsonl"
JQ_BIN=${SESH_JQ:-jq}

[ -n "$state_dir" ] && [ -n "$session_id" ] || { echo "(no session selected)"; exit 0; }
[ -f "$snapshot" ] || { echo "(no session snapshot available)"; exit 0; }
[[ "$session_id" =~ ^ses_[A-Za-z0-9]+$ ]] || { echo "(no transcript for this row)"; exit 0; }
"$JQ_BIN" -se --arg sid "$session_id" 'any(.sessionId == $sid)' "$snapshot" >/dev/null 2>&1 \
  || { echo "(selected session is no longer in this snapshot)"; exit 0; }

OPENCODE_BIN=${SESH_OPENCODE:-opencode}
DB_PATH=${SESH_DB:-"${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db"}
if [ -z "${SESH_DB:-}" ] && [ ! -f "$DB_PATH" ] && command -v "$OPENCODE_BIN" >/dev/null 2>&1; then
  DB_PATH=$("$OPENCODE_BIN" debug paths 2>/dev/null | awk '$1 == "db" { print $2; exit }' || true)
fi
[ -f "$DB_PATH" ] || { echo "(opencode database is unavailable)"; exit 0; }

SQLITE_BIN=${SESH_SQLITE:-}
if [ -z "$SQLITE_BIN" ] && command -v sqlite3 >/dev/null 2>&1; then SQLITE_BIN=sqlite3; fi
SQL="SELECT json_object('role', type) AS msg, json_object('type', 'text', 'text', json_extract(data, '\$.text')) AS part, seq, -1 AS ordinal FROM session_message WHERE session_id = '$session_id' AND type = 'user' AND json_type(data, '\$.text') = 'text'
UNION ALL SELECT json_object('role', m.type) AS msg, c.value AS part, m.seq, CAST(c.key AS INTEGER) AS ordinal FROM session_message m, json_each(m.data, '\$.content') c WHERE m.session_id = '$session_id' AND m.type = 'assistant' AND json_extract(c.value, '\$.type') = 'text' ORDER BY seq DESC, ordinal DESC LIMIT 200;"
[ -n "$SQLITE_BIN" ] || { echo "(sqlite3 is required for previews)"; exit 0; }
rows=$("$SQLITE_BIN" -json -readonly "$DB_PATH" "$SQL" 2>/dev/null) || rows=''
[ -n "$rows" ] || { echo "(no displayable transcript messages)"; exit 0; }

# Text parts only, newest first, with role headers. The 120-block cap is applied
# inside jq so nothing closes the pipe early (a `head` here would trip pipefail
# with SIGPIPE and blank the preview). Control bytes are stripped with tr
# (byte-safe for UTF-8: only 0x00-0x1F and 0x7F are removed).
rendered=$(printf '%s' "$rows" | "$JQ_BIN" -r '
  (if type == "array" then . else [] end)
  | map(
      ((.msg | try fromjson catch {}) | .role? // "") as $role
      | (.part | try fromjson catch {}) as $p
      | select(($p.type? // "") == "text")
      | ($p.text? // "") | select(type == "string" and length > 0)
      | (if $role == "user" then "# You" elif $role == "assistant" then "# Opencode" else "# Message" end) + "\n\n" + .
    )
  | .[0:120]
  | .[]
' 2>/dev/null | tr -d '\000-\010\013\014\016-\037\177') || rendered=''
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
