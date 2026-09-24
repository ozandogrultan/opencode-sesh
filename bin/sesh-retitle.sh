#!/usr/bin/env bash
# Give auto-generated session titles a readable first line.
#
# opencode titles most sessions itself; a few keep their placeholder
# ("New session - <ISO>") because they ended before a title was derived. This
# replaces just those placeholders with the start of the session's first user
# message, so the row scans like the rest of the list.
#
# It only ever touches titles matching the placeholder pattern, and the value
# it overwrites carries no information (a timestamp), so nothing recoverable is
# lost. The write is a single direct UPDATE through the same sqlite3-or-
# `opencode db` path as `sesh prune` — opencode exposes no title endpoint in
# the CLI, so a direct write is the only route.
#
# Usage: sesh-retitle.sh [--dry-run] [--yes] [--max-words N]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCODE_BIN=${SESH_OPENCODE:-opencode}
dry_run=0
assume_yes=0
max_words=8
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --yes|-y) assume_yes=1 ;;
    --max-words) max_words=${2:-}; shift ;;
    --max-words=*) max_words=${1#--max-words=} ;;
    --help) echo "usage: ${0##*/} [--dry-run] [--yes] [--max-words N]"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$max_words" in ''|*[!0-9]*) echo "--max-words must be a positive integer" >&2; exit 2;; esac
[ "$max_words" -gt 0 ] || { echo "--max-words must be positive" >&2; exit 2; }

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

if [ -n "$SQLITE_BIN" ]; then
  query() { "$SQLITE_BIN" -json -readonly "$DB_PATH" "$1"; }
  write_db() { "$SQLITE_BIN" "$DB_PATH" "$1"; }
else
  command -v "$OPENCODE_BIN" >/dev/null 2>&1 || { echo 'sesh: neither sqlite3 nor opencode is available' >&2; exit 1; }
  query() { "$OPENCODE_BIN" db "$1" --format json; }
  write_db() { "$OPENCODE_BIN" db "$1" --format json > /dev/null; }
fi

JQ_BIN=${SESH_JQ:-$(command -v jq || true)}
[ -n "$JQ_BIN" ] || { echo 'sesh: jq is required' >&2; exit 1; }

# The first user text part per placeholder-titled session, cleaned into a
# candidate: image chips and markdown noise dropped, whitespace collapsed,
# first `max_words` words kept.
CANDIDATES=$(query "
SELECT s.id AS id, s.directory AS directory, s.title AS old_title,
  (SELECT p.data FROM part p
     JOIN message m ON m.id = p.message_id
     WHERE p.session_id = s.id
       AND json_extract(p.data, '\$.type') = 'text'
       AND json_extract(m.data, '\$.role') = 'user'
     ORDER BY p.time_created ASC LIMIT 1) AS first_part
FROM session s
WHERE s.title LIKE 'New session - %'
   OR TRIM(COALESCE(s.title, '')) = ''
ORDER BY s.time_updated DESC;")
[ -n "$CANDIDATES" ] || CANDIDATES='[]'

PLAN=$(printf '%s' "$CANDIDATES" | "$JQ_BIN" -c --argjson words "$max_words" '
  def derive:
    (.first_part // "")
    | (try (fromjson | .text) catch "")
    | gsub("\\[Image #[0-9]+\\]"; " ")
    | gsub("[#*_`>]"; " ")
    | gsub("\\s+"; " ")
    | sub("^ +"; "") | sub(" +$"; "")
    | (split(" ") | map(select(. != "")))
    | (if length == 0 then "" else .[0:$words] | join(" ") end)
    | if length > 60 then .[0:57] + "..." else . end;
  [ .[] | .new_title = derive | select(.new_title != "") ]')
COUNT=$(printf '%s' "$PLAN" | "$JQ_BIN" -r 'length')

if [ "$COUNT" = 0 ]; then
  echo "No placeholder-titled sessions with a usable first message."
  exit 0
fi

printf '%s' "$PLAN" | "$JQ_BIN" -r '
  .[] | "\(.id)\t\(.new_title)\t\(.old_title)"' | while IFS=$'\t' read -r id new old; do
  printf '%s\n  \033[90m%s\033[0m\n  → %s\n' "$id" "$old" "$new"
done

if [ "$dry_run" = 1 ]; then
  printf 'Retitle %s session(s) (--dry-run: nothing changed).\n' "$COUNT" >&2
  exit 0
fi

if [ "$assume_yes" = 0 ]; then
  if [ -t 0 ]; then
    printf 'Retitle %s session(s)? [y/N] ' "$COUNT"
    reply=''
    IFS= read -r -n 1 reply || reply=''
    printf '\n'
    case "$reply" in
      y|Y) ;;
      *) echo 'Cancelled; nothing was changed.'; exit 0 ;;
    esac
  else
    echo "Refusing to retitle $COUNT session(s): pass --yes when stdin is not a terminal." >&2
    exit 2
  fi
fi

# Escape single quotes for the SQL string literal; ids are validated by shape.
sql_escape() { printf '%s' "$1" | sed "s/'/''/g"; }
printf '%s' "$PLAN" | "$JQ_BIN" -r '.[] | [.id, .new_title] | @tsv' | while IFS=$'\t' read -r id new; do
  case "$id" in
    ses_[A-Za-z0-9]*) ;;
    *) echo "Refusing: unexpected session id shape." >&2; exit 1 ;;
  esac
  write_db "UPDATE session SET title = '$(sql_escape "$new")' WHERE id = '$id' AND (title LIKE 'New session - %' OR TRIM(COALESCE(title, '')) = '');"
done
echo "Retitled $COUNT session(s)."
