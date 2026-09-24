#!/usr/bin/env bash
# Archive (or, with --delete, hard-delete) stale sessions: not updated within
# the threshold, never pinned, never waiting on the user, never already
# archived, never a fork child.
#
# Archive is the default because it is reversible; hard deletes go through
# `opencode session delete` so its own safeguards apply. The archive itself
# is a single atomic UPDATE through the same sqlite3-or-`opencode db` read
# path the list commands use — there is no archive endpoint in the opencode
# API or CLI, so a direct write is the only route (deletes stay on the CLI).
#
# Usage: sesh-prune.sh [--older-than 30d] [--dry-run] [--yes] [--delete]
#   --older-than Nd|Nh|Nw (bare N means days; default 30d)
#   --dry-run lists candidates and changes nothing
#   without --dry-run, a TTY run confirms first; a non-TTY run needs --yes
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCODE_BIN=${SESH_OPENCODE:-opencode}

older_than=30d
dry_run=0
assume_yes=0
hard_delete=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --older-than) older_than=${2:-}; shift ;;
    --older-than=*) older_than=${1#--older-than=} ;;
    --dry-run) dry_run=1 ;;
    --yes|-y) assume_yes=1 ;;
    --delete) hard_delete=1 ;;
    --help) echo "usage: ${0##*/} [--older-than 30d] [--dry-run] [--yes] [--delete]"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ "$older_than" =~ ^([0-9]+)([dhw])?$ ]]; then
  amount=$((10#${BASH_REMATCH[1]}))
  unit=${BASH_REMATCH[2]:-d}
  [ "$amount" -gt 0 ] || { echo "--older-than must be positive" >&2; exit 2; }
else
  echo "--older-than takes Nd, Nh or Nw (bare N means days)" >&2
  exit 2
fi
case "$unit" in
  h) threshold_ms=$((amount * 3600000)) ;;
  d) threshold_ms=$((amount * 86400000)) ;;
  w) threshold_ms=$((amount * 604800000)) ;;
esac
NOW_MS=$(python3 -c 'import time; print(int(time.time() * 1000))' 2>/dev/null || echo "$(( $(date +%s) * 1000 ))")
CUTOFF=$((NOW_MS - threshold_ms))

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

CANDIDATES=$(query "SELECT id, directory, title, time_updated AS updated FROM session WHERE time_updated < $CUTOFF AND COALESCE(time_archived, 0) = 0 AND parent_id IS NULL ORDER BY time_updated ASC;")
# sqlite3 -json prints nothing (not []) when no rows match.
[ -n "$CANDIDATES" ] || CANDIDATES='[]'
PINS=$("$SCRIPT_DIR/sesh-pins.sh" read 2>/dev/null || printf '{"sessions":[],"directories":[]}')
WAITING_IDS=$(bash "$SCRIPT_DIR/sesh-waiting.sh" --json 2>/dev/null | "$JQ_BIN" -r '.[].id' || true)
[ -n "$WAITING_IDS" ] || WAITING_IDS='__none__'

ELIGIBLE=$(printf '%s' "$CANDIDATES" | "$JQ_BIN" -c --slurpfile _pins <(printf '%s' "$PINS") --arg waiting "$WAITING_IDS" '
  ($waiting | split("\n") | map(select(. != "" and . != "__none__"))) as $waiting_ids
  | [ .[]
      | .id as $id
      | .directory as $dir
      | select($id | test("^ses_[A-Za-z0-9]+$"))
      | select(([$_pins[0].sessions[]] | index($id) | not))
      | select(([$_pins[0].directories[]] | index($dir) | not))
      | select(($waiting_ids | index($id) | not))
    ]
')
COUNT=$(printf '%s' "$ELIGIBLE" | "$JQ_BIN" -r 'length')
VERB=Archive
[ "$hard_delete" = 0 ] || VERB=Delete

if [ "$COUNT" = 0 ]; then
  echo "Nothing to prune older than $older_than."
  exit 0
fi

printf '%s' "$ELIGIBLE" | "$JQ_BIN" -r --argjson now "$NOW_MS" '
  def ago(ms): ((($now - ms) / 1000) | floor) as $s
    | if $s < 3600 then "\($s / 60 | floor)m"
      elif $s < 86400 then "\($s / 3600 | floor)h"
      else "\($s / 86400 | floor)d" end;
  .[] | "\(.id)\t\(.title // "untitled")\t\(ago(.updated)) ago"
' | while IFS=$'\t' read -r id title age; do
  printf '%s  %s  \033[90m%s\033[0m\n' "$id" "$title" "$age"
done

if [ "$dry_run" = 1 ]; then
  printf '%s %s session(s) older than %s (--dry-run: nothing changed).\n' "$VERB" "$COUNT" "$older_than" >&2
  exit 0
fi

if [ "$assume_yes" = 0 ]; then
  if [ -t 0 ]; then
    printf '%s' "$VERB $COUNT session(s) older than $older_than? [y/N] "
    reply=''
    IFS= read -r -n 1 reply || reply=''
    printf '\n'
    case "$reply" in
      y|Y) ;;
      *) echo 'Cancelled; nothing was changed.'; exit 0 ;;
    esac
  else
    echo "Refusing to prune $COUNT session(s): pass --yes when stdin is not a terminal." >&2
    exit 2
  fi
fi

if [ "$hard_delete" = 0 ]; then
  IDS=$(printf '%s' "$ELIGIBLE" | "$JQ_BIN" -r '.[].id')
  IN_LIST=''
  for id in $IDS; do
    case "$id" in
      ses_[A-Za-z0-9]*) IN_LIST="$IN_LIST'$id'," ;;
      *) echo "Refusing: unexpected session id shape." >&2; exit 1 ;;
    esac
  done
  IN_LIST=${IN_LIST%,}
  write_db "UPDATE session SET time_archived = $NOW_MS WHERE id IN ($IN_LIST);"
  echo "Archived $COUNT session(s) older than $older_than."
else
  command -v "$OPENCODE_BIN" >/dev/null 2>&1 || { echo 'sesh: opencode executable is unavailable for deletes.' >&2; exit 1; }
  failed=0
  done_count=0
  for id in $(printf '%s' "$ELIGIBLE" | "$JQ_BIN" -r '.[].id'); do
    case "$id" in
      ses_[A-Za-z0-9]*) ;;
      *) echo "Refusing: unexpected session id shape." >&2; exit 1 ;;
    esac
    if "$OPENCODE_BIN" session delete "$id" >/dev/null 2>&1; then
      done_count=$((done_count + 1))
    else
      echo "Could not delete $id." >&2
      failed=$((failed + 1))
    fi
  done
  echo "Deleted $done_count session(s) older than $older_than."
  [ "$failed" = 0 ] || exit 1
fi
