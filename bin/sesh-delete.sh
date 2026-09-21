#!/usr/bin/env bash
# Usage: sesh-delete.sh [--yes] STATE_DIR SESSION_ID
# Ctrl-X deletes through the opencode CLI so its own safeguards apply.
# Deletion is irreversible, so this confirms first: an interactive run asks for
# a y, and a non-interactive run must pass --yes rather than inherit whatever
# stdin happens to be. Rows with no session id (headers, notices) stay silent
# no-ops.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
assume_yes=0
positional=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes|-y) assume_yes=1 ;;
    --help) echo "usage: ${0##*/} [--yes] STATE_DIR SESSION_ID"; exit 0 ;;
    *) positional+=("$1") ;;
  esac
  shift
done
state_dir=${positional[0]:-}
session_id=${positional[1]:-}
snapshot="$state_dir/snapshot.jsonl"
lock="$state_dir/refresh.lock"
OPENCODE_BIN=${SESH_OPENCODE:-opencode}
JQ_BIN=${SESH_JQ:-jq}

lock_owned=0
pause() { release_lock; read -r -n 1 -s -p "Press any key to return..." _ || true; echo; }
release_lock() {
  [ "$lock_owned" = 1 ] || return 0
  rm -f "$lock/pid" 2>/dev/null || true
  rmdir "$lock" 2>/dev/null || true
  lock_owned=0
}
# Mirrors the acquirer in sesh-list.sh, including its stale-owner
# recovery. Recovery is conservative -- an unreadable or non-numeric owner,
# or one still alive, always loses the race.
acquire_lock() {
  if mkdir "$lock" 2>/dev/null; then printf '%s\n' "$$" > "$lock/pid"; return 0; fi
  local owner=''; [ -f "$lock/pid" ] && owner=$(cat "$lock/pid" 2>/dev/null || true)
  case "$owner" in ''|*[!0-9]*) return 1;; esac
  kill -0 "$owner" 2>/dev/null && return 1
  rm -f "$lock/pid" 2>/dev/null || return 1
  rmdir "$lock" 2>/dev/null || return 1
  mkdir "$lock" 2>/dev/null || return 1
  printf '%s\n' "$$" > "$lock/pid"
}

# fzf passes an empty second field for headers and notices. They are never
# actions, and should not surface a misleading failure prompt.
[ -n "$session_id" ] || exit 0
[[ "$session_id" =~ ^ses_[A-Za-z0-9]+$ ]] || { echo "Invalid session identity."; pause; exit 0; }
[ -n "$state_dir" ] && [ -f "$snapshot" ] || { echo "No session snapshot available."; pause; exit 0; }

# Confirm before taking the lock: a human can sit on the prompt for as long as
# they like without blocking the snapshot publisher. The row is re-checked
# against the snapshot below, so a session that vanishes meanwhile still loses.
if [ "$assume_yes" = 0 ]; then
  if [ -t 0 ]; then
    title=$("$JQ_BIN" -r --arg sid "$session_id" 'select(.sessionId == $sid) | .title // ""' "$snapshot" 2>/dev/null || true)
    [ -n "$title" ] || title='untitled'
    printf '%s' "Delete \"$title\" ($session_id)? [y/N] "
    reply=''
    IFS= read -r -n 1 reply || reply=''
    printf '\n'
    case "$reply" in
      y|Y) ;;
      *) echo "Cancelled; nothing was deleted."; pause; exit 0 ;;
    esac
  else
    echo "Refusing to delete $session_id: pass --yes when stdin is not a terminal." >&2
    exit 2
  fi
fi

# Serialize this action with the sole snapshot publisher. A short collision
# is safer than deleting against a moving snapshot.
if ! acquire_lock; then
  echo "Session list is refreshing; try deletion again in a moment."
  pause
  exit 0
fi
lock_owned=1
trap 'release_lock' EXIT
trap 'exit 130' HUP INT TERM

if ! "$JQ_BIN" -se --arg sid "$session_id" 'any(.sessionId == $sid)' "$snapshot" >/dev/null 2>&1; then
  echo "The selected session is no longer in this snapshot."
  pause
  exit 0
fi

command -v "$OPENCODE_BIN" >/dev/null 2>&1 || { echo "Refusing deletion: opencode executable is unavailable."; pause; exit 0; }
"$OPENCODE_BIN" session delete "$session_id" || { echo "opencode could not delete the session."; pause; exit 1; }
echo "Session deleted."

SESH_LOCK_HELD="$state_dir" "$SCRIPT_DIR/sesh-list.sh" --refresh --state-dir "$state_dir" >/dev/null || true
release_lock
trap - EXIT HUP INT TERM
