# AGENTS.md — sesh

Instructions for AI coding agents working in this repository. The map, not the
territory: read this first, then the specific file you need.

## What this is

`sesh` is an opencode-native session browser in three parts:

1. **`bin/`** — a fullscreen [fzf](https://github.com/junegunn/fzf) picker for
   any terminal. Lists **all** sessions across **all** project directories,
   full-text searchable, with transcript preview and resume/fork/delete.
2. **`tui/sesh-panel.tsx`** — a SolidJS/OpenTUI plugin for the opencode TUI: a
   recent-sessions section in the sidebar plus a `ctrl+o` / `/sesh` picker.
3. **`opencode/tools/sesh-list.ts`** — the `sesh-list` custom tool, so the agent
   can list sessions across every directory by querying the global `opencode
   db` store (the native `opencode session list` is project-scoped).

No iTerm2, no AppleScript, no panes, no window management — **never add any.**
opencode has no persistent-sidebar API, so the "sidebar" is a `sidebar_content`
slot section plus an xlarge modal picker; the terminal UI is fullscreen fzf.

## Start here

```bash
npm install            # dev deps (TypeScript, opencode/OpenTUI types)
npm test               # fixture-DB regression suite — must stay green
npm run typecheck      # tsc over tui/ and opencode/
npm run lint:sh        # bash -n on every script
HOME=/tmp/fakehome bash install.sh   # installer smoke test (never touches ~/.config)
```

## Layout

- `bin/` — flat; no subdirs. Scripts resolve siblings from their own location.
  Never hardcode install paths.
- `tui/sesh-panel.tsx` — SolidJS panel, `/** @jsxImportSource @opentui/solid */`.
- `opencode/tools/sesh-list.ts` — the agent-facing `sesh-list` tool.
- `themes/`, `tests/`, `install.sh`, `README.md`.

The **filename becomes the tool name** in opencode, so `sesh-list.ts` is the
`sesh-list` tool. Do not rename it without updating the docs.

## Data flow (fzf picker)

`bin/sesh-list.sh` owns the fzf picker's session store access (opencode SQLite
DB: `session` / `message` / `part` tables); the `sesh-list` agent tool queries
the same store through `opencode db`. Keep its SQL column names in sync with
the schema below. Keystrokes never touch the database:

- `--refresh` (expensive): bulk-reads session metadata and per-session text
  parts, validates the persistent extraction cache
  (`$SESH_CACHE_DIR/extractions/<ses_*.json>`, schema 2) against `time_updated`,
  part count and the latest part timestamp, re-extracts only changed sessions,
  prunes vanished ones, and atomically publishes `STATE_DIR/snapshot.jsonl`.
  Extraction moves transcripts through files, never argv (no ARG_MAX limit); if
  any session fails, the published status is `stale` and that session stays
  uncached so the next refresh retries, otherwise `status = fresh`. Scope
  (`--cwd`/toggle) and `--limit` apply at assembly, so metadata always covers
  the whole DB and pruning is always safe.
- render (cheap, pure `jq`): reads the snapshot only. Filters on `searchText`
  (title + `fulltextLower`, both lowercased at extraction), groups by `cwd`,
  sorts groups/items by recency, renders the TSV.

**Output contract** (TSV, 6 fields):
`agentId  sessionId  liveState  display  cwd  trackingId`. `display` is the only
rendered column; `trackingId` is fzf's `--id-nth`. Headers/notices carry an
empty `sessionId` and are a selection no-op — keep that guard.

One worker (`sesh-refresh-worker.sh`, per picker, TERMed on exit) serializes
scans; fzf's `start`/`every(3)`/`change` bindings render only. Selection requests
a fresh poll (`request`/`wait`, ≤12 s) before dispatch. opencode has no
live-agent API, so `liveState` is always `unknown` and rows render gray;
dispatch is always `opencode --session <id>` (`--fork` with Ctrl-F or --fork).
Resume happens in place (`exec` after `cd` to the session's cwd).

## Conventions

- Default scope is **all** sessions, every directory. `--cwd`/Ctrl-G narrows.
  Archived sessions and fork children are hidden unless `--archived`.
- **Text parts only** in search/preview; reasoning and tool payloads are
  excluded (asserted in tests).
- Validate session ids (`^ses_[A-Za-z0-9]+$`) before SQL interpolation — never
  interpolate unvalidated input. Open SQLite read-only (`sqlite3 -readonly`).
- Prefer direct `sqlite3` over `opencode db` (startup latency). Never parse
  `sqlite3 -json` in `-R` mode; it pretty-prints — parse as JSON.
- `jq -R` output stays JSON-quoted: use `-Rr` when a shell variable needs the
  raw string.
- fzf: stock only, `>= 0.73` (`transform:`, `every():`). `{q}` in binds is
  shell-quoted by fzf — don't add quoting. Ctrl-G is bind-only (stays open);
  Ctrl-F is `--expect` (accepts with fork).
- The installer prefers the local opencode version for `@opencode-ai/*` and
  merges (never clobbers) the config `package.json`; opencode runs `bun install`
  at startup.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat`, `fix`, `docs`, `ci`, …). See
  [CONTRIBUTING.md](CONTRIBUTING.md#commit-messages) for the types and the
  version mapping.

## TUI panel (`tui/sesh-panel.tsx`)

- **Sidebar:** `api.slots.register` on `sidebar_content` (append mode — native
  sidebar content stays). Renders the most recent unarchived sessions with the
  current one highlighted, polled every 15 s. Display-only; the picker does
  actions.
- **Picker:** a custom dialog (not `DialogSelect`) grouped by
  project/directory, recency-ordered, resume via
  `api.route.navigate("session", …)`. `ctrl+o` and the command palette open it;
  Ctrl-X deletes via the opencode CLI and removes the row only after the server
  confirms the deletion.

### Hard-won rules — do not regress

- **No `DialogSelect`.** Call `api.ui.dialog.setSize("xlarge")` **after**
  `dialog.replace(...)`; `replace` resets the size to medium.
- Use the `backgroundColor` **prop** on boxes, never `style={{backgroundColor}}`.
- No percentage heights/widths in the picker; size the list window explicitly.
- An inline `<input>` in a slot does **not** receive keyboard focus. Sidebar and
  home search are keymap-captured queries (priority-20 base layer, letters /
  space / backspace, Esc exits); click the box to activate, click elsewhere to
  leave.
- **`/sesh` is the plugin's slash**, registered with
  `slash: { name: "sesh" }` on the `api.command.register` entry — that is the
  only way to open the dialog. A markdown command under `commands/` cannot drive
  the picker (it just prompts the model), so never ship one; the installer
  removes any leftover `commands/sesh.md`.
- Do not bind `<leader>l` (native `session_list`) or shadow the native
  `/sessions` command.

## Verifying

- `npm test` — fixture-DB regression suite, hermetic via `SESH_*` overrides.
- `npm run typecheck` — `tsc` over `tui/` and `opencode/`.
- `npm run lint:sh` — `bash -n` on every script.
- `HOME=/tmp/fakehome bash install.sh` — installer smoke test.
- Keep `tui/sesh-panel.tsx` and any installed copy byte-identical when testing
  the panel locally.
