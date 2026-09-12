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

# 8. A missing database reports unavailable instead of crashing.
export SESH_DB="$fixture/nonexistent.db"
missing="$fixture/missing"
"$list" --refresh --state-dir "$missing" > "$fixture/missing.tsv"
[ "$(cat "$missing/status")" = 'unavailable: opencode database is unavailable' ]

echo "sesh tests passed"
