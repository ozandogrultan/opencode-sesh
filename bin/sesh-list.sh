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
HEADER=0
WAIT_LOCK=0
TOGGLE_SCOPE=0
INCLUDE_ARCHIVED=0
ARCHIVED_SET=0
STATE_DIR=''
QUERY=''
SELECTED_ID=''
SCOPE_CWD=''
usage() { echo "usage: ${0##*/} [--refresh] [--header] [--wait-lock SECONDS] --state-dir DIR [--cwd] [--limit N] [--archived] [--toggle-scope] [--query TEXT]" >&2; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --refresh) REFRESH=1 ;;
    --header) HEADER=1 ;;
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
    # Read-only: sesh never writes the store directly (deletes go through
    # `opencode session delete`).
    "$SQLITE_BIN" -json -readonly "$DB_PATH" "$1"
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

# One-line fzf --header: the effective scope, how many sessions the snapshot
# holds and whether it is fresh. Reads published state only, so it stays cheap
# enough to run on fzf's 3s poll without touching the database.
header() {
  local state='' count=0 scope='all dirs' line=''
  [ -f "$STATUS" ] && state=$(cat "$STATUS" 2>/dev/null || true)
  if [ -f "$SNAPSHOT" ]; then
    count=$(wc -l < "$SNAPSHOT" 2>/dev/null || printf '0')
    count=${count//[!0-9]/}
    [ -n "$count" ] || count=0
  fi
  if [ -n "$SCOPE_CWD" ]; then
    case "$SCOPE_CWD" in
      "$HOME") scope='~' ;;
      "$HOME"/*) scope="~${SCOPE_CWD#"$HOME"}" ;;
      *) scope=$SCOPE_CWD ;;
    esac
  fi
  line="${CYAN}${scope}${RESET}  ${GRAY}·${RESET}  ${GRAY}${count} sessions${RESET}"
  [ "$INCLUDE_ARCHIVED" = 1 ] && line="${line}  ${GRAY}·${RESET}  ${YELLOW}archived shown${RESET}"
  [ -n "$state" ] && [ "$state" != fresh ] && line="${line}  ${GRAY}·${RESET}  ${YELLOW}${state}${RESET}"
  printf '%s' "$line"
}

render() {
  local state='' notice=''
  [ -f "$STATUS" ] && state=$(cat "$STATUS" 2>/dev/null || true)
  # A non-actionable selection (a directory header, a stale notice) leaves a
  # one-shot message here so the reopened picker explains itself instead of
  # repainting the same list as if the key had been ignored.
  if [ -f "$STATE_DIR/action-notice" ]; then
    notice=$(cat "$STATE_DIR/action-notice" 2>/dev/null || true)
    rm -f "$STATE_DIR/action-notice" 2>/dev/null || true
  fi
  if [ ! -f "$SNAPSHOT" ]; then
    [ -n "$notice" ] && printf '\t\tunknown\t%s%s%s\t\tnotice:action\n' "$YELLOW" "$notice" "$RESET"
    [ -n "$state" ] && [ "$state" != fresh ] && printf '\t\tunknown\t%s%s%s\t\tnotice:live-state\n' "$YELLOW" "$state" "$RESET"
    return 0
  fi
  {
    [ -n "$notice" ] && printf '\t\tunknown\t%s%s%s\t\tnotice:action\n' "$YELLOW" "$notice" "$RESET"
    [ -n "$state" ] && [ "$state" != fresh ] && printf '\t\tunknown\t%s%s%s\t\tnotice:live-state\n' "$YELLOW" "$state" "$RESET"
    "$JQ_BIN" -sr --argjson pins "$("${BASH_SOURCE[0]%/*}/sesh-pins.sh" read)" --arg green "$GREEN" --arg cyan "$CYAN" --arg gray "$GRAY" --arg magenta "$MAGENTA" --arg red "$RED" --arg bold "$BOLD" --arg yellow "$YELLOW" --arg reset "$RESET" --arg query "$QUERY" --arg home "$HOME" --arg cwd "$PWD" --arg selected "$SELECTED_ID" '
      def ago($epoch):
        ((now - ($epoch | tonumber)) | floor) as $s
        | if $s < 60 then "now" elif $s < 3600 then "\($s / 60 | floor)m" elif $s < 86400 then "\($s / 3600 | floor)h" else "\($s / 86400 | floor)d" end;
      def homepath:
        . as $p | if $p == "" then "?" elif $p == $home then "~" elif ($home != "" and startswith($home + "/")) then "~" + .[($home|length):] else . end;
      # Non-actionable rows: an empty field 2 makes Enter/Ctrl-F/Ctrl-X no-ops,
      # and the unique id keeps fzf from falling back to a neighbouring session.
      def notice_row($msg; $id): (["", "", "unknown", ($yellow + $msg + $reset), "", $id] | @tsv);
      # Preserve a vanished selection so the picker keeps its identity instead
      # of jumping to a different session; keep it until the user moves away.
      (if ($selected | test("^ses_[A-Za-z0-9]+$")) and (any(.sessionId == $selected) | not)
       then notice_row("Selected session is no longer available; choose another session"; $selected)
       else empty end),
      # An empty result set must say so: with the info line hidden and an empty
      # preview, a filtered-to-nothing list is otherwise an indistinguishable
      # blank screen.
      (($query | ascii_downcase) as $q
      | [.[] | select($q == "" or (.searchText | contains($q)))] as $matched
      | (if ($matched | length) == 0
         then notice_row(if $q == "" then "No sessions in this store" else "No sessions match \"" + $query + "\"" end; "notice:no-match")
         else empty end),
        ($matched
       | group_by(.cwd)
       # Search relevance, not just recency: a title hit outranks a
       # transcript-only hit, and the current project rises while a query is
       # active. Both are query-gated so the idle list keeps pure pin+recency
       # ordering (the scope toggle, not this, is what narrows the list).
       | map({cwd: .[0].cwd, updated: (map(.updatedEpoch) | max),
              pinDirectory: (.[0].cwd as $dir | $pins.directories | index($dir) != null),
              pinSession: (any(.[]; .sessionId as $id | $pins.sessions | index($id) != null)),
              current: (($q != "") and (.[0].cwd == $cwd)),
              titleHit: (($q != "") and any(.[]; (.title | ascii_downcase | contains($q)))),
              items: (sort_by([(.sessionId as $id | $pins.sessions | index($id) != null),
                               (if $q != "" then (.title | ascii_downcase | contains($q)) else false end),
                               .updatedEpoch]) | reverse)})
       | sort_by([.pinDirectory, .pinSession, .current, .titleHit, .updated]) | reverse
       | .[] as $g
       | (["", "", "unknown", ($magenta + (if $g.pinDirectory then "★ " else "" end) + ($g.cwd | homepath | gsub("[\u0000-\u001f\u007f-\u009f]";" ")) + $reset), $g.cwd, ("hdr:" + $g.cwd)] | @tsv),
        ($g.items | to_entries[] | .key as $i | .value as $s
         # Archived rows are opt-in and need to look like it; nothing else about
         # a row is knowable here (live agent state is not exposed by opencode).
         | (if $s.archived == 1 then $yellow else $gray end) as $c
         | ($gray + (if $i == (($g.items|length)-1) then "└" else "├" end) + $reset) as $branch
          | [$s.agentId, $s.sessionId, $s.liveState, ($branch + " " + $c + (if ($s.sessionId as $id | $pins.sessions | index($id)) != null then "★ " else "" end) + ($s.title | gsub("[\u0000-\u001f\u007f-\u009f]";" ")) + (if $s.archived == 1 then " · archived" else "" end) + $reset + "  " + $gray + ago($s.updatedEpoch) + $reset), $s.cwd, $s.sessionId] | @tsv)))
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
    | [$caches[0][]? | select(.cacheSchema == 2 and (.sessionId | type) == "string")
       | select($byId[.sessionId] as $m | $m != null and .cacheUpdated == $m.time_updated and .cacheParts == $m.partCount and .cacheMax == $m.partMax)] as $cached
    | ($cached | map({key: .sessionId, value:true}) | from_entries) as $cachedIds
    | {cached: $cached,
       stale: [$meta[] | select($cachedIds[.id] != true) | {id, directory, title, time_created, time_updated, archived, partCount, partMax}],
       prune: [$caches[0][]? | select(.sessionId? as $s | $byId[$s] == null) | .cachePath],
       meta: $meta}
  ' "$cache_records" > "$cache_state" || {
    set_status 'stale: snapshot construction failed; showing last good snapshot'
    return 1
  }
  "$JQ_BIN" -c '.cached[]? | del(.cachePath)' "$cache_state" > "$historical"
  "$JQ_BIN" -c '.stale[]?' "$cache_state" > "$needs_extract"
  while IFS= read -r cache; do [ -n "$cache" ] && rm -f "$cache"; done < <("$JQ_BIN" -r '.prune[]?' "$cache_state")

  local stale_ids=() sid chunk j i
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    sid=$(printf '%s' "$row" | "$JQ_BIN" -r '.id')
    valid_session_id "$sid" || continue
    stale_ids+=("$sid")
  done < "$needs_extract"

  # Batch the transcript read: one SQL query per chunk of sessions and a single
  # jq pass to assemble every record, instead of a query plus three jq processes
  # per session. Text still travels through files, never argv. Any failure leaves
  # every stale session uncached, so the next refresh retries them.
  local extract_failed=0 parts_raw="$scratch/parts.jsonl" records="$scratch/records.jsonl"
  : > "$parts_raw"
  j=0
  while [ "$j" -lt "${#stale_ids[@]}" ]; do
    chunk=''
    for ((i = j; i < j + 200 && i < ${#stale_ids[@]}; i++)); do
      chunk="${chunk:+$chunk,}'${stale_ids[$i]}'"
    done
    if ! db_json "SELECT session_id, data FROM part WHERE session_id IN ($chunk) AND json_extract(data, '\$.type') = 'text' ORDER BY session_id, time_created;" 2>/dev/null \
      | "$JQ_BIN" -c '.[]?' >> "$parts_raw"; then
      extract_failed=1
      break
    fi
    j=$((j + 200))
  done

  if [ "$extract_failed" = 0 ]; then
    "$JQ_BIN" -cnr --arg extractions "$EXTRACTIONS" --slurpfile stale "$needs_extract" --slurpfile parts "$parts_raw" '
      ($parts
       | map({sid: .session_id,
              text: ((.data | try fromjson catch null)
                     | if type == "object" and .type == "text" and (.text | type) == "string" then .text else empty end)})
       | group_by(.sid)
       | map({key: .[0].sid, value: ([.[].text] | join(" "))})
       | from_entries) as $bySid
      | $stale[]
      | select((.id | type) == "string" and (.id | test("^ses_[A-Za-z0-9]+$")))
      | . as $s
      | ($bySid[$s.id] // "") as $text
      | (if ($s.title // "") == ""
         then (($text | gsub("[\r\n]+"; " ") | if length > 70 then .[0:67] + "..." else . end) | select(length > 0) // "(untitled)")
         else $s.title end) as $title
      | {sessionId: $s.id,
         cachePath: ($extractions + "/" + $s.id + ".json"),
         record: {cacheSchema: 2, cacheSession: $s.id,
                  cacheUpdated: ($s.time_updated // 0), cacheParts: ($s.partCount // 0), cacheMax: ($s.partMax // 0),
                  sessionId: $s.id, transcriptPath: "", source: "opencode",
                  cwd: ($s.directory // ""),
                  title: ($title | gsub("[\r\n]+"; " ") | if length > 70 then .[0:67] + "..." else . end),
                  updatedEpoch: ((($s.time_updated // 0) / 1000 | floor) | if . > 0 then . else ((($s.time_created // 0) / 1000) | floor) end),
                  fulltextLower: (($title + " " + $text) | ascii_downcase)}}
      | "\(.sessionId)\n\(.cachePath)\n\(.record | tojson)"' > "$records" || extract_failed=1
  fi

  if [ "$extract_failed" = 0 ]; then
    while IFS= read -r sid && IFS= read -r cache_path && IFS= read -r record; do
      [ -n "$sid" ] || continue
      cache_tmp=$(mktemp "$EXTRACTIONS/$sid.json.XXXXXX")
      printf '%s\n' "$record" > "$cache_tmp"
      mv "$cache_tmp" "$cache_path"
      printf '%s\n' "$record" >> "$historical"
    done < "$records"
  fi

  if ! "$JQ_BIN" -c --slurpfile hist "$historical" --argjson pins "$("${BASH_SOURCE[0]%/*}/sesh-pins.sh" read)" --arg scope "$SCOPE_CWD" --argjson limit "$LIMIT" --argjson archived "$INCLUDE_ARCHIVED" '
    .meta as $meta
    | ($hist | map({key: .sessionId, value: .}) | from_entries) as $histById
    | [$meta[]
       | select((.id | type) == "string" and (.id | test("^ses_[A-Za-z0-9]+$")))
       | select($archived == 1 or .archived == 0)
       | select($scope == "" or .directory == $scope)
       | . as $m | ($histById[$m.id] // {}) as $h
       | {sessionId: $m.id, malformedRecords: 0, agentId: "", agentState: "",
          liveState: "unknown", transcriptPath: "", source: "opencode",
          archived: (if (($m.archived // 0) | tonumber) == 0 then 0 else 1 end),
          cwd: (if ($h.cwd // "") != "" then $h.cwd else $m.directory end),
          updatedEpoch: ($h.updatedEpoch // (($m.time_updated / 1000 | floor))),
          title: (if ($h.title // "") != "" then $h.title else ($m.title // "(untitled)") end)}
       | .searchText = ((.title | ascii_downcase) + " " + ($histById[.sessionId].fulltextLower // ""))]
     | sort_by([(.cwd as $dir | $pins.directories | index($dir) != null), (.sessionId as $id | $pins.sessions | index($id) != null), .updatedEpoch]) | reverse
    | (if $limit == 0 then . else .[:$limit] end)[]
  ' "$cache_state" > "$out"; then
    set_status 'stale: snapshot construction failed; showing last good snapshot'
    return 1
  fi
  mv -f "$out" "$SNAPSHOT"
  if [ "$extract_failed" = 1 ]; then
    # Publish what we have, but say the index is incomplete and keep the
    # failed sessions uncached so the next refresh retries them.
    set_status 'stale: transcript extraction incomplete; refresh to retry' || true
  else
    set_status fresh || true
  fi
}

if [ "$HEADER" = 1 ]; then header; exit 0; fi
if [ "$REFRESH" = 1 ] || [ "$TOGGLE_SCOPE" = 1 ]; then refresh; fi
render
