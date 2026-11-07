#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
BASH_BIN=$(command -v bash)
ORIGINAL_PATH=$PATH
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sesh-install-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

fail() { printf 'installer regression: %s\n' "$*" >&2; exit 1; }

mkdir -p "$WORK/tools" "$WORK/no-jq"
ln -s "$(command -v dirname)" "$WORK/no-jq/dirname"
printf '#!/bin/sh\nprintf "0.73.0\\n"\n' > "$WORK/tools/fzf"
printf '#!/bin/sh\nprintf "2.0.29\\n"\n' > "$WORK/tools/opencode"
printf '#!/bin/sh\nexit 1\n' > "$WORK/tools/pgrep"
chmod +x "$WORK/tools/"*

fixture() {
  export HOME="$WORK/$1"
  export XDG_CONFIG_HOME="$HOME/config" XDG_DATA_HOME="$HOME/data"
  export XDG_CACHE_HOME="$HOME/cache" XDG_BIN_HOME="$HOME/bin"
  export PATH="$WORK/tools:$ORIGINAL_PATH"
  unset SESH_FZF SESH_JQ SESH_SQLITE SESH_OPENCODE
  CONFIG="$XDG_CONFIG_HOME/opencode"
  mkdir -p "$CONFIG" "$XDG_BIN_HOME"
}

install() { "$BASH_BIN" "$ROOT/install.sh" "$@" > "$WORK/output" 2>&1; }

fixture smoke
install || { cat "$WORK/output"; fail 'fresh install failed'; }
[ "$(readlink "$XDG_BIN_HOME/sesh")" = "$ROOT/bin/sesh" ] || fail 'launcher target'
cmp -s "$ROOT/tui-plugins/sesh-panel/tui.tsx" "$CONFIG/tui-plugins/sesh-panel/tui.tsx" || fail 'panel copy'
range=$(jq -r '.devDependencies["@opentui/solid"]' "$ROOT/package.json")
jq -e --arg range "$range" '.dependencies["@opentui/solid"] == $range' "$CONFIG/package.json" >/dev/null || fail 'OpenTUI dependency drift'
width_version=$(jq -r '.dependencies["string-width"]' "$ROOT/package.json")
jq -e --arg version "$width_version" '.dependencies["string-width"] == $version' "$CONFIG/package.json" >/dev/null || fail 'terminal width dependency missing'
install || fail 'repeat install failed'
jq '.dependencies["string-width"] = "7.1.0"' "$CONFIG/package.json" > "$WORK/pinned-package.json"
mv "$WORK/pinned-package.json" "$CONFIG/package.json"
install || fail 'install with pinned width dependency failed'
jq -e '.dependencies["string-width"] == "7.1.0"' "$CONFIG/package.json" >/dev/null || fail 'terminal width dependency pin overwritten'
printf 'stale panel\n' > "$CONFIG/tui-plugins/sesh-panel/tui.tsx"
install --sync-panel || fail 'panel sync failed'
cmp -s "$ROOT/tui-plugins/sesh-panel/tui.tsx" "$CONFIG/tui-plugins/sesh-panel/tui.tsx" || fail 'panel sync did not refresh source'
install --uninstall || fail 'uninstall failed'
[ ! -L "$XDG_BIN_HOME/sesh" ] || fail 'owned launcher survived uninstall'

fixture corrupt
printf '{broken opencode\n' > "$CONFIG/opencode.json"
printf '{broken package\n' > "$CONFIG/package.json"
cp "$CONFIG/opencode.json" "$WORK/opencode.before"
cp "$CONFIG/package.json" "$WORK/package.before"
install || { cat "$WORK/output"; fail 'corrupt-config install failed'; }
cmp -s "$CONFIG/opencode.json" "$WORK/opencode.before" || fail 'corrupt opencode config overwritten'
cmp -s "$CONFIG/package.json" "$WORK/package.before" || fail 'corrupt package config overwritten'
grep -q 'could not update' "$WORK/output" || fail 'missing corrupt-config warning'

fixture foreign
mkdir -p "$HOME/third-party/bin"
printf '#!/bin/sh\nexit 0\n' > "$HOME/third-party/bin/sesh"
ln -s ../third-party/bin/sesh "$XDG_BIN_HOME/sesh"
if install --no-tool --no-tui; then fail 'foreign launcher accepted'; fi
install --uninstall || fail 'foreign uninstall failed'
[ "$(readlink "$XDG_BIN_HOME/sesh")" = ../third-party/bin/sesh ] || fail 'foreign launcher changed'

fixture npm
mkdir -p "$HOME/node_modules/opencode-sesh/bin"
printf '#!/bin/sh\nexit 0\n' > "$HOME/node_modules/opencode-sesh/bin/sesh"
printf '{"name":"opencode-sesh","bin":{"sesh":"bin/sesh"}}\n' > "$HOME/node_modules/opencode-sesh/package.json"
ln -s ../node_modules/opencode-sesh/bin/sesh "$XDG_BIN_HOME/sesh"
install --no-tool --no-tui || { cat "$WORK/output"; fail 'npm launcher not recognized'; }
[ "$(readlink "$XDG_BIN_HOME/sesh")" = "$ROOT/bin/sesh" ] || fail 'npm launcher not updated'
rm "$XDG_BIN_HOME/sesh"
ln -s ../node_modules/opencode-sesh/bin/sesh "$XDG_BIN_HOME/sesh"
install --uninstall || fail 'npm launcher uninstall failed'
[ ! -L "$XDG_BIN_HOME/sesh" ] || fail 'owned npm launcher survived uninstall'

fixture no-jq
export PATH="$WORK/no-jq"
install --sync-panel || fail 'absent panel should be a no-op without jq'
[ ! -e "$CONFIG/package.json" ] || fail 'absent panel created config'
PATH="$ORIGINAL_PATH" mkdir -p "$CONFIG/tui-plugins/sesh-panel"
printf 'existing panel\n' > "$CONFIG/tui-plugins/sesh-panel/tui.tsx"
if install --sync-panel; then fail 'installed panel sync accepted missing jq'; fi
export PATH="$ORIGINAL_PATH"
grep -q "required tool 'jq' is unavailable" "$WORK/output" || fail 'missing jq diagnostic'
[ "$(cat "$CONFIG/tui-plugins/sesh-panel/tui.tsx")" = 'existing panel' ] || fail 'missing jq changed panel'
[ ! -e "$CONFIG/package.json" ] || fail 'missing jq created config'

printf 'installer regressions passed\n'
