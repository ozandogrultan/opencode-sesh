#!/usr/bin/env bash
# Per-directory cost digest: what each project spent in a recent window and
# over its lifetime, so a day's work reads as a per-project record.
#
# Cost is summed from assistant-message `cost` (not `session.cost`) so a
# partially-completed day does not drag a session's whole history into the
# window — the same reason the TUI statusline differs from `session.cost`.
#
# Usage: sesh-costs.sh [--days N] [--json]
#   --days N   window in days (default 1); 0 means lifetime only
#   --json     machine-readable rows
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCODE_BIN=${SESH_OPENCODE:-opencode}
days=1
emit_json=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --days) days=${2:-}; shift ;;
    --days=*) days=${1#--days=} ;;
    --json) emit_json=1 ;;
    --help) echo "usage: ${0##*/} [--days N] [--json]"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$days" in ''|*[!0-9]*) echo "--days must be a non-negative integer" >&2; exit 2;; esac

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

NOW_MS=$(python3 -c 'import time; print(int(time.time() * 1000))' 2>/dev/null || echo "$(( $(date +%s) * 1000 ))")
CUTOFF=$((NOW_MS - days * 86400000))

# One pass over assistant messages; the window filter is a cheap CASE so the
# lifetime total and the window total come back together.
ROWS_QUERY="
SELECT s.directory AS directory,
  ROUND(SUM(CASE WHEN m.time_created >= $CUTOFF THEN COALESCE(json_extract(m.data, '\$.cost'), 0) ELSE 0 END), 4) AS window_cost,
  ROUND(SUM(COALESCE(json_extract(m.data, '\$.cost'), 0)), 4) AS lifetime_cost,
  COUNT(DISTINCT s.id) AS sessions,
  SUM(CASE WHEN m.time_created >= $CUTOFF THEN COALESCE(json_extract(m.data, '\$.tokens.input'), 0) + COALESCE(json_extract(m.data, '\$.tokens.output'), 0) ELSE 0 END) AS window_tokens
FROM message m
JOIN session s ON s.id = m.session_id
WHERE json_extract(m.data, '\$.role') = 'assistant'
  AND json_extract(m.data, '\$.cost') IS NOT NULL
GROUP BY s.directory
ORDER BY lifetime_cost DESC;"

if [ -n "$SQLITE_BIN" ]; then
  ROWS=$("$SQLITE_BIN" -json -readonly "$DB_PATH" "$ROWS_QUERY")
else
  command -v "$OPENCODE_BIN" >/dev/null 2>&1 || { echo 'sesh: neither sqlite3 nor opencode is available' >&2; exit 1; }
  ROWS=$("$OPENCODE_BIN" db "$ROWS_QUERY" --format json)
fi
[ -n "$ROWS" ] || ROWS='[]'

if [ "$emit_json" = 1 ]; then
  printf '%s\n' "$ROWS"
  exit 0
fi

JQ_BIN=${SESH_JQ:-$(command -v jq || true)}
[ -n "$JQ_BIN" ] || { echo 'sesh: jq is required for the table view (or use --json)' >&2; exit 1; }

HOME_DIR=${HOME:-}
printf '%s' "$ROWS" | "$JQ_BIN" -r --arg home "$HOME_DIR" --argjson days "$days" '
  def pretty: if . == null or . == "" then "other"
    elif ($home != "" and startswith($home + "/")) then "~" + .[$home | length:]
    else . end;
  def money:
    if . == 0 then "—"
    else ((.*100 | round | tostring) as $c
      | "$" + (if ($c | length) == 1 then "0.0" + $c
               elif ($c | length) == 2 then "0." + $c
               else $c[0:-2] + "." + $c[-2:] end))
    end;
  (map(select(.lifetime_cost > 0)) | sort_by(-.lifetime_cost)) as $rows
  | if ($rows | length) == 0 then "No assistant cost recorded."
    else
      (["WINDOW" + (if $days == 0 then "" else "(\($days)d)" end), "LIFETIME", "SESS", "DIRECTORY"] | @tsv),
      ($rows[] | [((.window_cost) | money), ((.lifetime_cost) | money), (.sessions | tostring), (.directory | pretty)] | @tsv)
    end
' | column -t -s $'\t'
