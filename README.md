# sesh

**A session browser for [opencode](https://opencode.ai).** Search every session
across every project, preview the transcript, and resume in place — from your
terminal or from inside the TUI.

`opencode` keeps a growing pile of sessions, and its native lists (`<leader>l`,
`/sessions`) are scoped to the current project. `sesh` shows all of them —
grouped by directory, full-text searchable, and previewable from anywhere.

[![CI](https://github.com/ozandogrultan/opencode-sesh/actions/workflows/ci.yml/badge.svg)](https://github.com/ozandogrultan/opencode-sesh/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)
[![GitHub stars](https://img.shields.io/github/stars/ozandogrultan/opencode-sesh?style=social)](https://github.com/ozandogrultan/opencode-sesh/stargazers)

```text
❯ auth
  ~/code/api                                 (8)
  ├ Retry the OAuth token refresh       2h
  ├ Login rate limiting notes          3d
  └ auth middleware cleanup           11d
  ~/code/web                                (3)
  ├ Fix session cookie on Safari       1d
  └ Redirect loop after logout         6d
```

## Why sesh

- **Every session, everywhere.** Sessions are grouped by project directory and
  sorted by pins, then recency — across *all* your projects, not just the current one.
- **Pin what matters.** Ctrl-S pins a session and Ctrl-D pins its directory in
  either picker. Pins are shared across the terminal and opencode TUI and
  persist across restarts; pinned directories and sessions sort first.
- **Full-text search.** Type to match against session titles *and* the text of
  the conversation itself. Reasoning and tool output are excluded, so the index
  stays clean.
- **Transcript preview.** Space shows the most recent messages first, rendered as
  Markdown (with `glow` if you have it).
- **Resume in place.** Enter `exec`s `opencode --session <id>` in the session's
  own directory. Ctrl-F forks instead. Your terminal becomes the session — no
  tabs, no panes, no window management.
- **Native TUI, too.** A recent-sessions section in the opencode sidebar plus a
  `ctrl+o` picker, both themed by your opencode theme.
- **Fast.** The database is scanned once per refresh and cached; keystrokes only
  re-render the last snapshot, so typing never triggers a query storm.

## Install

With npm:

```bash
npm install -g opencode-sesh
sesh install
```

Or from source:

```bash
git clone https://github.com/ozandogrultan/opencode-sesh.git
cd opencode-sesh
bash install.sh
```

`sesh install` (or `bash install.sh`) links `sesh` into `$XDG_BIN_HOME`
(default `~/.local/bin`), copies
the `sesh-list` tool and the TUI panel into
`${XDG_CONFIG_HOME:-~/.config}/opencode`, registers the panel in `tui.json`, and
declares the plugin dependencies (opencode installs them on next start). The
panel registers the `/sesh` slash command. It never edits your shell rc, and any
file it would overwrite is backed up first.

The npm package ships the same scripts and installer; the runtime tools below
are still required.

Fully quit opencode and reopen it to load the panel — opencode imports plugins
once at startup, so reloading a window reuses the running process. Upgrades
refresh an already-installed panel automatically (the npm `postinstall` syncs
it), and `sesh --check` reports when the installed panel is out of date.

Then:

```bash
sesh              # terminal picker
```

```text
/sesh             # inside opencode — picker (TUI plugin)
ctrl+o            # inside opencode — picker
```

### Requirements

- [opencode](https://opencode.ai), used at least once
- `bash`, `jq`, and [`fzf`](https://github.com/junegunn/fzf) `>= 0.73`
- `sqlite3` recommended — the picker queries the session DB directly in
  milliseconds and falls back to the slower `opencode db` CLI without it
- [`glow`](https://github.com/charmbracelet/glow) optional — styles the
  transcript preview as Markdown; without it the preview shows the plain
  Markdown, unchanged otherwise

### Uninstall

```bash
sesh uninstall        # npm installs
bash install.sh --uninstall   # from source
```

## Usage

### Terminal picker

| Key | Action |
| --- | --- |
| Type | Search titles and transcript text across all directories |
| Enter | Resume the selected session in this terminal |
| Ctrl-F       | Resume as a fork (the original is untouched) |
| Ctrl-G | Toggle current-directory scope / all sessions |
| Ctrl-S / Ctrl-D | Pin or unpin the selected session / directory |
| Ctrl-P | Toggle the transcript preview |
| `?` (empty query) | Toggle shortcut help |
| Ctrl-X | Delete the selected session (asks to confirm) |
| Escape | Exit |

The header line always shows the effective scope, the session count and whether
the index is fresh or stale, so a `Ctrl-G` toggle is never silent. A query that
matches nothing says so instead of showing an empty screen.

Flags: `--cwd` (current directory only), `--limit N` (default: all),
`--archived`, `--print` (print `id<TAB>cwd` instead of resuming), `--fork`,
`--json` (with `--print`, emit JSON), `--query TEXT`, `--check`,
`--needs-input` (list sessions waiting on you instead of opening the picker).

`sesh prune [--older-than 30d] [--dry-run] [--yes] [--delete]` archives stale
sessions (not updated within the threshold) so the list stays triageable.
Pinned sessions, sessions waiting on you, fork children and already-archived
sessions are never touched; archiving is reversible, while `--delete`
hard-deletes through `opencode session delete`. Without `--dry-run`, a TTY run
confirms first and a non-TTY run needs `--yes`.

`sesh costs [--days N] [--json]` sums assistant-message cost per project, with a
recent window beside the lifetime total, so a day's work reads as a
per-project record.

`sesh retitle [--dry-run] [--yes]` replaces auto-generated placeholder titles
(`New session - …`) with the start of the session's first user message. Only
placeholder titles are touched, and the same dry-run/`--yes` gating applies.

When searching, title matches outrank transcript-only matches and the current
project rises, so the list answers "where was that thing I worked on" before it
answers "what is newest". Pins still win outright.

Because `--print` just emits the id and directory, `sesh` doubles as a scriptable
session lookup:

```bash
read -r id cwd < <(sesh --print --query "auth")
sesh --print --json --query "auth" | jq -r .cwd
```

Deleting is irreversible, so the picker asks before dispatching it, and a
non-interactive `sesh-delete.sh` refuses unless given `--yes`.

### TUI panel

| Key | Action |
| --- | --- |
| `/sesh` | Open the full picker |
| `/sesh-costs` | Per-project cost digest (24h beside lifetime) |
| `/sesh-needs` | Sessions waiting on you (Enter opens) |
| `ctrl+o` | Open the full picker (also in the command palette) |
| Type | Search titles, directories and transcript text |
| `↑`/`↓`, `PgUp`/`PgDn`, `Home`/`End` | Move the selection |
| Ctrl-P | Toggle the transcript preview |
| Enter | Open the selected session |
| Ctrl-X | Delete the selected session (asks to confirm) |
| Ctrl-F | Fork the selected session |
| Ctrl-G | Toggle scope: the selected session's project, or every project |
| Option-W / Option-P | Show only sessions needing input / pinned sessions |
| Ctrl-S / Ctrl-D | Pin or unpin the selected session / directory |
| Esc | Close |

Click the sidebar's `search…` box to filter recent sessions in place; click
elsewhere or press Esc to leave search. Click the **Sessions** heading to drive
the list from the keyboard instead of the mouse (`↑`/`↓` to move, Enter to open,
Ctrl-P to preview, Ctrl-S/Ctrl-D to pin, Ctrl-X to delete, Esc to leave). Pinned
directories rise first, while sessions within each directory are ordered by
last update, newest first. The section lists every session and scrolls to fill
the sidebar, so click **▾ hide** to collapse it when you need the room.
Sessions waiting on you (unanswered agent questions, runs stuck mid-tool) pin
themselves to a **Needs input** group above the directories, with the count in
the heading; `sesh --needs-input` lists the same set in the terminal. Row
markers are the only status signal: a loading spinner marks the session whose
agent is working; the open session shows ● and every other row stays neutral.
Hovering a row while keyboard navigation is active selects it for the next
shortcut. Clicking (or Enter on) a session opens it here. The full picker is one
keystroke away.

The full picker pages through your whole global session list (no fixed window)
and indexes transcript text for every session in the background, showing
indexing progress under the search box. It only stops at a safety cap of 5,000
sessions, and says so when it does. Transcript matches show a short excerpt
under the result; the Project, Needs input, and Pinned filters combine with
search. The picker remembers your query and filters until you restart opencode.
The Needs input dialog (`/sesh-needs`) shows why and how long each session has
been waiting, oldest first. Press `n` there to open the next waiting session,
or reopen it after answering one to continue through the list.

## Configuration

All variables are optional.

| Variable | Default | Effect |
| --- | --- | --- |
| `SESH_DB` | `opencode db path` | opencode SQLite database |
| `SESH_SQLITE` | `sqlite3` | query tool (`opencode db` is ~300 ms/call) |
| `SESH_JQ` / `SESH_FZF` | `PATH` | explicit executable overrides |
| `SESH_GLOW` | first `glow` on `PATH` | optional Markdown preview renderer |
| `SESH_OPENCODE` | `opencode` | opencode executable (resume / delete) |
| `SESH_CACHE_DIR` | `~/.cache/sesh` | persistent search-index cache |
| `SESH_PINS_FILE` | `${XDG_DATA_HOME:-~/.local/share}/sesh/pins.json` | shared persistent session/directory pins |

## Integrations

sesh is terminal-agnostic on purpose: it has no window-management code. The
[`contrib/cmux/`](contrib/cmux/README.md) directory shows how to drive it from
cmux — command-palette entries, shortcuts, resuming a session in its own
workspace, and a global "resume from anywhere" hotkey — all caller-side.

## How it works

`bin/sesh-list.sh` is the only `bin/` script that reads the opencode session
store (SQLite: `session` / `message` / `part`). Each refresh extracts session
metadata and text-only parts into a persistent per-session cache keyed on
`time_updated`, part count and the latest part timestamp, then atomically
publishes a `snapshot.jsonl`. Every keystroke re-renders that snapshot with `jq`
alone, so typing never starts competing database scans. Reasoning and tool
payloads are never indexed or previewed, and session ids are validated before
any SQL interpolation.

Flat scripts back the terminal UI — the picker (`sesh.sh`), the refresh engine
(`sesh-list.sh`, driven by a per-picker `sesh-refresh-worker.sh` that serializes
scans), preview renderer (`sesh-preview.sh`), deleter (`sesh-delete.sh`) and
shortcut help (`sesh-shortcuts.sh`). The TUI panel (`tui/sesh-panel.tsx`) is a
SolidJS OpenTUI plugin that talks to the opencode SDK over the same store; the
`sesh-list` agent tool reads it through `opencode db`.

## FAQ

**Does it replace opencode's native session list?** No. `<leader>l` and the
native `/sessions` command are untouched; `sesh` is additive.

**Is there an agent-facing list?** Yes — the `sesh-list` tool lets the model list
every session across all directories (the native `opencode session list` only
covers the current project) and offer to resume one.

**Where is my data?** It reads the opencode database read-only and caches
extracted text under `~/.cache/sesh`. Nothing is uploaded anywhere.

**Does it work on Windows?** It targets macOS and Linux. WSL should work; native
Windows is untested.

**Why a separate terminal picker *and* a TUI panel?** The panel is always one
keystroke away while you work. The terminal picker is fullscreen and works from
any shell, including outside opencode.

## Contributing

Issues and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full
guide; this project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Run the
checks before opening a PR:

```bash
bun install
bun run test         # fixture-database regression suite
bun run test:picker  # PTY picker suite (needs fzf >= 0.73)
bun run typecheck    # tsc over tui/ and opencode/
bun run lint:sh      # bash -n on every script
```

`HOME=/tmp/fakehome bash install.sh` smoke-tests the installer without touching
your real opencode config. [AGENTS.md](AGENTS.md) documents the architecture and
the hard-won TUI rules.

## License

[MIT](LICENSE)
