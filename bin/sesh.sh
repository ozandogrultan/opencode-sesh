#!/usr/bin/env bash
# Pick an opencode session. Native to opencode, terminal-agnostic: no iTerm2,
# no AppleScript, no panes, no window management. Stock fzf is the only UI.
# Refreshes publish one state-dir snapshot; fzf query changes render that
# snapshot only, so typing never starts competing scans.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

resolve_tool() {
  local configured=$1 fallback=$2
  if [ -n "$configured" ]; then
    case "$configured" in /*) [ -x "$configured" ] && { printf '%s\n' "$configured"; return; };; esac
    return 1
  fi
  command -v "$fallback"
}
SESH_FZF=$(resolve_tool "${SESH_FZF:-}" fzf) || { echo 'sesh: fzf executable unavailable' >&2; exit 1; }
SESH_JQ=$(resolve_tool "${SESH_JQ:-}" jq) || { echo 'sesh: jq executable unavailable' >&2; exit 1; }
export SESH_FZF SESH_JQ
OPENCODE_BIN=${SESH_OPENCODE:-opencode}

version=$("$SESH_FZF" --version 2>/dev/null || true)
# --bind transform: and start,every():reload-sync need a modern stock fzf.
if [[ "$version" =~ ^([0-9]+)\.([0-9]+)(\.([0-9]+))? ]]; then
  fzf_major=$((10#${BASH_REMATCH[1]}))
  fzf_minor=$((10#${BASH_REMATCH[2]}))
  if [ "$fzf_major" -eq 0 ] && [ "$fzf_minor" -lt 73 ]; then
    echo "sesh: fzf >= 0.73.0 is required (found $version)" >&2
    exit 1
  fi
else
  echo "sesh: cannot parse fzf version from: $version" >&2
  exit 1
fi

if [ "${1:-}" = --check ]; then
  "$SESH_JQ" -en '"2026-01-01T00:00:00Z" | fromdateiso8601 | type == "number"' >/dev/null || { echo 'jq capability check failed' >&2; exit 1; }
  command -v sqlite3 >/dev/null 2>&1 || command -v "$OPENCODE_BIN" >/dev/null 2>&1 || { echo 'neither sqlite3 nor opencode is available' >&2; exit 1; }
  # The TUI panel is a copied file that opencode imports once at startup. Report
  # when the installed copy has fallen behind this package so upgrades are not
  # silently stale.
  panel_bundled="$SCRIPT_DIR/../tui/sesh-panel.tsx"
  panel_installed="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/sesh-panel.tsx"
  if [ -f "$panel_installed" ] && [ -f "$panel_bundled" ]; then
    if cmp -s "$panel_bundled" "$panel_installed"; then
      echo 'sesh: sidebar panel is current'
    else
      echo 'sesh: sidebar panel is out of date; run `sesh install`, then fully quit and reopen opencode' >&2
    fi
  fi
  echo 'sesh: dependencies ready'
  exit 0
fi

scope_value=''
picker_limit=0
picker_archived=0
picker_print=0
picker_fork=0
picker_json=0
picker_query=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --cwd) scope_value=$PWD ;;
    --limit) picker_limit=${2:-}; shift ;;
    --archived) picker_archived=1 ;;
    --print) picker_print=1 ;;
    --fork) picker_fork=1 ;;
    --json) picker_json=1 ;;
    --query) picker_query=${2:-}; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$picker_limit" in ''|*[!0-9]*) echo "--limit must be a non-negative integer" >&2; exit 2;; esac
[ "$picker_json" = 0 ] || [ "$picker_print" = 1 ] || { echo '--json requires --print' >&2; exit 2; }

shell_quote() {
  # Quotes fixed command arguments embedded in fzf's shell action strings.
  # Selection data never crosses this boundary; fzf supplies {q}/{2} safely.
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\"'\\\"'/g")"
}

state_dir=$(mktemp -d "${TMPDIR:-/tmp}/sesh.XXXXXX")
chmod 700 "$state_dir"

q_list=$(shell_quote "$SCRIPT_DIR/sesh-list.sh")
q_worker=$(shell_quote "$SCRIPT_DIR/sesh-refresh-worker.sh")
q_preview=$(shell_quote "$SCRIPT_DIR/sesh-preview.sh")
q_delete=$(shell_quote "$SCRIPT_DIR/sesh-delete.sh")
q_pins=$(shell_quote "$SCRIPT_DIR/sesh-pins.sh")
q_shortcuts=$(shell_quote "$SCRIPT_DIR/sesh-shortcuts.sh")
q_state=$(shell_quote "$state_dir")
export SESH_LIST="$SCRIPT_DIR/sesh-list.sh"
# The shared worker persists scope/limit; the scope toggle and the archived
# filter need this picker's directory and flags too, so merge them up front.
"$SCRIPT_DIR/sesh-refresh-worker.sh" init --state-dir "$state_dir" --scope "$scope_value" --limit "$picker_limit"
"$SESH_JQ" -c --arg cwd "$PWD" --argjson archived "$picker_archived" '.cwd = $cwd | .archived = $archived' "$state_dir/settings.json" > "$state_dir/settings.tmp" && mv "$state_dir/settings.tmp" "$state_dir/settings.json"
"$SCRIPT_DIR/sesh-refresh-worker.sh" worker --state-dir "$state_dir" &
worker_pid=$!
cleanup() {
  # Reap this picker's exact worker before its private state disappears.
  kill -TERM "$worker_pid" 2>/dev/null || true
  wait "$worker_pid" 2>/dev/null || true
  rm -rf "$state_dir"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

cache_cmd="$q_worker render --state-dir $q_state --query {q} --selected-id {6}"
# fzf's --header is the only place a persistent scope/status line can live
# without becoming a selectable row, so it is refreshed by transform-header on
# start, on the 3s poll and after either action that can change it. Order
# matters: a transform-* action placed AFTER reload/reload-sync in the chain
# leaves the list empty, so the header is always transformed first.
header_cmd="$q_list --header --state-dir $q_state"
preview_cmd="if [ -f $q_state/help ]; then $q_shortcuts; else $q_preview $q_state {2}; fi"
help_bind="?:transform:[ -z {q} ] && ( [ -f $q_state/help ] && rm -f $q_state/help && echo hide-preview || ( : > $q_state/help && echo show-preview+refresh-preview ) ) || echo 'put(?)'"
toggle_cmd="$q_list --toggle-scope --state-dir $q_state >/dev/null"
delete_cmd="$q_delete $q_state {2}"
pin_session_cmd="$q_pins toggle-session {2}"
pin_directory_cmd="$q_pins toggle-directory {5}"

query="$picker_query"
while :; do
  header_line=$("$SCRIPT_DIR/sesh-list.sh" --header --state-dir "$state_dir" 2>/dev/null || true)
  selection=''
  set +e
  selection=$(FZF_DEFAULT_COMMAND='printf ""' FZF_DEFAULT_OPTS='' FZF_DEFAULT_OPTS_FILE='' "$SESH_FZF" --print-query --expect=ctrl-f --query="$query" --ansi --delimiter=$'\t' --with-nth=4 --track --id-nth=6 --disabled --layout=reverse --info=hidden --prompt='❯ ' \
    --preview="$preview_cmd" --preview-window='right,50%,wrap,hidden' \
    --header-first --header="$header_line" \
    --bind='space:transform:[ -z {q} ] && echo toggle-preview || echo "put( )"' \
    --bind="$help_bind" \
    --bind="ctrl-x:execute($delete_cmd)+transform-header($header_cmd)+reload($cache_cmd)" \
    --bind="ctrl-g:execute($toggle_cmd)+transform-header($header_cmd)+reload($cache_cmd)" \
    --bind="alt-s:execute-silent($pin_session_cmd)+reload($cache_cmd)" \
    --bind="alt-d:execute-silent($pin_directory_cmd)+reload($cache_cmd)" \
    --bind="change:reload:$cache_cmd" \
    --bind="start,every(3):transform-header($header_cmd)+reload-sync:$cache_cmd")
status=$?
set -e
case "$status" in 0) ;; 1|130) exit 0;; *) echo "sesh: picker failed ($status)" >&2; exit "$status";; esac
# --print-query precedes the --expect key (empty for Enter), then the row.
query=${selection%%$'\n'*}
selection=${selection#*$'\n'}
key=${selection%%$'\n'*}
selection=${selection#*$'\n'}
session_id=$(printf '%s\n' "$selection" | cut -f2)
tracking_id=$(printf '%s\n' "$selection" | cut -f6)
if [ -z "$session_id" ]; then
  # Enter/Ctrl-F on a directory header or a notice row. Leave a one-shot
  # message for the reopened picker so the keypress visibly did something,
  # and keep the query so the user has not lost their place.
  case "$tracking_id" in
    hdr:*) printf '%s' 'That row is a directory header, not a session.' > "$state_dir/action-notice" ;;
    notice:*) printf '%s' 'That row is a notice, not a session; pick a session row.' > "$state_dir/action-notice" ;;
  esac
  continue
fi
# Dispatch queues a new worker scan and waits for that exact serialized poll.
# It cannot accept a previously fresh status while the worker owns its lock.
# A --print lookup reads the published snapshot, so it skips the wait entirely
# and stays usable from scripts without paying a rescan.
if [ "$picker_print" = 0 ]; then
  printf 'sesh: refreshing session state…' >&2
  poll_target=$("$SCRIPT_DIR/sesh-refresh-worker.sh" request --state-dir "$state_dir")
  if ! "$SCRIPT_DIR/sesh-refresh-worker.sh" wait --state-dir "$state_dir" --target "$poll_target" --timeout 12; then
    printf '\r\033[K' >&2
    echo 'sesh: session state unavailable; selection cancelled, retry after refresh' >&2
    continue
  fi
  printf '\r\033[K' >&2
fi
record=$("$SESH_JQ" -c --arg sid "$session_id" 'select(.sessionId==$sid)' "$state_dir/snapshot.jsonl")
[ -n "$record" ] || continue
cwd=$(printf '%s' "$record" | "$SESH_JQ" -r '.cwd')
fork=0
if [ "$picker_fork" = 1 ] || [ "$key" = ctrl-f ]; then fork=1; fi
if [ "$picker_print" = 1 ]; then
  if [ "$picker_json" = 1 ]; then
    "$SESH_JQ" -cn --arg sessionId "$session_id" --arg cwd "$cwd" --argjson fork "$fork" \
      '{sessionId: $sessionId, cwd: $cwd, fork: ($fork == 1)}'
  elif [ "$fork" = 1 ]; then printf '%s\t%s\tfork\n' "$session_id" "$cwd"; else printf '%s\t%s\n' "$session_id" "$cwd"; fi
  exit 0
fi
if [ ! -d "$cwd" ]; then
  echo 'sesh: session directory is unavailable; returning to the picker.' >&2
  continue
fi
command -v "$OPENCODE_BIN" >/dev/null 2>&1 || { echo 'sesh: opencode executable unavailable' >&2; exit 1; }
# Resume in place: this terminal becomes the session. No tabs, no panes.
if [ "$fork" = 1 ]; then
  ( cd "$cwd" && exec "$OPENCODE_BIN" --session "$session_id" --fork )
else
  ( cd "$cwd" && exec "$OPENCODE_BIN" --session "$session_id" )
fi
echo 'sesh: opencode exited; returning to the picker.' >&2
done
