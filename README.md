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
  sorted by recency — across *all* your projects, not just the current one.
- **Full-text search.** Type to match against session titles *and* the text of
  the conversation itself. Reasoning and tool output are excluded, so the index
  stays clean.
- **Transcript preview.** Space shows the tail of the conversation, rendered as
  Markdown (with `glow` if you have it).
- **Resume in place.** Enter `exec`s `opencode --session <id>` in the session's
  own directory. Ctrl-F forks instead. Your terminal becomes the session — no
  tabs, no panes, no window management.
- **Native TUI, too.** A recent-sessions section in the opencode sidebar plus a
  `ctrl+o` picker, both themed by your opencode theme.
- **Fast.** The database is scanned once per refresh and cached; keystrokes only
  re-render the last snapshot, so typing never triggers a query storm.

## Install

```bash
git clone https://github.com/ozandogrultan/opencode-sesh.git
cd opencode-sesh
bash install.sh
```

The installer links `sesh` into `~/.local/bin`, copies the `sesh-list` tool and
the TUI panel into `${XDG_CONFIG_HOME:-~/.config}/opencode`, registers the panel
in `tui.json`, and declares the plugin dependencies (opencode installs them on
next start). The panel registers the `/sesh` slash command. It never edits your
shell rc, and any file it would overwrite is backed up first.

Restart opencode to load the panel, then:

```bash
sesh              # terminal picker
```

```text
/sesh             # inside opencode — picker (TUI plugin)
ctrl+o            # inside opencode — picker
```

### Requirements

- [opencode](https://opencode.ai), used at least once
- `bash`, `jq`, and [`fzf`](https://github.com/junegunn/fzf) `>= 0.52`
- `sqlite3` recommended — the picker queries the session DB directly in
  milliseconds and falls back to the slower `opencode db` CLI without it
- [`glow`](https://github.com/charmbracelet/glow) optional — styles the
  transcript preview as Markdown; without it the preview shows the plain
  Markdown, unchanged otherwise

### Uninstall

```bash
bash install.sh --uninstall
```

## Usage

### Terminal picker

| Key | Action |
| --- | --- |
| Type | Search titles and transcript text across all directories |
| Enter | Resume the selected session in this terminal |
| Ctrl-F Enter | Resume as a fork (the original is untouched) |
| Ctrl-G | Toggle current-directory scope / all sessions |
| Space (empty query) | Toggle the transcript preview |
| `?` (empty query) | Toggle shortcut help |
| Ctrl-X | Delete the selected session |
| Escape | Exit |

Flags: `--cwd` (current directory only), `--limit N` (default: all),
`--archived`, `--print` (print `id<TAB>cwd` instead of resuming), `--fork`,
`--query TEXT`, `--check`.

Because `--print` just emits the id and directory, `sesh` doubles as a scriptable
session lookup:

```bash
read -r id cwd < <(sesh --print --query "auth")
```

### TUI panel

| Key | Action |
| --- | --- |
| `/sesh` | Open the full picker |
| `ctrl+o` | Open the full picker (also in the command palette) |
| Type | Search titles, directories and transcript text |
| `↑`/`↓`, `PgUp`/`PgDn`, `Home`/`End` | Move the selection |
| Space | Toggle the transcript preview |
| Enter | Open the selected session |
| Esc | Close |

Click the sidebar's `search…` box to filter recent sessions in place; click
elsewhere or press Esc to leave search.

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

## How it works

`bin/sesh-list.sh` is the only place that reads the opencode session store
(SQLite: `session` / `message` / `part`). Each refresh extracts session metadata
and text-only parts into a persistent per-session cache keyed on `time_updated`
and part count, then atomically publishes a `snapshot.jsonl`. Every keystroke
re-renders that snapshot with `jq` alone, so typing never starts competing
database scans. Reasoning and tool payloads are never indexed or previewed, and
session ids are validated before any SQL interpolation.

Four flat scripts back the terminal UI — the picker (`sesh.sh`), snapshot
builder (`sesh-list.sh`), preview renderer (`sesh-preview.sh`) and deleter
(`sesh-delete.sh`) — with one worker process per picker serializing refreshes.
The TUI panel (`tui/sesh-panel.tsx`) is a SolidJS OpenTUI plugin that talks to
the opencode SDK over the same store.

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
npm install
npm test             # fixture-database regression suite
npm run typecheck    # tsc over tui/ and opencode/
npm run lint:sh      # bash -n on every script
```

`HOME=/tmp/fakehome bash install.sh` smoke-tests the installer without touching
your real opencode config. [AGENTS.md](AGENTS.md) documents the architecture and
the hard-won TUI rules.

## License

[MIT](LICENSE)
