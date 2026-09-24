#!/bin/bash
# Regression checks for the opencode session picker against a fixture database.
set -euo pipefail
PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
command -v sqlite3 >/dev/null 2>&1 || { echo "sqlite3 is required for these tests" >&2; exit 1; }

fixture=$(mktemp -d "${TMPDIR:-/tmp}/sesh-test.XXXXXX")
# Never read or write the user's real database or extraction cache.
export SESH_CACHE_DIR="$fixture/cache"
export SESH_PINS_FILE="$fixture/pins.json"
export SESH_DB="$fixture/opencode.db"
export SESH_JQ=${SESH_JQ:-$(command -v jq)}
export SESH_SQLITE=$(command -v sqlite3)
# Force the plain-text preview path: glow restyles markdown headings, which
# would hide the literal role markers asserted below.
export SESH_GLOW=/nonexistent/glow
trap 'rm -rf "$fixture"' EXIT

mkdir -p "$fixture/one" "$fixture/two"
one="$(cd "$fixture/one" && pwd -P)"
two="$(cd "$fixture/two" && pwd -P)"

sqlite3 "$SESH_DB" <<'SQL'
CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER, parent_id TEXT);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
SQL

add_part() { # session msg role type text created
  local ses=$1 msg=$2 role=$3 type=$4 text=$5 created=$6
  local msg_json part_json
  msg_json=$(jq -cn --arg role "$role" '{role:$role}')
  part_json=$(jq -cn --arg type "$type" --arg text "$text" '{type:$type,text:$text}')
  sqlite3 "$SESH_DB" \
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('$msg', '$ses', $created, $created, '$msg_json');
     INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('p-$msg', '$msg', '$ses', $created, $created, '$part_json');"
}
add_session() { # id dir title created updated [archived]
  sqlite3 "$SESH_DB" \
    "INSERT INTO session (id, directory, title, time_created, time_updated, time_archived) VALUES ('$1', '$2', '$3', $4, $5, ${6:-NULL});"
}

add_session 'ses_alpha' "$one" 'Alpha work' 1700000000000 1700000100000
add_part 'ses_alpha' 'msg_a1' 'user' 'text' 'fix the widget search ranking' 1700000050000
add_part 'ses_alpha' 'msg_a2' 'assistant' 'text' 'ranking fixed and tested' 1700000100000
add_part 'ses_alpha' 'msg_a3' 'assistant' 'tool' 'SECRET_TOOL_OUTPUT_MUST_NOT_INDEX' 1700000101000
add_session 'ses_beta' "$two" 'Beta notes' 1700000200000 1700000300000
add_part 'ses_beta' 'msg_b1' 'user' 'text' 'hello world from beta' 1700000300000
add_session 'ses_old' "$one" 'Old archived' 1600000000000 1600000100000 1600000200000
add_part 'ses_old' 'msg_o1' 'user' 'text' 'ancient history' 1600000100000
add_session 'ses_notitle' "$two" '' 1700000400000 1700000500000
add_part 'ses_notitle' 'msg_n1' 'user' 'text' 'untitled session body words' 1700000500000

list="$PACKAGE_DIR/bin/sesh-list.sh"
preview="$PACKAGE_DIR/bin/sesh-preview.sh"
pins="$PACKAGE_DIR/bin/sesh-pins.sh"
state="$fixture/state"

# 1. Default refresh shows ALL sessions across every directory, newest first;
# archived stays hidden unless requested.
"$list" --refresh --state-dir "$state" > "$fixture/all.tsv"
"$SESH_JQ" -s -e '
  ([.[] | .sessionId]) as $ids
  | ($ids | length == 3)
  and ($ids[0] == "ses_notitle") and ($ids[1] == "ses_beta") and ($ids[2] == "ses_alpha")
  and ($ids | index("ses_old") | not)
  and ([.[] | select(.sessionId == "ses_notitle") | .title] | .[0] | startswith("untitled session body"))
' "$state/snapshot.jsonl" >/dev/null
grep -Fq 'hdr:'"$one" "$fixture/all.tsv"
grep -Fq 'hdr:'"$two" "$fixture/all.tsv"
[ "$(cat "$state/status")" = fresh ]

# 2. TSV contract: six fields, stable nonempty tracking ids, headers carry no
# session id. Tool payloads never enter the searchable index.
awk -F'\t' 'NF != 6 { bad=1 } $6 == "" { empty=1 } END { exit (bad || empty) }' "$fixture/all.tsv"
awk -F'\t' '$1 == "" && $2 == "" { headers++ } $2 != "" { rows++ } END { exit !(headers == 2 && rows == 3) }' "$fixture/all.tsv"
"$list" --state-dir "$state" --query "widget" > "$fixture/search.tsv"
grep -Fq 'ses_alpha' "$fixture/search.tsv"
grep -Fq 'ses_beta' "$fixture/search.tsv" && { echo "title/body search leaked" >&2; exit 1; }
"$list" --state-dir "$state" --query "SECRET_TOOL_OUTPUT" > "$fixture/tool.tsv"
grep -Fq 'ses_alpha' "$fixture/tool.tsv" && { echo "tool payload indexed" >&2; exit 1; }

# Pins survive refreshes, prioritize directories and sessions independently,
# and never change the six-field TSV or the search/scope contract.
"$pins" toggle-session ses_alpha > /dev/null
"$pins" toggle-directory "$two" > /dev/null
"$list" --state-dir "$state" > "$fixture/pinned.tsv"
"$SESH_JQ" -e --arg dir "$two" '.sessions == ["ses_alpha"] and .directories == [$dir]' "$SESH_PINS_FILE" > /dev/null
awk -F'\t' -v two="$two" '$6 == "hdr:" two { exit(NR != 1) }' "$fixture/pinned.tsv"
grep -Fq '★ Alpha work' "$fixture/pinned.tsv"
grep -Fq '★ '"$two" "$fixture/pinned.tsv"
"$list" --refresh --state-dir "$state" --limit 1 > /dev/null
"$SESH_JQ" -s -e 'length == 1 and .[0].sessionId == "ses_notitle"' "$state/snapshot.jsonl" > /dev/null
"$list" --refresh --state-dir "$state" --limit 0 > /dev/null
"$list" --state-dir "$state" --query widget > "$fixture/pinned-search.tsv"
grep -Fq 'ses_alpha' "$fixture/pinned-search.tsv"
"$pins" toggle-directory "$two" > /dev/null
"$list" --state-dir "$state" > "$fixture/pinned-session.tsv"
awk -F'\t' -v one="$one" '$6 == "hdr:" one { exit(NR != 1) }' "$fixture/pinned-session.tsv"
"$list" --refresh --state-dir "$state" --limit 1 > /dev/null
"$SESH_JQ" -s -e 'length == 1 and .[0].sessionId == "ses_alpha"' "$state/snapshot.jsonl" > /dev/null
"$list" --refresh --state-dir "$state" --limit 0 > /dev/null
"$pins" toggle-session ses_alpha > /dev/null
"$SESH_JQ" -e '.sessions == [] and .directories == []' "$SESH_PINS_FILE" > /dev/null
mkdir "$SESH_PINS_FILE.lock"
printf '99999999\n' > "$SESH_PINS_FILE.lock/pid"
"$pins" toggle-session ses_alpha > /dev/null
"$SESH_JQ" -e '.sessions == ["ses_alpha"]' "$SESH_PINS_FILE" > /dev/null
"$pins" toggle-session ses_alpha > /dev/null

# 3. Scope narrows to one directory; the toggle flips back to global.
( cd "$one"; "$list" --refresh --state-dir "$state" --cwd > /dev/null )
"$SESH_JQ" -s -e 'length == 1 and .[0].sessionId == "ses_alpha"' "$state/snapshot.jsonl" >/dev/null
"$list" --state-dir "$state" --toggle-scope > /dev/null
"$SESH_JQ" -s -e 'length == 3' "$state/snapshot.jsonl" >/dev/null
"$list" --state-dir "$state" --toggle-scope > /dev/null
"$SESH_JQ" -s -e 'length == 1' "$state/snapshot.jsonl" >/dev/null
# A plain refresh preserves the persisted scope whatever the caller's cwd is.
( cd "$one"; "$list" --refresh --state-dir "$state" > /dev/null )
"$SESH_JQ" -s -e 'length == 1 and .[0].sessionId == "ses_alpha"' "$state/snapshot.jsonl" >/dev/null
# Toggle back to global for the remaining checks.
"$list" --state-dir "$state" --toggle-scope > /dev/null
"$SESH_JQ" -s -e 'length == 3' "$state/snapshot.jsonl" >/dev/null

# 4. Limit caps the list; archived opt-in includes archived sessions.
"$list" --refresh --state-dir "$state" --limit 1 > /dev/null
"$SESH_JQ" -s -e 'length == 1 and .[0].sessionId == "ses_notitle"' "$state/snapshot.jsonl" >/dev/null
"$list" --refresh --state-dir "$state" --archived > /dev/null
"$SESH_JQ" -s -e 'length == 4 and ([.[] | .sessionId] | index("ses_old"))' "$state/snapshot.jsonl" >/dev/null
"$list" --refresh --state-dir "$state" > /dev/null

# 5. Warm refresh reuses extractions; new activity re-extracts only that session.
alpha_cache="$SESH_CACHE_DIR/extractions/ses_alpha.json"
[ -f "$alpha_cache" ]
# GNU stat first: BSD stat has no -c, and `stat -f '%m'` on GNU prints
# filesystem stats to stdout (including volatile free-block counts) even as it
# exits nonzero, which would poison the captured value.
cache_mtime() { stat -c '%Y' "$1" 2>/dev/null || stat -f '%m' "$1"; }
before=$(cache_mtime "$alpha_cache")
sleep 1
"$list" --refresh --state-dir "$state" > /dev/null
after=$(cache_mtime "$alpha_cache")
[ "$before" = "$after" ] || { echo "warm refresh re-parsed an unchanged session" >&2; exit 1; }
sqlite3 "$SESH_DB" "UPDATE session SET time_updated = 1800000000000 WHERE id = 'ses_alpha';"
add_part 'ses_alpha' 'msg_a4' 'user' 'text' 'brand new penguin discussion' 1800000000000
"$list" --refresh --state-dir "$state" --query "penguin" > "$fixture/penguin.tsv"
grep -Fq 'ses_alpha' "$fixture/penguin.tsv"

# 6. Preview renders role headers with text parts only.
"$preview" "$state" 'ses_alpha' > "$fixture/preview.txt"
grep -Fq '# You' "$fixture/preview.txt"
grep -Fq '# Opencode' "$fixture/preview.txt"
grep -Fq 'fix the widget search ranking' "$fixture/preview.txt"
grep -Fq 'SECRET_TOOL_OUTPUT' "$fixture/preview.txt" && { echo "preview leaked tool payload" >&2; exit 1; }
# Newest message first: the penguin part (added last) precedes the oldest text.
newest=$(grep -Fn 'brand new penguin discussion' "$fixture/preview.txt" | cut -d: -f1 | head -1)
oldest=$(grep -Fn 'fix the widget search ranking' "$fixture/preview.txt" | cut -d: -f1 | head -1)
[ -n "$newest" ] && [ -n "$oldest" ] && [ "$newest" -lt "$oldest" ] \
  || { echo "preview is not newest-first" >&2; exit 1; }
"$preview" "$state" '' > "$fixture/empty.txt"
grep -Fq '(no session selected)' "$fixture/empty.txt"

# 7. Delete goes through the opencode CLI, then refreshes under the lock. A
# non-interactive delete must opt in with --yes, so a piped stdin can never
# silently authorize an irreversible removal.
mkdir -p "$fixture/stubbin"
cat > "$fixture/stubbin/opencode" <<STUB
#!/bin/bash
[ "\$1 \$2" = "session delete" ] || exit 1
exec sqlite3 "$SESH_DB" "DELETE FROM session WHERE id = '\$3';"
STUB
chmod +x "$fixture/stubbin/opencode"
export SESH_OPENCODE="$fixture/stubbin/opencode"
PATH="$fixture/stubbin:$PATH"
if printf '\n' | "$PACKAGE_DIR/bin/sesh-delete.sh" "$state" 'ses_beta' >/dev/null 2>&1; then
  echo "delete without --yes was not refused" >&2; exit 1
fi
[ "$(sqlite3 "$SESH_DB" "SELECT count(*) FROM session WHERE id = 'ses_beta';")" = 1 ]
"$PACKAGE_DIR/bin/sesh-delete.sh" --yes "$state" 'ses_beta'
"$SESH_JQ" -s -e '([.[] | .sessionId] | index("ses_beta") | not)' "$state/snapshot.jsonl" >/dev/null
[ "$(sqlite3 "$SESH_DB" "SELECT count(*) FROM session WHERE id = 'ses_beta';")" = 0 ]

# 8. fzf version gate: reject below 0.73, accept exactly 0.73 (P1).
fzf_stub="$fixture/fzf-stub"
write_fzf_version() {
  printf '#!/bin/bash\n[ "${1:-}" = --version ] && { echo "%s"; exit 0; }\nexit 1\n' "$1" > "$fzf_stub"
  chmod +x "$fzf_stub"
}
write_fzf_version 0.72.0
if SESH_FZF="$fzf_stub" "$PACKAGE_DIR/bin/sesh" --check > "$fixture/old-fzf.out" 2>&1; then
  echo "sesh accepted fzf below 0.73" >&2; exit 1
fi
grep -Fq '>= 0.73.0' "$fixture/old-fzf.out"
write_fzf_version 0.73.0
SESH_FZF="$fzf_stub" "$PACKAGE_DIR/bin/sesh" --check > "$fixture/min-fzf.out"
grep -Fq 'dependencies ready' "$fixture/min-fzf.out"

# 9. Runtime caches are private even under a permissive umask (P1). Both a
# fresh cache and a world-readable warm cache must end up 0700/0600.
mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
perm_state="$fixture/perm-state"; perm_cache="$fixture/perm-cache"
( umask 022; SESH_CACHE_DIR="$perm_cache" "$list" --refresh --state-dir "$perm_state" > /dev/null )
[ "$(mode "$perm_cache")" = 700 ]
[ "$(mode "$perm_cache/extractions")" = 700 ]
[ "$(mode "$perm_cache/extractions/ses_alpha.json")" = 600 ]
chmod 644 "$perm_cache/extractions/ses_alpha.json"
( umask 022; SESH_CACHE_DIR="$perm_cache" "$list" --refresh --state-dir "$perm_state" > /dev/null )
[ "$(mode "$perm_cache/extractions/ses_alpha.json")" = 600 ]

# 10. A missing database reports unavailable instead of crashing.
export SESH_DB="$fixture/nonexistent.db"
missing="$fixture/missing"
"$list" --refresh --state-dir "$missing" > "$fixture/missing.tsv"
[ "$(cat "$missing/status")" = 'unavailable: opencode database is unavailable' ]

# --- P2 regressions -------------------------------------------------------

# Step 10 repointed SESH_DB at a missing file; the P2 checks use the fixture.
export SESH_DB="$fixture/opencode.db"

# 11. Transcript indexing is not bounded by ARG_MAX (P2): a >1 MB text part must
# be searchable rather than silently dropped.
p2_state="$fixture/p2-state"
{
  printf '{"type":"text","text":"p2_large_needle '
  head -c 1100000 /dev/zero | tr '\000' 'x'
  printf '"}'
} > "$fixture/big-part.json"
{
  echo "INSERT INTO session (id, directory, title, time_created, time_updated, time_archived) VALUES ('ses_big', '$one', 'Big', 1900000000000, 1900000000000, NULL);"
  echo "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('m-big', 'ses_big', 1900000000000, 1900000000000, '{\"role\":\"user\"}');"
  printf "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('p-big', 'm-big', 'ses_big', 1900000000000, 1900000000000, CAST(readfile('%s') AS TEXT));\n" "$fixture/big-part.json"
} > "$fixture/big.sql"
sqlite3 "$SESH_DB" < "$fixture/big.sql"
"$list" --refresh --state-dir "$p2_state" > /dev/null
[ "$(cat "$p2_state/status")" = fresh ]
"$list" --state-dir "$p2_state" --query "p2_large_needle" > "$fixture/big.tsv"
grep -Fq 'ses_big' "$fixture/big.tsv"

# 12. A part-only update (text + part timestamp, same session timestamp and part
# count) invalidates the warm cache (P2).
sqlite3 "$SESH_DB" "UPDATE part SET data = json_set(data, '\$.text', 'p2_updated_text'), time_updated = 1950000000000 WHERE id = 'p-msg_a2';"
"$list" --refresh --state-dir "$p2_state" > /dev/null
[ "$(cat "$p2_state/status")" = fresh ]
"$list" --state-dir "$p2_state" --query "p2_updated_text" > "$fixture/upd.tsv"
grep -Fq 'ses_alpha' "$fixture/upd.tsv"
"$list" --state-dir "$p2_state" --query "ranking fixed and tested" > "$fixture/oldpart.tsv"
grep -Fq 'ses_alpha' "$fixture/oldpart.tsv" && { echo "stale cache kept old part text" >&2; exit 1; }

# 13. Preview filters text parts before its row limit (P2): an old text part
# behind 201 newer tool parts must still render.
{
  echo "INSERT INTO session (id, directory, title, time_created, time_updated, time_archived) VALUES ('ses_toolheavy', '$one', 'Tool heavy', 2000000000000, 2000000000000, NULL);"
  echo "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('m-th', 'ses_toolheavy', 2000000000000, 2000000000000, '{\"role\":\"assistant\"}');"
  echo "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('p-th', 'm-th', 'ses_toolheavy', 2000000000000, 2000000000000, '{\"type\":\"text\",\"text\":\"preview_text_before_limit\"}');"
  i=0
  while [ "$i" -lt 201 ]; do
    i=$((i + 1))
    printf "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('p-th-%s', 'm-th', 'ses_toolheavy', %s, %s, '{\"type\":\"tool\",\"text\":\"ignored\"}');\n" "$i" "$((2000000000000 + i))" "$((2000000000000 + i))"
  done
} > "$fixture/toolheavy.sql"
sqlite3 "$SESH_DB" < "$fixture/toolheavy.sql"
"$list" --refresh --state-dir "$p2_state" > /dev/null
"$preview" "$p2_state" 'ses_toolheavy' > "$fixture/toolheavy.preview"
grep -Fq 'preview_text_before_limit' "$fixture/toolheavy.preview"

# 14. A long single message renders without a SIGPIPE-blanked preview (P2).
seq 1 1000 | sed 's/^/longline /' > "$fixture/long.txt"
jq -Rn --rawfile t "$fixture/long.txt" '{type:"text",text:$t}' > "$fixture/long-part.json"
{
  echo "INSERT INTO session (id, directory, title, time_created, time_updated, time_archived) VALUES ('ses_long', '$two', 'Long', 2100000000000, 2100000000000, NULL);"
  echo "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('m-long', 'ses_long', 2100000000000, 2100000000000, '{\"role\":\"user\"}');"
  printf "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('p-long', 'm-long', 'ses_long', 2100000000000, 2100000000000, CAST(readfile('%s') AS TEXT));\n" "$fixture/long-part.json"
} > "$fixture/long.sql"
sqlite3 "$SESH_DB" < "$fixture/long.sql"
"$list" --refresh --state-dir "$p2_state" > /dev/null
"$preview" "$p2_state" 'ses_long' > "$fixture/long.preview"
grep -Fq 'longline 1000' "$fixture/long.preview"

# 15. A malformed session id never reaches SQL (P2).
inj_state="$fixture/inj-state"; mkdir -p "$inj_state"
bad_sid="ses_x' OR 1=1 --"
jq -cn --arg sid "$bad_sid" '{sessionId:$sid,cwd:"/tmp",title:"x"}' > "$inj_state/snapshot.jsonl"
"$preview" "$inj_state" "$bad_sid" > "$fixture/inj.preview"
[ "$(cat "$fixture/inj.preview")" = "(no transcript for this row)" ]

# 16. An empty store publishes an empty fresh snapshot and prunes caches (P2).
export SESH_DB="$fixture/opencode.db"
sqlite3 "$SESH_DB" "DELETE FROM part; DELETE FROM message; DELETE FROM session;"
empty_state="$fixture/empty-state"
"$list" --refresh --state-dir "$empty_state" > /dev/null
[ "$(cat "$empty_state/status")" = fresh ]
[ ! -s "$empty_state/snapshot.jsonl" ]
[ ! -e "$SESH_CACHE_DIR/extractions/ses_alpha.json" ]
# An empty store must explain itself rather than render a blank screen.
"$list" --state-dir "$empty_state" | grep -Fq 'No sessions in this store'

# 17. The installer never replaces or removes a foreign launcher symlink (P2).
inst_home="$fixture/inst-home"; mkdir -p "$inst_home/bin" "$inst_home/fakebin"
printf '#!/bin/bash\n[ "${1:-}" = --version ] && echo 0.74.3\n' > "$inst_home/fakebin/fzf"
chmod +x "$inst_home/fakebin/fzf"
ln -s /bin/ls "$inst_home/bin/sesh"
if XDG_CONFIG_HOME="$inst_home/.config" HOME="$inst_home" PATH="$inst_home/fakebin:$PATH" bash "$PACKAGE_DIR/install.sh" --bin-dir "$inst_home/bin" --no-tool --no-tui > "$fixture/inst.out" 2>&1; then
  echo "installer replaced a foreign launcher" >&2; exit 1
fi
grep -Fq 'not a sesh install' "$fixture/inst.out"
[ "$(readlink "$inst_home/bin/sesh")" = /bin/ls ]
rm -f "$inst_home/bin/sesh"
XDG_CONFIG_HOME="$inst_home/.config" HOME="$inst_home" PATH="$inst_home/fakebin:$PATH" bash "$PACKAGE_DIR/install.sh" --bin-dir "$inst_home/bin" --no-tool --no-tui > /dev/null 2>&1
[ "$(readlink "$inst_home/bin/sesh")" = "$PACKAGE_DIR/bin/sesh" ]
rm -f "$inst_home/bin/sesh"; ln -s /bin/ls "$inst_home/bin/sesh"
XDG_CONFIG_HOME="$inst_home/.config" HOME="$inst_home" PATH="$inst_home/fakebin:$PATH" bash "$PACKAGE_DIR/install.sh" --bin-dir "$inst_home/bin" --uninstall > /dev/null 2>&1
[ -L "$inst_home/bin/sesh" ] && [ "$(readlink "$inst_home/bin/sesh")" = /bin/ls ] || { echo "uninstall removed a foreign launcher" >&2; exit 1; }

# 18. postinstall `--sync-panel` refreshes an existing panel (so npm upgrades
# are not stale) and is a no-op when no panel is installed.
sync_home="$fixture/sync-home"; mkdir -p "$sync_home"
XDG_CONFIG_HOME="$sync_home/.config" HOME="$sync_home" PATH="$inst_home/fakebin:$PATH" bash "$PACKAGE_DIR/install.sh" --sync-panel > "$fixture/sync-noop.out" 2>&1
grep -Fq 'not installed' "$fixture/sync-noop.out"
[ ! -e "$sync_home/.config/opencode/plugins/sesh-panel.tsx" ]
XDG_CONFIG_HOME="$sync_home/.config" HOME="$sync_home" PATH="$inst_home/fakebin:$PATH" bash "$PACKAGE_DIR/install.sh" --bin-dir "$sync_home/bin" --no-tool > /dev/null 2>&1
panel="$sync_home/.config/opencode/plugins/sesh-panel.tsx"
[ -f "$panel" ]
cp "$panel" "$fixture/panel.orig"
printf '\n// stale marker\n' >> "$panel"
XDG_CONFIG_HOME="$sync_home/.config" HOME="$sync_home" SESH_FZF="$inst_home/fakebin/fzf" SESH_JQ="$SESH_JQ" SESH_SQLITE="$SESH_SQLITE" \
  bash "$PACKAGE_DIR/bin/sesh.sh" --check > "$fixture/check-stale.out" 2>&1 || true
grep -Fq 'out of date' "$fixture/check-stale.out"
XDG_CONFIG_HOME="$sync_home/.config" HOME="$sync_home" PATH="$inst_home/fakebin:$PATH" bash "$PACKAGE_DIR/install.sh" --sync-panel > "$fixture/sync.out" 2>&1
cmp -s "$panel" "$fixture/panel.orig" || { echo "sync-panel did not restore the panel" >&2; exit 1; }
grep -Fq 'restart opencode' "$fixture/sync.out"
XDG_CONFIG_HOME="$sync_home/.config" HOME="$sync_home" SESH_FZF="$inst_home/fakebin/fzf" SESH_JQ="$SESH_JQ" SESH_SQLITE="$SESH_SQLITE" \
  bash "$PACKAGE_DIR/bin/sesh.sh" --check > "$fixture/check-ok.out" 2>&1
grep -Fq 'sidebar panel is current' "$fixture/check-ok.out"

# --- UX regressions -------------------------------------------------------

# 19. The picker header names the effective scope, the session count and the
# snapshot status, so a scope toggle or a stale index is never silent.
add_session 'ses_h1' "$one" 'Header one' 2200000000000 2200000000000
add_part 'ses_h1' 'msg_h1' 'user' 'text' 'header body one' 2200000000000
add_session 'ses_h2' "$two" 'Header two' 2210000000000 2210000000000
add_part 'ses_h2' 'msg_h2' 'user' 'text' 'header body two' 2210000000000
add_session 'ses_harch' "$one" 'Header archived' 1600000000000 1600000100000 1600000200000
hdr_state="$fixture/hdr-state"
"$list" --refresh --state-dir "$hdr_state" > /dev/null
hdr=$("$list" --header --state-dir "$hdr_state")
case "$hdr" in *'all dirs'*) ;; *) echo "header omitted the global scope: $hdr" >&2; exit 1;; esac
case "$hdr" in *'2 sessions'*) ;; *) echo "header omitted the session count: $hdr" >&2; exit 1;; esac
case "$hdr" in *stale*|*unavailable*) echo "a fresh header claimed stale state: $hdr" >&2; exit 1;; esac
( cd "$one"; "$list" --refresh --state-dir "$hdr_state" --cwd > /dev/null )
case "$("$list" --header --state-dir "$hdr_state")" in *"$one"*) ;; *) echo "header omitted the scoped directory" >&2; exit 1;; esac
case "$("$list" --header --state-dir "$hdr_state" --archived)" in *'archived shown'*) ;; *) echo "header omitted the archived opt-in" >&2; exit 1;; esac

# 20. Archived rows are tagged in the list, and a query that matches nothing
# says so instead of rendering an empty screen.
"$list" --refresh --state-dir "$hdr_state" --archived > "$fixture/arch.tsv"
grep -Fq '· archived' "$fixture/arch.tsv"
"$list" --state-dir "$hdr_state" --query 'no-such-session-anywhere' > "$fixture/nomatch.tsv"
grep -Fq 'No sessions match' "$fixture/nomatch.tsv"
awk -F'\t' '$2 != "" { exit 1 }' "$fixture/nomatch.tsv"

# 21. A non-actionable selection leaves a one-shot notice that the reopened
# picker renders once and then clears.
notice_state="$fixture/notice-state"
"$list" --refresh --state-dir "$notice_state" > /dev/null
printf '%s' 'That row is a directory header, not a session.' > "$notice_state/action-notice"
"$list" --state-dir "$notice_state" > "$fixture/notice.tsv"
grep -Fq 'directory header, not a session' "$fixture/notice.tsv"
[ ! -e "$notice_state/action-notice" ]
"$list" --state-dir "$notice_state" > "$fixture/notice2.tsv"
grep -Fq 'directory header' "$fixture/notice2.tsv" && { echo "action notice was not consumed" >&2; exit 1; }

# 22. Needs-input triage: unanswered questions and stale running tools are
# listed; answered questions, fresh runs and plain sessions are not.
tool_msg() { # session msg tool status created
  local msg_json part_json
  msg_json=$("$SESH_JQ" -cn '{role:"assistant"}')
  part_json=$("$SESH_JQ" -cn --arg tool "$3" --arg status "$4" '{type:"tool",tool:$tool,state:{status:$status}}')
  sqlite3 "$SESH_DB" \
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('$2', '$1', $5, $5, '$msg_json');
     INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('p-$2', '$2', '$1', $5, $5, '$part_json');"
}
now_ms=$(($(date +%s) * 1000))
recent=$((now_ms - 300000))
add_session 'ses_waitq' "$one" 'Waiting question' 1600000000000 1600000100000
add_part 'ses_waitq' 'msg_wq0' 'user' 'text' 'should I refactor' 1600000050000
tool_msg 'ses_waitq' 'msg_wq1' 'question' 'pending' 1600000100000
add_session 'ses_waitok' "$one" 'Answered question' 1600000000000 1600000100000
add_part 'ses_waitok' 'msg_wo0' 'user' 'text' 'should I refactor' 1600000050000
tool_msg 'ses_waitok' 'msg_wo1' 'question' 'completed' 1600000060000
add_part 'ses_waitok' 'msg_wo2' 'user' 'text' 'yes do it' 1600000070000
add_session 'ses_waitstuck' "$two" 'Stuck run' 1600000000000 1600000100000
add_part 'ses_waitstuck' 'msg_ws0' 'user' 'text' 'run the migration' 1600000050000
tool_msg 'ses_waitstuck' 'msg_ws1' 'bash' 'running' 1600000100000
add_session 'ses_runnow' "$two" 'Active run' $recent $recent
add_part 'ses_runnow' 'msg_rn0' 'user' 'text' 'keep working' $((recent - 60000))
tool_msg 'ses_runnow' 'msg_rn1' 'bash' 'running' $recent
waiting_ids="$("$PACKAGE_DIR/bin/sesh-waiting.sh" --json | "$SESH_JQ" -r 'map(.id) | sort | join(",")')"
[ "$waiting_ids" = 'ses_waitq,ses_waitstuck' ] || { echo "waiting set wrong: $waiting_ids" >&2; exit 1; }
"$PACKAGE_DIR/bin/sesh-waiting.sh" --json | "$SESH_JQ" -e 'map(.reason) | sort == ["question","stuck"]' >/dev/null
"$PACKAGE_DIR/bin/sesh-waiting.sh" > "$fixture/waiting.txt"
grep -Fq 'Waiting question' "$fixture/waiting.txt"
grep -Fq 'Stuck run' "$fixture/waiting.txt"
grep -Fq 'Answered question' "$fixture/waiting.txt" && { echo "answered question flagged" >&2; exit 1; }
grep -Fq 'Active run' "$fixture/waiting.txt" && { echo "fresh run flagged" >&2; exit 1; }

# 23. Prune archives stale sessions only: never pinned, waiting, fresh or
# already archived ones. Non-TTY runs need --yes; --dry-run changes nothing.
add_session 'ses_pruneold' "$one" 'Prune me' 1600000000000 1600000100000
add_part 'ses_pruneold' 'msg_po0' 'user' 'text' 'old work' 1600000100000
add_session 'ses_prunepin' "$one" 'Pinned old' 1600000000000 1600000100000
add_part 'ses_prunepin' 'msg_pp0' 'user' 'text' 'pinned work' 1600000100000
"$pins" toggle-session ses_prunepin > /dev/null
add_session 'ses_prunenew' "$two" 'Fresh work' $recent $recent
add_part 'ses_prunenew' 'msg_pn0' 'user' 'text' 'fresh work' $recent
add_session 'ses_delold' "$two" 'Delete me' 1600000000000 1600000100000
add_part 'ses_delold' 'msg_do0' 'user' 'text' 'delete work' 1600000100000
sqlite3 "$SESH_DB" "INSERT INTO session (id, directory, title, time_created, time_updated, time_archived, parent_id) VALUES ('ses_childold', '$one', 'Fork child', 1600000000000, 1600000100000, NULL, 'ses_waitq');"
tool_msg 'ses_childold' 'msg_co1' 'question' 'pending' 1600000100000
prune="$PACKAGE_DIR/bin/sesh-prune.sh"
archived_set() { sqlite3 "$SESH_DB" "SELECT id FROM session WHERE COALESCE(time_archived, 0) > 0 ORDER BY id;" | tr '\n' ','; }
before_prune=$(archived_set)
"$prune" --older-than 30d --dry-run > "$fixture/prune-dry.txt"
grep -Fq 'ses_pruneold' "$fixture/prune-dry.txt"
grep -Fq 'ses_delold' "$fixture/prune-dry.txt"
for excluded in ses_prunepin ses_prunenew ses_waitq ses_waitstuck ses_childold; do
  grep -Fq "$excluded" "$fixture/prune-dry.txt" && { echo "prune listed $excluded" >&2; exit 1; }
done
[ "$(archived_set)" = "$before_prune" ] || { echo "dry run archived" >&2; exit 1; }
if "$prune" --older-than 30d < /dev/null >/dev/null 2>&1; then
  echo "prune without --yes was not refused" >&2; exit 1
fi
"$prune" --older-than 30d --yes > /dev/null
archived() { sqlite3 "$SESH_DB" "SELECT COALESCE(time_archived, 0) > 0 FROM session WHERE id = '$1';"; }
[ "$(archived ses_pruneold)" = 1 ]
[ "$(archived ses_delold)" = 1 ]
for kept in ses_prunepin ses_prunenew ses_waitq ses_waitstuck ses_runnow; do
  [ "$(archived "$kept")" = 0 ] || { echo "prune archived $kept" >&2; exit 1; }
done

# 24. Prune --delete hard-deletes through the opencode CLI stub from test 7.
add_session 'ses_delold2' "$two" 'Delete me too' 1600000000000 1600000100000
add_part 'ses_delold2' 'msg_do1' 'user' 'text' 'delete work two' 1600000100000
"$prune" --older-than 30d --delete --yes > /dev/null
[ "$(sqlite3 "$SESH_DB" "SELECT count(*) FROM session WHERE id = 'ses_delold2';")" = 0 ]
[ "$(sqlite3 "$SESH_DB" "SELECT count(*) FROM session WHERE id = 'ses_prunepin';")" = 1 ]

# 25. Cost digest groups assistant-message cost by directory and splits a
# recent window from lifetime, so a half-finished day is not inflated by a
# session's earlier history.
cost_msg() { # session msg cost created
  local data
  data=$("$SESH_JQ" -cn --argjson cost "$3" '{role:"assistant",cost:$cost,tokens:{input:10,output:20}}')
  sqlite3 "$SESH_DB" \
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('$2', '$1', $4, $4, '$data');"
}
today=$(( $(date +%s) * 1000 - 3600000 ))
old=$(( $(date +%s) * 1000 - 30 * 86400000 ))
cost_dir="$fixture/costdir"; mkdir -p "$cost_dir"
add_session 'ses_costA' "$cost_dir" 'Cost A' $today $today
cost_msg 'ses_costA' 'msg_ca1' 3 $today
cost_msg 'ses_costA' 'msg_ca2' 5 $old
add_session 'ses_costB' "$cost_dir" 'Cost B' $today $today
cost_msg 'ses_costB' 'msg_cb1' 2 $today
costs="$PACKAGE_DIR/bin/sesh-costs.sh"
"$costs" --json > "$fixture/costs.json"
"$SESH_JQ" -e --arg dir "$cost_dir" '
  (map(select(.directory == $dir)) | .[0]) as $r
  | ($r.window_cost == 5) and ($r.lifetime_cost == 10) and ($r.sessions == 2)
' "$fixture/costs.json" > /dev/null
"$costs" --days 0 --json | "$SESH_JQ" -e --arg dir "$cost_dir" '
  (map(select(.directory == $dir)) | .[0].window_cost == 0)' > /dev/null
if "$costs" --days x >/dev/null 2>&1; then echo "costs accepted a bad --days" >&2; exit 1; fi

# 26. Retitle only touches placeholder titles, derives from the first user
# message, and is dry-run/--yes gated like the other writes.
add_session 'ses_newt' "$two" 'New session - 2026-01-01T00:00:00.000Z' 1700000000000 1700000000000
add_part 'ses_newt' 'msg_nt0' 'user' 'text' 'Fix the widget ranking across directories' 1700000000000
add_session 'ses_kept' "$two" 'A real title' 1700000000000 1700000000000
add_part 'ses_kept' 'msg_kt0' 'user' 'text' 'irrelevant' 1700000000000
retitle="$PACKAGE_DIR/bin/sesh-retitle.sh"
"$retitle" --dry-run > "$fixture/retitle-dry.txt"
grep -Fq 'Fix the widget ranking' "$fixture/retitle-dry.txt"
[ "$(sqlite3 "$SESH_DB" "SELECT title FROM session WHERE id = 'ses_newt';")" = 'New session - 2026-01-01T00:00:00.000Z' ]
if "$retitle" < /dev/null >/dev/null 2>&1; then echo "retitle without --yes was not refused" >&2; exit 1; fi
"$retitle" --yes < /dev/null > /dev/null
[ "$(sqlite3 "$SESH_DB" "SELECT title FROM session WHERE id = 'ses_newt';")" = 'Fix the widget ranking across directories' ]
[ "$(sqlite3 "$SESH_DB" "SELECT title FROM session WHERE id = 'ses_kept';")" = 'A real title' ]

# 27. Search weighting: a title hit outranks a transcript-only hit, and the
# current project rises while a query is active. Pins still win outright.
rank_dir="$fixture/rankdir"; mkdir -p "$rank_dir" "$fixture/otherdir"
add_session 'ses_ranktitle' "$fixture/otherdir" 'penguin migration' 1700000200000 1700000200000
add_part 'ses_ranktitle' 'msg_rt0' 'user' 'text' 'unrelated body' 1700000200000
add_session 'ses_rankbody' "$fixture/otherdir" 'Unrelated' 1700000999999 1700000999999
add_part 'ses_rankbody' 'msg_rb0' 'user' 'text' 'penguin appears only here' 1700000999999
rank_state="$fixture/rank-state"
( cd "$rank_dir"; "$list" --refresh --state-dir "$rank_state" > /dev/null )
( cd "$rank_dir"; "$list" --state-dir "$rank_state" --query penguin > "$fixture/rank.tsv" )
rank_order=$(awk -F'\t' '$2 != "" { print $2 }' "$fixture/rank.tsv" | tr '\n' ',')
[ "$rank_order" = 'ses_ranktitle,ses_rankbody,' ] \
  || { echo "title hit did not outrank transcript hit: $rank_order" >&2; exit 1; }
# With the query cleared, recency wins again (the body session is newer).
# Scoped to these two ids: an earlier test leaves a session pinned, and pins
# legitimately float above recency.
( cd "$rank_dir"; "$list" --state-dir "$rank_state" > "$fixture/rank-none.tsv" )
rank_none=$(awk -F'\t' '$2 == "ses_rankbody" || $2 == "ses_ranktitle" { print $2 }' "$fixture/rank-none.tsv" | tr '\n' ',')
[ "$rank_none" = 'ses_rankbody,ses_ranktitle,' ] \
  || { echo "idle order not by recency: $rank_none" >&2; exit 1; }

# 28. cmux workspace naming: each workspace is renamed to the title of the
# session its surface runs; placeholders and already-matching workspaces are
# left alone.
cmux_stub_dir="$fixture/cmuxbin"; mkdir -p "$cmux_stub_dir"
cat > "$cmux_stub_dir/cmux" <<STUB
#!/bin/bash
# Minimal cmux surface for the sync: one surface per workspace.
case "\$1 \$2" in
  "tree --json")
    echo '{"windows":[{"workspaces":[
      {"ref":"workspace:1","panes":[{"surfaces":[{"ref":"surface:1","type":"terminal"}]}]},
      {"ref":"workspace:2","panes":[{"surfaces":[{"ref":"surface:2","type":"terminal"}]}]},
      {"ref":"workspace:3","panes":[{"surfaces":[{"ref":"surface:3","type":"terminal"}]}]},
      {"ref":"workspace:9","panes":[{"surfaces":[{"ref":"surface:9","type":"terminal"}]}]}]}]}'
    ;;
  "surface resume")
    case "\$5" in
      surface:1) echo '{"restore_record":{"checkpoint_id":"ses_cmxA"}}' ;;
      surface:2) echo '{"restore_record":{"checkpoint_id":"ses_cmxB"}}' ;;
      surface:3) echo '{"restore_record":{"checkpoint_id":"ses_kept"}}' ;;
      surface:9) echo '{"restore_record":{"checkpoint_id":"ses_ghost"}}' ;;
      *) echo '{"restore_record":null}' ;;
    esac
    ;;
  "workspace list")
    echo '{"workspaces":[
      {"ref":"workspace:1","custom_title":"stale name"},
      {"ref":"workspace:2","custom_title":"Imported widgets"},
      {"ref":"workspace:3","custom_title":"anything"}]}'
    ;;
  "workspace rename")
    printf 'RENAME %s %s\n' "\$3" "\$5" >> "$fixture/cmux-renames.txt"
    ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$cmux_stub_dir/cmux"
add_session 'ses_cmxA' "$one" 'Add dark mode toggle' 1700001000000 1700001000000
add_part 'ses_cmxA' 'msg_cx1' 'user' 'text' 'body' 1700001000000
add_session 'ses_cmxB' "$two" 'Imported widgets' 1700001000000 1700001000000
add_part 'ses_cmxB' 'msg_cx2' 'user' 'text' 'body' 1700001000000
# ses_newt was retitled in test 26 to a real title; give it a placeholder here
# to prove placeholder titles are never pushed.
sqlite3 "$SESH_DB" "UPDATE session SET title = 'New session - 2026-01-01T00:00:00.000Z' WHERE id = 'ses_kept';"
# A ghost plugin session: its sentinel title must never become a workspace name.
add_session 'ses_ghost' "$one" 'ghost-hidden' 1700001000000 1700001000000
add_part 'ses_ghost' 'msg_gh1' 'user' 'text' 'body' 1700001000000
rm -f "$fixture/cmux-renames.txt"
cmuxsync="$PACKAGE_DIR/bin/sesh-cmux-sync.sh"
SESH_CMUX="$cmux_stub_dir/cmux" "$cmuxsync" --dry-run > "$fixture/cmux-dry.txt"
grep -Fq 'workspace:1 → Add dark mode toggle' "$fixture/cmux-dry.txt"
grep -Fq 'workspace:2' "$fixture/cmux-dry.txt" && { echo "already-matching workspace was queued" >&2; exit 1; }
grep -Fq 'Imported widgets' "$fixture/cmux-dry.txt" && { echo "already-matching workspace was queued" >&2; exit 1; }
grep -Fq 'workspace:3' "$fixture/cmux-dry.txt" && { echo "placeholder title was pushed" >&2; exit 1; }
grep -Fq 'ghost-hidden' "$fixture/cmux-dry.txt" && { echo "ghost sentinel title was pushed" >&2; exit 1; }
grep -Fq 'workspace:9' "$fixture/cmux-dry.txt" && { echo "ghost session's workspace was queued" >&2; exit 1; }
[ ! -f "$fixture/cmux-renames.txt" ]
SESH_CMUX="$cmux_stub_dir/cmux" "$cmuxsync" > "$fixture/cmux-apply.txt"
grep -Fq 'RENAME workspace:1 Add dark mode toggle' "$fixture/cmux-renames.txt"
grep -Fq 'workspace:2' "$fixture/cmux-renames.txt" && { echo "renamed an already-matching workspace" >&2; exit 1; }
grep -Fq 'workspace:3' "$fixture/cmux-renames.txt" && { echo "renamed to a placeholder title" >&2; exit 1; }
grep -Fq 'ghost-hidden' "$fixture/cmux-renames.txt" && { echo "renamed a workspace to the ghost sentinel" >&2; exit 1; }
[ "$(grep -c RENAME "$fixture/cmux-renames.txt")" = 1 ]

# Agent tool contract checks (global store, filter-before-limit) need Node.
if command -v node >/dev/null 2>&1; then
  node "$PACKAGE_DIR/tests/agent-tool.mjs"
  node "$PACKAGE_DIR/tests/tui.mjs"
else
  echo "sesh tests: node not found; skipping agent tool and TUI data-layer checks" >&2
fi

echo "sesh tests passed"
