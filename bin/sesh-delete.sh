#!/usr/bin/env bash
# Usage: sesh-delete.sh STATE_DIR SESSION_ID
# Ctrl-X deletes through the opencode CLI so its own safeguards apply.
# There is no confirmation prompt, matching the Claude picker.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
state_dir=${1:-}
session_id=${2:-}
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
case "$session_id" in ses_[A-Za-z0-9]*) ;; *) echo "Invalid session identity."; pause; exit 0;; esac
[ -n "$state_dir" ] && [ -f "$snapshot" ] || { echo "No session snapshot available."; pause; exit 0; }

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
