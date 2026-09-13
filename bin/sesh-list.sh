#!/usr/bin/env bash
# Build and render a picker-local opencode session snapshot.
# Source of truth is the opencode SQLite database: no transcript files to
# walk, no live-agent poller to consult. Only --refresh publishes
# snapshot.jsonl; readers only render it.
# TSV: agentId, sessionId, liveState, display, cwd, trackingId.
# Every row, including headers/notices, requires a unique nonempty trackingId.
set -euo pipefail
umask 077

LIMIT=0
LIMIT_SET=0
SCOPE_SET=0
REFRESH=0
WAIT_LOCK=0
TOGGLE_SCOPE=0
INCLUDE_ARCHIVED=0
ARCHIVED_SET=0
STATE_DIR=''
QUERY=''
SELECTED_ID=''
SCOPE_CWD=''
usage() { echo "usage: ${0##*/} [--refresh] [--wait-lock SECONDS] --state-dir DIR [--cwd] [--limit N] [--archived] [--toggle-scope] [--query TEXT]" >&2; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --refresh) REFRESH=1 ;;
    --wait-lock) WAIT_LOCK=${2:-}; shift ;;
    --state-dir) STATE_DIR=${2:-}; shift ;;
    --cwd) SCOPE_CWD=$PWD; SCOPE_SET=1 ;;
    --limit) LIMIT=${2:-}; LIMIT_SET=1; shift ;;
    --archived) INCLUDE_ARCHIVED=1; ARCHIVED_SET=1 ;;
    --toggle-scope) TOGGLE_SCOPE=1 ;;
    --query) QUERY=${2:-}; shift ;;
    --selected-id) SELECTED_ID=${2:-}; shift ;;
    --help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done
case "$LIMIT" in ''|*[!0-9]*) echo "--limit must be a non-negative integer" >&2; exit 2;; esac
case "$WAIT_LOCK" in ''|*[!0-9]*) echo "--wait-lock must be a non-negative integer" >&2; exit 2;; esac
[ -n "$STATE_DIR" ] || { usage; exit 2; }

SNAPSHOT="$STATE_DIR/snapshot.jsonl"
STATUS="$STATE_DIR/status"
LOCK="$STATE_DIR/refresh.lock"
SETTINGS="$STATE_DIR/settings.json"
JQ_BIN=${SESH_JQ:-jq}
OPENCODE_BIN=${SESH_OPENCODE:-opencode}
CACHE_DIR=${SESH_CACHE_DIR:-"${XDG_CACHE_HOME:-"$HOME/.cache"}/sesh"}
EXTRACTIONS="$CACHE_DIR/extractions"

# The picker shows ALL sessions across every directory by default; --cwd (or
# the Ctrl-G toggle) narrows to one. Scope and limit apply at assembly time,
# so metadata always covers the whole database and cache pruning is safe.
SCOPE_CWD_SETTING=''
if [ -f "$SETTINGS" ]; then
  [ "$LIMIT_SET" = 1 ] || LIMIT=$("$JQ_BIN" -r '.limit' "$SETTINGS")
  [ "$SCOPE_SET" = 1 ] || SCOPE_CWD=$("$JQ_BIN" -r '.scope' "$SETTINGS")
  [ "$ARCHIVED_SET" = 1 ] || INCLUDE_ARCHIVED=$("$JQ_BIN" -r '.archived // 0' "$SETTINGS" 2>/dev/null || printf '0')
  SCOPE_CWD_SETTING=$("$JQ_BIN" -r '.cwd // ""' "$SETTINGS" 2>/dev/null || true)
fi
[ "$SCOPE_SET" = 1 ] || [ -n "$SCOPE_CWD_SETTING" ] || SCOPE_CWD_SETTING=$PWD
# An explicit --cwd both scopes and remembers the directory, so a later
# scope toggle can return to it. A toggle back to global leaves it intact.
if [ "$SCOPE_SET" = 1 ] && [ -n "$SCOPE_CWD" ] && [ "$TOGGLE_SCOPE" = 0 ]; then SCOPE_CWD_SETTING=$SCOPE_CWD; fi

if [ "$TOGGLE_SCOPE" = 1 ]; then
  if [ -n "$SCOPE_CWD" ]; then SCOPE_CWD=''; else SCOPE_CWD=$SCOPE_CWD_SETTING; fi
  SCOPE_SET=1
fi

GREEN=$'\033[32m'; CYAN=$'\033[36m'; GRAY=$'\033[90m'; MAGENTA=$'\033[35m'; RED=$'\033[31m'; BOLD=$'\033[1m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'

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

# db_json SQL → JSON array on stdout. Direct sqlite3 is preferred: it answers
# in milliseconds, while `opencode db` pays a full CLI startup per call and
# would make every preview keystroke laggy.
db_json() {
  if [ -n "$SQLITE_BIN" ]; then
    "$SQLITE_BIN" -json "$DB_PATH" "$1"
  else
    "$OPENCODE_BIN" db "$1" --format json
  fi
}

valid_session_id() { [[ "$1" =~ ^ses_[A-Za-z0-9]+$ ]]; }

atomic_text() {
  local dest=$1 contents=$2 tmp
  tmp=$(mktemp "$STATE_DIR/.tmp.XXXXXX") || return 1
  printf '%s\n' "$contents" > "$tmp"
  mv -f "$tmp" "$dest"
}
set_status() { atomic_text "$STATUS" "$1"; }

render() {
  local state=''
  [ -f "$STATUS" ] && state=$(cat "$STATUS" 2>/dev/null || true)
  if [ ! -f "$SNAPSHOT" ]; then
    [ -n "$state" ] && [ "$state" != fresh ] && printf '\t\tunknown\t%s%s%s\t\tnotice:live-state\n' "$YELLOW" "$state" "$RESET"
    return 0
  fi
  {
    [ -n "$state" ] && [ "$state" != fresh ] && printf '\t\tunknown\t%s%s%s\t\tnotice:live-state\n' "$YELLOW" "$state" "$RESET"
    "$JQ_BIN" -sr --arg green "$GREEN" --arg cyan "$CYAN" --arg gray "$GRAY" --arg magenta "$MAGENTA" --arg red "$RED" --arg bold "$BOLD" --arg yellow "$YELLOW" --arg reset "$RESET" --arg query "$QUERY" --arg home "$HOME" --arg selected "$SELECTED_ID" '
      def ago($epoch):
        ((now - ($epoch | tonumber)) | floor) as $s
        | if $s < 60 then "now" elif $s < 3600 then "\($s / 60 | floor)m" elif $s < 86400 then "\($s / 3600 | floor)h" else "\($s / 86400 | floor)d" end;
      def homepath:
        . as $p | if $p == "" then "?" elif $p == $home then "~" elif ($home != "" and startswith($home + "/")) then "~" + .[($home|length):] else . end;
      # Preserve a vanished selection as a non-actionable row with its original
      # tracking key. Otherwise fzf falls back to a different session. Keep it
      # until the user moves away; empty field 2 makes Enter/Ctrl-F/Ctrl-X no-ops.
      (if ($selected | test("^ses_[A-Za-z0-9]+$")) and (any(.sessionId == $selected) | not)
       then (["", "", "unknown", ($yellow + "Selected session is no longer available; choose another session" + $reset), "", $selected] | @tsv)
       else empty end),
      (($query | ascii_downcase) as $q
      | map(select($q == "" or (.searchText | contains($q))))
      | group_by(.cwd)
      | map({cwd: .[0].cwd, updated: (map(.updatedEpoch) | max), items: (sort_by(.updatedEpoch) | reverse)})
      | sort_by(.updated) | reverse
      | .[] as $g
      | (["", "", "unknown", ($magenta + ($g.cwd | homepath | gsub("[\u0000-\u001f\u007f-\u009f]";" ")) + $reset), $g.cwd, ("hdr:" + $g.cwd)] | @tsv),
        ($g.items | to_entries[] | .key as $i | .value as $s
         | (if $s.liveState == "running" then ($bold + $green) elif $s.agentId != "" and $s.agentState == "failed" then $red elif $s.agentId != "" then $cyan else $gray end) as $c
         | ($gray + (if $i == (($g.items|length)-1) then "└" else "├" end) + $reset) as $branch
         | [$s.agentId, $s.sessionId, $s.liveState, ($branch + " " + $c + ($s.title | gsub("[\u0000-\u001f\u007f-\u009f]";" ")) + $reset + "  " + $gray + ago($s.updatedEpoch) + $reset), $s.cwd, $s.sessionId] | @tsv))
    ' "$SNAPSHOT"
  } || printf '\t\tunknown\t%sSnapshot rendering failed; retry refresh%s\t\tnotice:render-error\n' "$YELLOW" "$RESET"
}

release_lock() { rm -f "$LOCK/pid" 2>/dev/null || true; rmdir "$LOCK" 2>/dev/null || true; }
acquire_lock() {
  if mkdir "$LOCK" 2>/dev/null; then printf '%s\n' "$$" > "$LOCK/pid"; return 0; fi
  local owner=''; [ -f "$LOCK/pid" ] && owner=$(cat "$LOCK/pid" 2>/dev/null || true)
  case "$owner" in ''|*[!0-9]*) return 1;; esac
  kill -0 "$owner" 2>/dev/null && return 1
  rm -f "$LOCK/pid" 2>/dev/null || return 1
  rmdir "$LOCK" 2>/dev/null || return 1
  mkdir "$LOCK" 2>/dev/null || return 1
  printf '%s\n' "$$" > "$LOCK/pid"
}

acquire_lock_wait() {
  local remaining=$WAIT_LOCK
  while ! acquire_lock; do
    [ "$remaining" -gt 0 ] || return 75
    sleep 1
    remaining=$((remaining - 1))
  done
}

private_dir() {
  # These are dedicated sesh directories, never the shared XDG parent. Refuse
  # symlinks/foreign ownership rather than changing permissions on their target.
  [ ! -L "$1" ] || { echo "sesh: private directory is a symlink: $1" >&2; return 1; }
  mkdir -p "$1"
  [ -O "$1" ] || { echo "sesh: private directory is not owned by this user: $1" >&2; return 1; }
  chmod 700 "$1"
}

refresh() {
  private_dir "$STATE_DIR"
  private_dir "$CACHE_DIR"
  private_dir "$EXTRACTIONS"
  # Migrate warm caches too, including temporary files left by older versions.
  # Do not follow symlinks or chmod unrelated files outside our extraction store.
  find "$EXTRACTIONS" -maxdepth 1 -type f -user "$(id -u)" \( -name 'ses_*.json' -o -name 'ses_*.json.tmp' \) -exec chmod 600 {} +
  if [ "${SESH_LOCK_HELD:-}" != "$STATE_DIR" ]; then
    if [ "$WAIT_LOCK" -gt 0 ]; then acquire_lock_wait || return $?; else acquire_lock || return 0; fi
  fi
  # Persist the effective scope (after any toggle) so renders and workers agree.
  if [ "$SCOPE_SET" = 1 ] || [ ! -f "$SETTINGS" ]; then
    atomic_text "$SETTINGS" "$("$JQ_BIN" -cn --arg scope "$SCOPE_CWD" --argjson limit "$LIMIT" --arg cwd "$SCOPE_CWD_SETTING" --argjson archived "$INCLUDE_ARCHIVED" '{scope:$scope,limit:$limit,cwd:$cwd,archived:$archived}')"
  fi
  DB_PATH=$(resolve_db) || {
    if [ -f "$SNAPSHOT" ]; then set_status 'stale: opencode database is unavailable; showing last good snapshot'; else set_status 'unavailable: opencode database is unavailable'; fi
    return 0
  }
  [ -f "$DB_PATH" ] || {
    if [ -f "$SNAPSHOT" ]; then set_status 'stale: opencode database is unavailable; showing last good snapshot'; else set_status 'unavailable: opencode database is unavailable'; fi
    return 0
  }
  if [ -z "$SQLITE_BIN" ] && ! command -v "$OPENCODE_BIN" >/dev/null 2>&1; then
    if [ -f "$SNAPSHOT" ]; then set_status 'stale: neither sqlite3 nor opencode is available; showing last good snapshot'; else set_status 'unavailable: neither sqlite3 nor opencode is available'; fi
    return 0
  fi
  local scratch sessions parts cache_records cache_state historical needs_extract out
  scratch=$(mktemp -d "$STATE_DIR/.refresh.XXXXXX")
  refresh_scratch=$scratch
  if [ "${SESH_LOCK_HELD:-}" = "$STATE_DIR" ]; then
    trap 'rm -rf "$refresh_scratch"' EXIT
  else
    trap 'rm -rf "$refresh_scratch"; release_lock' EXIT
  fi
  trap 'exit 130' HUP INT TERM
  sessions="$scratch/sessions.json"; parts="$scratch/parts.json"
  cache_records="$scratch/caches.json"; cache_state="$scratch/cache-state.json"
  historical="$scratch/historical.jsonl"; needs_extract="$scratch/needs-extract.json"
  out="$scratch/snapshot.jsonl"

  db_json "SELECT id, directory, title, time_created, time_updated, COALESCE(time_archived, 0) AS archived FROM session ORDER BY time_updated DESC;" > "$sessions" 2>/dev/null || {
    if [ -f "$SNAPSHOT" ]; then set_status 'stale: opencode database query failed; showing last good snapshot'; else set_status 'unavailable: opencode database query failed'; fi
    return 0
  }
  # sqlite3 emits no bytes for zero rows. Publish an empty snapshot so removal
  # of the final session also produces the non-actionable selection notice.
  [ -s "$sessions" ] || printf '[]\n' > "$sessions"
  "$JQ_BIN" -e 'type == "array"' "$sessions" >/dev/null 2>&1 || {
    if [ -f "$SNAPSHOT" ]; then set_status 'stale: opencode database query failed; showing last good snapshot'; else set_status 'unavailable: opencode database query failed'; fi
    return 0
  }
  db_json "SELECT session_id, COUNT(*) AS n, MAX(time_updated) AS m FROM part GROUP BY session_id;" > "$parts" 2>/dev/null || printf '[]\n' > "$parts"
  "$JQ_BIN" -e 'type == "array"' "$parts" >/dev/null 2>&1 || printf '[]\n' > "$parts"

  # Same bulk cache validation as the Claude list: every cache arrives as its
  # own file argument (ARG_MAX), records match on session id plus the two
  # change signals, and only vanished sessions are pruned — metadata always
  # covers the whole database, so pruning is safe under any scope or limit.
  find "$EXTRACTIONS" -maxdepth 1 -type f -name '*.json' -print0 2>/dev/null \
    | xargs -0 "$JQ_BIN" -c '. + {cachePath: input_filename}' 2>/dev/null \
    | "$JQ_BIN" -s '.' > "$cache_records" || printf '[]\n' > "$cache_records"
  "$JQ_BIN" -s --slurpfile sessions "$sessions" --slurpfile parts "$parts" --slurpfile caches "$cache_records" '
    ($sessions[0]) as $all
    | ($parts[0] | map({key:.session_id, value:.}) | from_entries) as $stats
    | [$sessions[0][] | . + {partCount: ($stats[.id].n // 0), partMax: ($stats[.id].m // 0)}] as $meta
    | ($meta | map({key:.id, value:.}) | from_entries) as $byId
    | [$caches[0][]? | select(.cacheSchema == 1 and (.sessionId | type) == "string")
       | select($byId[.sessionId] as $m | $m != null and .cacheUpdated == $m.time_updated and .cacheParts == $m.partCount)] as $cached
    | ($cached | map({key:.sessionId, value:true}) | from_entries) as $cachedIds
    | {cached: $cached,
       stale: [$meta[] | select($cachedIds[.id] != true) | {id, directory, title, time_created, time_updated, archived, partCount}],
       prune: [$caches[0][]? | select(.sessionId? as $s | $byId[$s] == null) | .cachePath],
       meta: $meta}
  ' "$cache_records" > "$cache_state" || {
    set_status 'stale: snapshot construction failed; showing last good snapshot'
    return 1
  }
  "$JQ_BIN" -c '.cached[]? | del(.cachePath)' "$cache_state" > "$historical"
  "$JQ_BIN" -c '.stale[]?' "$cache_state" > "$needs_extract"
  while IFS= read -r cache; do [ -n "$cache" ] && rm -f "$cache"; done < <("$JQ_BIN" -r '.prune[]?' "$cache_state")

  local sid dir title created updated archived partCount text fulltext record cache
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    sid=$(printf '%s' "$row" | "$JQ_BIN" -r '.id')
    valid_session_id "$sid" || continue
    dir=$(printf '%s' "$row" | "$JQ_BIN" -r '.directory // ""')
    title=$(printf '%s' "$row" | "$JQ_BIN" -r '.title // ""')
    created=$(printf '%s' "$row" | "$JQ_BIN" -r '.time_created // 0')
    updated=$(printf '%s' "$row" | "$JQ_BIN" -r '.time_updated // 0')
    partCount=$(printf '%s' "$row" | "$JQ_BIN" -r '.partCount // 0')
    cache="$EXTRACTIONS/$sid.json"
    # Text parts only: reasoning blobs and tool payloads would bloat the
    # search index without helping anyone find a session.
    text=$(db_json "SELECT data FROM part WHERE session_id = '$sid' AND json_extract(data, '\$.type') = 'text' ORDER BY time_created;" 2>/dev/null \
      | "$JQ_BIN" -r '[.[]? | (.data? // empty) | (try fromjson catch empty) | select(type == "object" and .type == "text") | .text // empty] | join(" ")' 2>/dev/null) || text=''
    fulltext=$(printf '%s' "$title $text" | "$JQ_BIN" -Rrs 'ascii_downcase' 2>/dev/null) || fulltext=''
    if [ -z "$title" ]; then
      title=$(printf '%s' "$text" | "$JQ_BIN" -Rrs 'gsub("[\r\n]+"; " ") | if length > 70 then .[0:67] + "..." else . end | select(length > 0) // "(untitled)"' 2>/dev/null) || title='(untitled)'
      [ -n "$title" ] || title='(untitled)'
    fi
    record=$("$JQ_BIN" -cn --arg sid "$sid" --arg cwd "$dir" --arg title "$title" \
      --argjson created "$created" --argjson updated "$updated" --argjson parts "$partCount" --arg fulltext "$fulltext" '
      {cacheSchema: 1, cacheSession: $sid, cacheUpdated: $updated, cacheParts: $parts,
       sessionId: $sid, transcriptPath: "", source: "opencode",
       cwd: $cwd, title: ($title | gsub("[\r\n]+"; " ") | if length > 70 then .[0:67] + "..." else . end),
       updatedEpoch: (($updated / 1000 | floor) | if . > 0 then . else ($created / 1000 | floor) end),
       fulltextLower: $fulltext}') || record=''
    if [ -n "$record" ]; then
      cache_tmp=$(mktemp "$EXTRACTIONS/$sid.json.XXXXXX")
      printf '%s\n' "$record" > "$cache_tmp"
      mv "$cache_tmp" "$cache"
      printf '%s\n' "$record" >> "$historical"
    fi
  done < "$needs_extract"

  if ! "$JQ_BIN" -c --slurpfile hist "$historical" --arg scope "$SCOPE_CWD" --argjson limit "$LIMIT" --argjson archived "$INCLUDE_ARCHIVED" '
    .meta as $meta
    | ($hist | map({key: .sessionId, value: .}) | from_entries) as $histById
    | [$meta[]
       | select($archived == 1 or .archived == 0)
       | select($scope == "" or .directory == $scope)
       | . as $m | ($histById[$m.id] // {}) as $h
       | {sessionId: $m.id, malformedRecords: 0, agentId: "", agentState: "",
          liveState: "unknown", transcriptPath: "", source: "opencode",
          cwd: (if ($h.cwd // "") != "" then $h.cwd else $m.directory end),
          updatedEpoch: ($h.updatedEpoch // (($m.time_updated / 1000 | floor))),
          title: (if ($h.title // "") != "" then $h.title else ($m.title // "(untitled)") end)}
       | .searchText = ((.title | ascii_downcase) + " " + ($histById[.sessionId].fulltextLower // ""))]
    | sort_by(.updatedEpoch) | reverse
    | (if $limit == 0 then . else .[:$limit] end)[]
  ' "$cache_state" > "$out"; then
    set_status 'stale: snapshot construction failed; showing last good snapshot'
    return 1
  fi
  mv -f "$out" "$SNAPSHOT"
  set_status fresh || true
}

if [ "$REFRESH" = 1 ] || [ "$TOGGLE_SCOPE" = 1 ]; then refresh; fi
render
