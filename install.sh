#!/usr/bin/env bash
# Install sesh for the current user.
# Terminal- and OS-agnostic: macOS and Linux, any terminal. No administrator
# privileges, downloads, or shell-rc edits. Runtime requires jq, fzf >= 0.73
# and sqlite3; resuming and deleting need the opencode CLI. The in-TUI panel
# additionally needs the packages opencode installs for local plugins (handled
# below).
set -euo pipefail

fail() { printf 'sesh install: %s\n' "$*" >&2; exit 1; }
note() { printf 'sesh install: %s\n' "$*"; }

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Follow the same XDG locations opencode itself reads.
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_DIR="$CONFIG_HOME/opencode"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"

INSTALL_TOOL=1
INSTALL_TUI=1
UNINSTALL=0
SYNC_PANEL=0

# Fallback plugin version for when the opencode CLI is unavailable; the
# installer prefers the local opencode version so the panel matches its SDK.
PLUGIN_VERSION_FALLBACK="2.0.25"
# Peer line the panel was developed and typechecked against. A checkout's
# package.json overrides these, so dependency bumps cannot drift the installed
# config out of sync (solid-js moves with OpenTUI via @opentui/keymap's peer).
OPENTUI_RANGE="^0.5.11"
SOLID_VERSION="1.9.15"
if [ -f "$SOURCE_DIR/package.json" ] && command -v jq >/dev/null 2>&1; then
  opentui_range=$(jq -r '.devDependencies["@opentui/solid"] // empty' "$SOURCE_DIR/package.json" 2>/dev/null || true)
  solid_version=$(jq -r '.devDependencies["solid-js"] // empty' "$SOURCE_DIR/package.json" 2>/dev/null || true)
  if [ -n "$opentui_range" ]; then OPENTUI_RANGE=$opentui_range; fi
  if [ -n "$solid_version" ]; then SOLID_VERSION=$solid_version; fi
fi

usage() {
  cat <<'USAGE'
Usage: bash install.sh [--bin-dir DIR] [--no-tool] [--no-tui] [--uninstall]

  --bin-dir DIR  Directory for the sesh launcher (default: ~/.local/bin).
  --no-tool      Skip installing the sesh_list custom tool.
  --no-tui       Skip installing the in-TUI sessions panel plugin.
  --uninstall    Remove everything this script installed.
  --sync-panel   Refresh an already-installed TUI panel only (used by postinstall).
  --help         Show this help.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bin-dir) [ "$#" -ge 2 ] || fail "--bin-dir needs a directory."; BIN_DIR="$2"; shift 2 ;;
    --no-tool) INSTALL_TOOL=0; shift ;;
    --no-tui) INSTALL_TUI=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --sync-panel) SYNC_PANEL=1; shift ;;
    --help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

LAUNCHER="$BIN_DIR/sesh"
# `/sesh` is registered by the TUI plugin (a markdown command cannot open the
# dialog); this path only exists so we can clean up an obsolete install.
COMMAND_DST="$CONFIG_DIR/commands/sesh.md"
TOOL_DST="$CONFIG_DIR/plugins/sesh-list.ts"
PANEL_DIR="$CONFIG_DIR/tui-plugins/sesh-panel"
PANEL_DST="$PANEL_DIR/tui.tsx"
PACKAGE_JSON="$CONFIG_DIR/package.json"
OPENCODE_JSON="$CONFIG_DIR/opencode.json"
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
    cmp -s "$TUI_JSON" "$tmp" || mv "$tmp" "$TUI_JSON"
    rm -f "$tmp"
  else
    rm -f "$tmp"
  fi
}

remove_opencode_entry() {
  [ -f "$OPENCODE_JSON" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  local tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/sesh-opencode.XXXXXX") || return 0
  if jq 'if (.plugins | type) == "array" then .plugins = [.plugins[] | select(. != "./tui-plugins/sesh-panel")] else . end' "$OPENCODE_JSON" > "$tmp" 2>/dev/null; then
    cmp -s "$OPENCODE_JSON" "$tmp" || mv "$tmp" "$OPENCODE_JSON"
    rm -f "$tmp"
  else
    rm -f "$tmp"
  fi
}

# The launcher is a symlink we create. Treat it as ours only when it resolves to
# a sesh launcher, so a foreign symlink is never replaced on install nor deleted
# on uninstall. Recognized by the exact source path, a `.../bin/sesh` target, or
# the marker in the target file (covers npm upgrades and a moved checkout).
launcher_is_ours() {
  local link=$1 target
  [ -L "$link" ] || return 1
  target=$(readlink "$link" 2>/dev/null) || return 1
  [ -n "$target" ] || return 1
  case "$target" in
    /*) ;;
    *) target="$(cd "$(dirname "$link")" && pwd -P)/$target" ;;
  esac
  case "$target" in
    "$SOURCE_DIR/bin/sesh"|*/bin/sesh) return 0 ;;
  esac
  [ -f "$target" ] && grep -qF 'Pick an opencode session' "$target" 2>/dev/null
}

install_file() {
  local src=$1 dst=$2
  mkdir -p "$(dirname "$dst")"
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    note "up to date $dst"
    return 0
  fi
  cp -p "$src" "$dst"
  note "installed $dst"
}

install_tui_panel() {
  install_file "$SOURCE_DIR/tui-plugins/sesh-panel/package.json" "$PANEL_DIR/package.json"
  install_file "$SOURCE_DIR/tui-plugins/sesh-panel/server.ts" "$PANEL_DIR/server.ts"
  install_file "$SOURCE_DIR/tui-plugins/sesh-panel/tui.tsx" "$PANEL_DST"

  local opencode_version='' raw_version='' plugin_version=''
  if command -v opencode >/dev/null 2>&1; then
    raw_version=$(opencode --version 2>/dev/null || true)
    if [[ "$raw_version" =~ ([0-9]+\.[0-9]+\.[0-9]+) ]]; then opencode_version="${BASH_REMATCH[1]}"; fi
  fi
  plugin_version="${opencode_version:-$PLUGIN_VERSION_FALLBACK}"

  local opencode_created=0 opencode_tmp=''
  if [ ! -f "$OPENCODE_JSON" ]; then
    printf '{\n  "$schema": "https://opencode.ai/config.json",\n  "plugins": []\n}\n' > "$OPENCODE_JSON"
    opencode_created=1
    note "created $OPENCODE_JSON"
  fi
  opencode_tmp=$(mktemp "${TMPDIR:-/tmp}/sesh-opencode.XXXXXX")
  if jq '
    (.plugins // []) as $plugins
    | if ($plugins | index("./tui-plugins/sesh-panel")) then . else .plugins = $plugins + ["./tui-plugins/sesh-panel"] end
  ' "$OPENCODE_JSON" > "$opencode_tmp" 2>/dev/null; then
    if cmp -s "$OPENCODE_JSON" "$opencode_tmp"; then
      note "opencode.json already registers the sesh panel"
      rm -f "$opencode_tmp"
    else
      mv "$opencode_tmp" "$OPENCODE_JSON"
      note "registered ./tui-plugins/sesh-panel in opencode.json"
    fi
  else
    rm -f "$opencode_tmp"
    note "warning: could not update $OPENCODE_JSON; add \"./tui-plugins/sesh-panel\" to its plugins list by hand"
  fi

  # Clean up obsolete V1 tui.json entry if present
  remove_tui_entry

  # Local plugins resolve their imports from the config directory, and opencode
  # runs `bun install` there at startup. Keep the required packages declared
  # without clobbering versions the user already pinned.
  local pkg_created=0 pkg_tmp=''
  if [ ! -f "$PACKAGE_JSON" ]; then
    printf '{\n  "dependencies": {}\n}\n' > "$PACKAGE_JSON"
    pkg_created=1
    note "created $PACKAGE_JSON"
  fi
  pkg_tmp=$(mktemp "${TMPDIR:-/tmp}/sesh-pkg.XXXXXX")
  if jq --arg p "^$plugin_version" --arg o "$OPENTUI_RANGE" --arg s "$SOLID_VERSION" '
    .dependencies = ((.dependencies // {}) as $d
      | {
          "@opencode/plugin": ($d["@opencode/plugin"] // $p),
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
      mv "$pkg_tmp" "$PACKAGE_JSON"
      note "declared plugin dependencies in $PACKAGE_JSON (opencode installs them on next start)"
    fi
  else
    rm -f "$pkg_tmp"
    note "warning: could not update $PACKAGE_JSON; the TUI panel may fail to load"
  fi
}

note_restart() {
  note "V2 reloads watched plugins automatically; if the panel stays unchanged, restart opencode: quit it completely"
  note "  (all windows and background processes), then reopen."
  if command -v pgrep >/dev/null 2>&1; then
    local pids
    pids=$(pgrep -x opencode 2>/dev/null | tr '\n' ' ' | sed 's/ $//' || true)
    [ -n "$pids" ] && note "  still running: opencode PID(s) $pids"
  fi
  return 0
}

if [ "$UNINSTALL" = 1 ]; then
  if [ -L "$LAUNCHER" ]; then
    if launcher_is_ours "$LAUNCHER"; then
      rm -f "$LAUNCHER" && note "removed $LAUNCHER"
    else
      note "left $LAUNCHER untouched (not a sesh launcher: $(readlink "$LAUNCHER" 2>/dev/null))"
    fi
  fi
  remove_if_marker "$COMMAND_DST" "rich interactive picker" && note "removed $COMMAND_DST"
  remove_if_marker "$TOOL_DST" "sesh_list" && note "removed $TOOL_DST"
  remove_if_marker "$CONFIG_DIR/tools/sesh-list.ts" "list opencode sessions for the agent" && note "removed $CONFIG_DIR/tools/sesh-list.ts"
  if [ -d "$PANEL_DIR" ]; then
    rm -rf "$PANEL_DIR" && note "removed $PANEL_DIR"
  fi
  remove_if_marker "$CONFIG_DIR/plugins/sesh-panel.tsx" 'id: "sesh-panel"' && note "removed $CONFIG_DIR/plugins/sesh-panel.tsx"
  remove_opencode_entry && note "unregistered the panel from $OPENCODE_JSON"
  remove_tui_entry && note "unregistered the panel from $TUI_JSON"
  note "uninstalled (extraction cache and plugin dependencies left intact)"
  exit 0
fi

for path in \
  bin/sesh \
  bin/sesh.sh \
  bin/sesh-list.sh \
  bin/sesh-preview.sh \
  bin/sesh-costs.sh \
  bin/sesh-delete.sh \
  bin/sesh-prune.sh \
  bin/sesh-refresh-worker.sh \
  bin/sesh-waiting.sh \
  bin/sesh-shortcuts.sh \
  plugins/sesh-list.ts \
  tui-plugins/sesh-panel/package.json \
  tui-plugins/sesh-panel/server.ts \
  tui-plugins/sesh-panel/tui.tsx \
  themes/glow-dark-clean.json; do
  [ -f "$SOURCE_DIR/$path" ] || fail "installer bundle is incomplete: missing $path."
done

if [ "$SYNC_PANEL" = 1 ]; then
  # Postinstall path: refresh a panel the user already opted into, without
  # touching the launcher or requiring fzf/sqlite. No-op when the panel is
  # absent, so `npm install` never adds a TUI panel on its own.
  [ -f "$PANEL_DST" ] || { note "sesh sidebar panel is not installed; nothing to sync."; exit 0; }
  umask 077
  install_tui_panel
  note_restart
  exit 0
fi

for tool in bash jq fzf; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool '$tool' is unavailable."
done
fzf_version=$(fzf --version 2>/dev/null || true)
if [[ "$fzf_version" =~ ^([0-9]+)\.([0-9]+)(\.([0-9]+))? ]]; then
  if [ "$((10#${BASH_REMATCH[1]}))" -eq 0 ] && [ "$((10#${BASH_REMATCH[2]}))" -lt 73 ]; then
    fail "fzf >= 0.73.0 is required (found $fzf_version)."
  fi
else
  fail "cannot parse fzf version from: $fzf_version."
fi
command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 is required."
command -v opencode >/dev/null 2>&1 || note "opencode CLI not found: listing and previews work via sqlite3, but resume and delete need opencode."

umask 077
mkdir -p "$BIN_DIR"
if [ -e "$LAUNCHER" ] && [ ! -L "$LAUNCHER" ]; then
  fail "$LAUNCHER already exists and is not a symlink. Move it aside, then retry."
fi
if [ -L "$LAUNCHER" ] && ! launcher_is_ours "$LAUNCHER"; then
  fail "$LAUNCHER is a symlink to $(readlink "$LAUNCHER" 2>/dev/null), which is not a sesh install. Move it aside, then retry."
fi
ln -sfn "$SOURCE_DIR/bin/sesh" "$LAUNCHER"
note "linked $LAUNCHER -> $SOURCE_DIR/bin/sesh"

# Earlier versions shipped a markdown `/sesh` command that could only prompt the
# agent; the TUI plugin now registers the slash itself. Drop the old file so the
# two do not collide.
remove_if_marker "$COMMAND_DST" "rich interactive picker" && note "removed obsolete markdown command $COMMAND_DST"
[ "$INSTALL_TOOL" = 1 ] && install_file "$SOURCE_DIR/plugins/sesh-list.ts" "$TOOL_DST"
# Clean up obsolete V1 tool if present
remove_if_marker "$CONFIG_DIR/tools/sesh-list.ts" "list opencode sessions for the agent" && note "removed obsolete V1 tool"
remove_if_marker "$CONFIG_DIR/plugins/sesh-panel.tsx" 'id: "sesh-panel"' && note "removed obsolete V1 panel"

if [ "$INSTALL_TUI" = 1 ]; then
  install_tui_panel
fi

"$LAUNCHER" --check || fail "post-install check failed."
note "done"
note "  picker:  run 'sesh' in any terminal, or '/sesh' inside opencode"
note "  TUI:     Option-O opens the full picker"
note_restart
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) note "  note: $BIN_DIR is not on PATH; add it to use the launcher anywhere." ;;
esac
