#!/usr/bin/env bash
# Install sesh for the current user.
# Terminal- and OS-agnostic: macOS and Linux, any terminal. No administrator
# privileges, downloads, or shell-rc edits. Runtime requires jq, fzf >= 0.52
# and sqlite3 or the opencode CLI; the in-TUI panel additionally needs the
# packages opencode installs for local plugins (handled below).
set -euo pipefail

fail() { printf 'sesh install: %s\n' "$*" >&2; exit 1; }
note() { printf 'sesh install: %s\n' "$*"; }

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Follow the same XDG locations opencode itself reads.
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_DIR="$CONFIG_HOME/opencode"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"

INSTALL_COMMAND=1
INSTALL_TOOL=1
INSTALL_TUI=1
UNINSTALL=0

# Fallback plugin version for when the opencode CLI is unavailable; the
# installer prefers the local opencode version so the panel matches its SDK.
# OpenTUI stays on the tested peer line (bump together with tui/sesh-panel.tsx).
PLUGIN_VERSION_FALLBACK="1.18.30"
OPENTUI_RANGE="^0.4.5"
SOLID_VERSION="1.9.12"

usage() {
  cat <<'USAGE'
Usage: bash install.sh [--bin-dir DIR] [--no-command] [--no-tool] [--no-tui] [--uninstall]

  --bin-dir DIR  Directory for the sesh launcher (default: ~/.local/bin).
  --no-command   Skip installing the /sesh slash command.
  --no-tool      Skip installing the sesh-list custom tool.
  --no-tui       Skip installing the in-TUI sessions panel plugin.
  --uninstall    Remove everything this script installed.
  --help         Show this help.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bin-dir) [ "$#" -ge 2 ] || fail "--bin-dir needs a directory."; BIN_DIR="$2"; shift 2 ;;
    --no-command) INSTALL_COMMAND=0; shift ;;
    --no-tool) INSTALL_TOOL=0; shift ;;
    --no-tui) INSTALL_TUI=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

LAUNCHER="$BIN_DIR/sesh"
COMMAND_DST="$CONFIG_DIR/commands/sesh.md"
TOOL_DST="$CONFIG_DIR/tools/sesh-list.ts"
PANEL_DST="$CONFIG_DIR/plugins/sesh-panel.tsx"
PACKAGE_JSON="$CONFIG_DIR/package.json"
TUI_JSON="$CONFIG_DIR/tui.json"

# Remove a file only when it carries our marker, so a user's own file with a
# colliding name is never destroyed.
remove_if_marker() {
  local file=$1 marker=$2
  if [ -f "$file" ] && grep -qF "$marker" "$file" 2>/dev/null; then
    rm -f "$file"
    return 0
  fi
  return 1
}

remove_tui_entry() {
  [ -f "$TUI_JSON" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  local tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/sesh-tui.XXXXXX") || return 0
  if jq 'if (.plugin | type) == "array" then .plugin = [.plugin[] | select(. != "./plugins/sesh-panel.tsx")] else . end' "$TUI_JSON" > "$tmp" 2>/dev/null; then
    cmp -s "$TUI_JSON" "$tmp" || { cp -p "$TUI_JSON" "$TUI_JSON.bak.$(date +%Y%m%d%H%M%S)"; mv "$tmp" "$TUI_JSON"; }
    rm -f "$tmp"
  else
    rm -f "$tmp"
  fi
}

if [ "$UNINSTALL" = 1 ]; then
  [ -L "$LAUNCHER" ] && rm -f "$LAUNCHER" && note "removed $LAUNCHER"
  remove_if_marker "$COMMAND_DST" "rich interactive picker" && note "removed $COMMAND_DST"
  remove_if_marker "$TOOL_DST" "list opencode sessions for the agent" && note "removed $TOOL_DST"
  remove_if_marker "$PANEL_DST" "@jsxImportSource @opentui/solid" && note "removed $PANEL_DST"
  remove_tui_entry && note "unregistered the panel from $TUI_JSON"
  note "uninstalled (extraction cache and plugin dependencies left intact)"
  exit 0
fi

for path in \
  bin/sesh \
  bin/sesh.sh \
  bin/sesh-list.sh \
  bin/sesh-preview.sh \
  bin/sesh-delete.sh \
  bin/sesh-refresh-worker.sh \
  bin/sesh-shortcuts.sh \
  opencode/commands/sesh.md \
  opencode/tools/sesh-list.ts \
  tui/sesh-panel.tsx \
  themes/glow-dark-clean.json; do
  [ -f "$SOURCE_DIR/$path" ] || fail "installer bundle is incomplete: missing $path."
done

for tool in bash jq fzf; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool '$tool' is unavailable."
done
fzf_version=$(fzf --version 2>/dev/null || true)
if [[ "$fzf_version" =~ ^([0-9]+)\.([0-9]+)(\.([0-9]+))? ]]; then
  if [ "$((10#${BASH_REMATCH[1]}))" -eq 0 ] && [ "$((10#${BASH_REMATCH[2]}))" -lt 52 ]; then
    fail "fzf >= 0.52.0 is required (found $fzf_version)."
  fi
else
  fail "cannot parse fzf version from: $fzf_version."
fi
command -v sqlite3 >/dev/null 2>&1 || command -v opencode >/dev/null 2>&1 \
  || fail "either sqlite3 or the opencode CLI is required."
command -v opencode >/dev/null 2>&1 || note "opencode CLI not found: listing and previews work via sqlite3, but resume and delete need opencode."

umask 077
mkdir -p "$BIN_DIR"
if [ -e "$LAUNCHER" ] && [ ! -L "$LAUNCHER" ]; then
  fail "$LAUNCHER already exists and is not a symlink. Move it aside, then retry."
fi
ln -sfn "$SOURCE_DIR/bin/sesh" "$LAUNCHER"
note "linked $LAUNCHER -> $SOURCE_DIR/bin/sesh"

install_file() {
  local src=$1 dst=$2
  mkdir -p "$(dirname "$dst")"
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    note "up to date $dst"
    return 0
  fi
  if [ -f "$dst" ]; then
    cp -p "$dst" "$dst.bak.$(date +%Y%m%d%H%M%S)"
    note "backed up existing $(basename "$dst")"
  fi
  cp -p "$src" "$dst"
  note "installed $dst"
}

[ "$INSTALL_COMMAND" = 1 ] && install_file "$SOURCE_DIR/opencode/commands/sesh.md" "$COMMAND_DST"
[ "$INSTALL_TOOL" = 1 ] && install_file "$SOURCE_DIR/opencode/tools/sesh-list.ts" "$TOOL_DST"

opencode_version=''
if command -v opencode >/dev/null 2>&1; then
  raw_version=$(opencode --version 2>/dev/null || true)
  if [[ "$raw_version" =~ ([0-9]+\.[0-9]+\.[0-9]+) ]]; then opencode_version="${BASH_REMATCH[1]}"; fi
fi
plugin_version="${opencode_version:-$PLUGIN_VERSION_FALLBACK}"

if [ "$INSTALL_TUI" = 1 ]; then
  install_file "$SOURCE_DIR/tui/sesh-panel.tsx" "$PANEL_DST"

  # opencode has no persistent-sidebar API: the panel is an xlarge modal
  # dialog (see tui/sesh-panel.tsx). Register it idempotently and drop the
  # previous filename if an older install left it behind.
  tui_created=0
  if [ ! -f "$TUI_JSON" ]; then
    printf '{\n  "$schema": "https://opencode.ai/tui.json",\n  "plugin": []\n}\n' > "$TUI_JSON"
    tui_created=1
    note "created $TUI_JSON"
  fi
  tui_tmp=$(mktemp "${TMPDIR:-/tmp}/sesh-tui.XXXXXX")
  if jq '
    (.plugin // []) as $plugins
    | ($plugins | map(select(. != "./plugins/sessions-panel.tsx"))) as $clean
    | .plugin = (if ($clean | index("./plugins/sesh-panel.tsx")) then $clean else $clean + ["./plugins/sesh-panel.tsx"] end)
  ' "$TUI_JSON" > "$tui_tmp" 2>/dev/null; then
    if cmp -s "$TUI_JSON" "$tui_tmp"; then
      note "tui.json already registers the sesh panel"
      rm -f "$tui_tmp"
    else
      [ "$tui_created" = 1 ] || cp -p "$TUI_JSON" "$TUI_JSON.bak.$(date +%Y%m%d%H%M%S)"
      mv "$tui_tmp" "$TUI_JSON"
      note "registered ./plugins/sesh-panel.tsx in tui.json"
    fi
  else
    rm -f "$tui_tmp"
    note "warning: could not update $TUI_JSON; add \"./plugins/sesh-panel.tsx\" to its plugin list by hand"
  fi

  # Local plugins resolve their imports from the config directory, and opencode
  # runs `bun install` there at startup. Keep the required packages declared
  # without clobbering versions the user already pinned.
  pkg_created=0
  if [ ! -f "$PACKAGE_JSON" ]; then
    printf '{\n  "dependencies": {}\n}\n' > "$PACKAGE_JSON"
    pkg_created=1
    note "created $PACKAGE_JSON"
  fi
  pkg_tmp=$(mktemp "${TMPDIR:-/tmp}/sesh-pkg.XXXXXX")
  if jq --arg p "$plugin_version" --arg o "$OPENTUI_RANGE" --arg s "$SOLID_VERSION" '
    .dependencies = ((.dependencies // {}) as $d
      | {
          "@opencode-ai/plugin": ($d["@opencode-ai/plugin"] // $p),
          "@opentui/core": ($d["@opentui/core"] // $o),
          "@opentui/keymap": ($d["@opentui/keymap"] // $o),
          "@opentui/solid": ($d["@opentui/solid"] // $o),
          "solid-js": ($d["solid-js"] // $s)
        } + $d)
  ' "$PACKAGE_JSON" > "$pkg_tmp" 2>/dev/null; then
    if cmp -s "$PACKAGE_JSON" "$pkg_tmp"; then
      note "plugin dependencies already present in $PACKAGE_JSON"
      rm -f "$pkg_tmp"
    else
      [ "$pkg_created" = 1 ] || cp -p "$PACKAGE_JSON" "$PACKAGE_JSON.bak.$(date +%Y%m%d%H%M%S)"
      mv "$pkg_tmp" "$PACKAGE_JSON"
      note "declared plugin dependencies in $PACKAGE_JSON (opencode installs them on next start)"
    fi
  else
    rm -f "$pkg_tmp"
    note "warning: could not update $PACKAGE_JSON; the TUI panel may fail to load"
  fi
fi

"$LAUNCHER" --check || fail "post-install check failed."
note "done"
note "  picker:  run 'sesh' in any terminal, or '/sesh' inside opencode"
note "  sidebar: restart opencode to load the panel (ctrl+o opens the full picker)"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) note "  note: $BIN_DIR is not on PATH; add it to use the launcher anywhere." ;;
esac
