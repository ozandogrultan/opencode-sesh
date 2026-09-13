#!/usr/bin/env bash
# A short-lived worker owned by one picker.  It serializes expensive refreshes;
# fzf only ever asks the list script to render the last published snapshot.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The list script can be overridden for reuse; default is the opencode list.
LIST="${SESH_LIST:-$SCRIPT_DIR/sesh-list.sh}"
JQ_BIN=${SESH_JQ:-jq}
STATE_DIR=''
MODE=${1:-}
[ "$#" -gt 0 ] && shift
SCOPE=''
LIMIT=60
TARGET=''
TIMEOUT=12
SELECTED_ID=''

usage() { echo "usage: ${0##*/} init|worker|render|request|wait --state-dir DIR [options]" >&2; exit 2; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --state-dir) [ "$#" -ge 2 ] || usage; STATE_DIR=$2; shift ;;
    --scope) [ "$#" -ge 2 ] || usage; SCOPE=$2; shift ;;
    --limit) [ "$#" -ge 2 ] || usage; LIMIT=$2; shift ;;
    --query) [ "$#" -ge 2 ] || usage; QUERY=$2; shift ;;
    --selected-id) [ "$#" -ge 2 ] || usage; SELECTED_ID=$2; shift ;;
    --target) [ "$#" -ge 2 ] || usage; TARGET=$2; shift ;;
    --timeout) [ "$#" -ge 2 ] || usage; TIMEOUT=$2; shift ;;
    *) usage ;;
  esac
  shift
done
[ -n "$STATE_DIR" ] || usage
case "$LIMIT" in ''|*[!0-9]*) usage;; esac

atomic_text() {
  local dest=$1 contents=$2 tmp
  tmp=$(mktemp "$STATE_DIR/.worker.XXXXXX") || return 1
  printf '%s\n' "$contents" > "$tmp"
  mv -f "$tmp" "$dest"
}
request_number() { [ -f "$STATE_DIR/worker-request" ] && cat "$STATE_DIR/worker-request" 2>/dev/null || printf '0\n'; }

case "$MODE" in
  init)
    mkdir -p "$STATE_DIR"
    # Settings exist before the first concurrent cache render.
    settings=$("$JQ_BIN" -cn --arg scope "$SCOPE" --argjson limit "$LIMIT" '{scope:$scope,limit:$limit}')
    atomic_text "$STATE_DIR/settings.json" "$settings"
    atomic_text "$STATE_DIR/worker-request" 1
    atomic_text "$STATE_DIR/worker-complete" 0
    ;;
  render)
    "$LIST" --state-dir "$STATE_DIR" --query "${QUERY:-}" --selected-id "$SELECTED_ID"
    # An empty, first snapshot should not look like a broken picker.
    if [ ! -f "$STATE_DIR/status" ] && [ -f "$STATE_DIR/worker.pid" ]; then
      printf '\t\tunknown\tLoading sessions…\t\tnotice:loading\n'
    fi
    ;;
  request)
    current=$(request_number)
    case "$current" in ''|*[!0-9]*) current=0;; esac
    current=$((current + 1))
    atomic_text "$STATE_DIR/worker-request" "$current"
    printf '%s\n' "$current"
    ;;
  wait)
    case "$TARGET" in ''|*[!0-9]*) usage;; esac
    case "$TIMEOUT" in ''|*[!0-9]*) usage;; esac
    deadline=$((SECONDS + TIMEOUT))
    while [ "$SECONDS" -lt "$deadline" ]; do
      complete=$(cat "$STATE_DIR/worker-complete" 2>/dev/null || printf 0)
      case "$complete" in ''|*[!0-9]*) complete=0;; esac
      if [ "$complete" -ge "$TARGET" ]; then
        [ "$(cat "$STATE_DIR/status" 2>/dev/null || true)" = fresh ] || exit 1
        exit 0
      fi
      worker=$(cat "$STATE_DIR/worker.pid" 2>/dev/null || true)
      case "$worker" in ''|*[!0-9]*) exit 1;; esac
      kill -0 "$worker" 2>/dev/null || exit 1
      sleep 1
    done
    exit 1
    ;;
  worker)
    # Monitor mode gives each background scan its own process group, so cleanup
    # can terminate exactly the list process and its foreground children.  It is
    # enabled only across that fork: while job control is on, Bash hands the
    # controlling terminal to every foreground child's new process group and
    # never hands it back, which would take the terminal away from the picker's
    # fzf and kill it as soon as this worker ran its next ordinary command.
    scan_pid=''; sleep_pid=''
    cleanup() {
      # Only signal and reap children started by this worker; never search for
      # processes by name or touch another picker's state directory.
      if [ -n "$scan_pid" ]; then kill -TERM -- "-$scan_pid" 2>/dev/null || kill -TERM "$scan_pid" 2>/dev/null || true; wait "$scan_pid" 2>/dev/null || true; fi
      if [ -n "$sleep_pid" ]; then kill -TERM "$sleep_pid" 2>/dev/null || true; wait "$sleep_pid" 2>/dev/null || true; fi
      rm -f "$STATE_DIR/worker-scan.pid" "$STATE_DIR/worker-sleep.pid" "$STATE_DIR/worker.pid"
    }
    trap cleanup EXIT
    trap 'exit 130' HUP INT TERM
    atomic_text "$STATE_DIR/worker.pid" "$$"
    expedited=0
    while :; do
      # Capture the request before the scan. A request arriving during it is
      # deliberately served by the next scan, never mistaken for this one.
      serving=$(request_number)
      case "$serving" in ''|*[!0-9]*) serving=0;; esac
      set -m
      "$LIST" --refresh --wait-lock 3 --state-dir "$STATE_DIR" >/dev/null &
      scan_pid=$!
      set +m
      atomic_text "$STATE_DIR/worker-scan.pid" "$scan_pid"
      scan_rc=0
      wait "$scan_pid" || scan_rc=$?
      if [ "$scan_rc" = 0 ]; then
        atomic_text "$STATE_DIR/worker-complete" "$serving"
      else
        # Nothing was published, so no waiting dispatcher can be satisfied by a
        # later scan either: answer every outstanding request now.  Discredit the
        # previous "fresh" marker FIRST -- a reader that sees the advanced
        # counter must never still see the old status -- and only release the
        # counter once that stale marker is actually on disk.
        if [ "$scan_rc" = 75 ]; then
          scan_status='stale: refresh deferred; another action holds the refresh lock'
        else
          scan_status='stale: refresh worker scan failed'
        fi
        answered=$(request_number)
        case "$answered" in ''|*[!0-9]*) answered=$serving;; esac
        [ "$answered" -ge "$serving" ] || answered=$serving
        if atomic_text "$STATE_DIR/status" "$scan_status"; then
          atomic_text "$STATE_DIR/worker-complete" "$answered"
        fi
      fi
      scan_pid=''
      rm -f "$STATE_DIR/worker-scan.pid"
      # A request that arrived during the scan just missed it, and making it
      # wait out the idle sleep first costs (rest of that scan) + 3 + (a full
      # scan) -- past the dispatcher's 12s budget on a cold history, where a
      # scan alone measures ~4.6s.  Serve it immediately instead.
      #
      # Bounded twice over, so this cannot become a busy loop: the next scan
      # answers the request whether it succeeds or fails, and each request
      # number can skip the sleep only once, so a request that somehow stays
      # outstanding (an unwritable status, say) still falls back to the sleep.
      pending=$(request_number)
      case "$pending" in ''|*[!0-9]*) pending=0;; esac
      served=$(cat "$STATE_DIR/worker-complete" 2>/dev/null || printf 0)
      case "$served" in ''|*[!0-9]*) served=0;; esac
      if [ "$pending" -gt "$served" ] && [ "$pending" != "$expedited" ]; then
        expedited=$pending
        continue
      fi
      sleep 3 &
      sleep_pid=$!
      atomic_text "$STATE_DIR/worker-sleep.pid" "$sleep_pid"
      wait "$sleep_pid" || true
      sleep_pid=''
      rm -f "$STATE_DIR/worker-sleep.pid"
    done
    ;;
  *) usage ;;
esac
