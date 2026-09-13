#!/bin/bash
# Regression checks for the opencode session picker against a fixture database.
set -euo pipefail
PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
command -v sqlite3 >/dev/null 2>&1 || { echo "sqlite3 is required for these tests" >&2; exit 1; }

fixture=$(mktemp -d "${TMPDIR:-/tmp}/sesh-test.XXXXXX")
# Never read or write the user's real database or extraction cache.
export SESH_CACHE_DIR="$fixture/cache"
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
CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
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

# 7. Delete goes through the opencode CLI, then refreshes under the lock.
mkdir -p "$fixture/stubbin"
cat > "$fixture/stubbin/opencode" <<STUB
#!/bin/bash
[ "\$1 \$2" = "session delete" ] || exit 1
exec sqlite3 "$SESH_DB" "DELETE FROM session WHERE id = '\$3';"
STUB
chmod +x "$fixture/stubbin/opencode"
export SESH_OPENCODE="$fixture/stubbin/opencode"
PATH="$fixture/stubbin:$PATH"
printf '\n' | "$PACKAGE_DIR/bin/sesh-delete.sh" "$state" 'ses_beta'
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

# Agent tool contract checks (global store, filter-before-limit) need Node.
if command -v node >/dev/null 2>&1; then
  node "$PACKAGE_DIR/tests/agent-tool.mjs"
  node "$PACKAGE_DIR/tests/tui.mjs"
else
  echo "sesh tests: node not found; skipping agent tool and TUI data-layer checks" >&2
fi

echo "sesh tests passed"
