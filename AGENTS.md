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
bun install            # dev deps (TypeScript, opencode/OpenTUI types)
bun run test           # fixture-DB regression suite — must stay green
bun run test:changelog # release-tooling regressions (scripts/changelog.sh)
bun run test:picker    # PTY picker suite (needs fzf >= 0.73)
bun run typecheck      # tsc over tui/ and opencode/
bun run lint:sh        # bash -n on every script
HOME=/tmp/fakehome bash install.sh   # installer smoke test (never touches ~/.config)
```

## Layout

- `bin/` — flat; no subdirs. Scripts resolve siblings from their own location.
  Never hardcode install paths.
- `tui/sesh-panel.tsx` — SolidJS panel, `/** @jsxImportSource @opentui/solid */`.
- `opencode/tools/sesh-list.ts` — the agent-facing `sesh-list` tool.
- `scripts/changelog.sh` — release tooling: drafts `[Unreleased]` from
  conventional commits, promotes it to a dated version, prints release notes and
  checks the compare links. `tests/changelog.sh` covers it in a throwaway repo.
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
  sorts groups/items by recency, renders the TSV. Notice rows (headers, a
  vanished selection, an empty store, a query matching nothing) carry an empty
  `sessionId` and a unique `trackingId`. `--header` prints the one-line
  scope/count/status that the picker uses as fzf's header, and a non-actionable
  selection leaves a one-shot `STATE_DIR/action-notice` the next render shows
  and consumes. Snapshot records carry `archived` as 0/1 (the DB column is an
  epoch, not a boolean).
- Session and directory pins live in `${XDG_DATA_HOME:-$HOME/.local/share}/sesh/pins.json`
  (`SESH_PINS_FILE` overrides it for tests), shared by fzf and the TUI. Writes
  use a sibling lock directory and atomic rename. Alt-S toggles a selected
  session; Alt-D toggles its directory. Pinned directories sort before groups
  containing pinned sessions, with pinned sessions first inside each group.

**Output contract** (TSV, 6 fields):
`agentId  sessionId  liveState  display  cwd  trackingId`. `display` is the only
rendered column; `trackingId` is fzf's `--id-nth`. Headers/notices carry an
empty `sessionId` and are a selection no-op — keep that guard.

One worker (`sesh-refresh-worker.sh`, per picker, TERMed on exit) serializes
scans; fzf's `start`/`every(3)`/`change` bindings render only. Selection requests
a fresh poll (`request`/`wait`, ≤12 s) before dispatch — skipped for `--print`,
which is a pure snapshot lookup — and prints a progress line to stderr while it
waits, because fzf has already exited and the terminal is idle. opencode has no
live-agent API, so `liveState` is always `unknown` and rows render gray unless
they are archived (opt-in, tagged `· archived`);
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
  Ctrl-F is `--expect` (accepts with fork). A `transform-header` inside a chained
  action must come **before** `reload`/`reload-sync`: placed after, fzf silently
  publishes an empty list (verified on 0.74.3).
- Destructive actions confirm. `sesh-delete.sh` prompts on a TTY and refuses
  without `--yes` when stdin is not one; the TUI arms on the first Ctrl-X and
  commits on the second (or `y`).
- The installer prefers the local opencode version for `@opencode-ai/*` and
  merges (never clobbers) the config `package.json`; opencode runs `bun install`
  at startup.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat`, `fix`, `docs`, `ci`, …). See
  [CONTRIBUTING.md](CONTRIBUTING.md#commit-messages) for the types and the
  version mapping.
- `CHANGELOG.md` follows Keep a Changelog: notable changes are written under
  `[Unreleased]` as the work lands, and the Release workflow promotes that
  section (dated, relinked) into the published version, using it verbatim as the
  GitHub release body. `scripts/changelog.sh draft` can seed entries from
  conventional commits, but hand-written prose is the expected form — never let
  a draft overwrite curated entries.

## TUI panel (`tui/sesh-panel.tsx`)

- **Sidebar:** `api.slots.register` on `sidebar_content` (append mode — native
  sidebar content stays). Renders pinned sessions before the newest
  `SIDEBAR_LIMIT` unarchived sessions
  with the current one highlighted, polled every 15 s; Ctrl-P previews a row and
  ctrl+x deletes one (armed, then confirmed). Anything bulkier belongs to the
  picker.
- **Picker:** a custom dialog (not `DialogSelect`) grouped by
  project/directory, recency-ordered, resume via
  `api.route.navigate("session", …)`. `ctrl+o` and the command palette open it;
  Ctrl-X arms and then confirms a delete through `api.client.session.delete` and
  removes the row only after the server confirms; Ctrl-F forks through
  `api.client.session.fork`; Ctrl-G scopes the list to the selected session's
  project.
- **Picker search:** pages the global session list (`SESSION_PAGE_LIMIT`, capped
  at `SESSION_MAX` and reported when truncated) instead of a fixed 500-row
  window, then indexes transcript text for **every** session in batches
  (`TRANSCRIPT_BATCH`) with bounded remote concurrency (`REMOTE_CONCURRENCY`).
  The header shows indexing progress/coverage. `tests/tui.mjs` locks this.
- **Durable install:** opencode imports plugins once at startup and never hot
  reloads, so panel changes need a full quit/reopen. `install.sh --sync-panel`
  (run by the `postinstall`) refreshes an already-installed panel and is a
  no-op when absent, and `sesh --check` reports when the installed copy differs
  from the bundled one.

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
- **The sidebar never binds arrow keys globally.** Keyboard navigation is
  opt-in: clicking the *Sessions* heading (or its search box) activates a
  priority-20 layer, because a global `↑`/`↓` would hijack the main prompt.
  Cursor state is derived from `itemRows()`, so hover and cursor resolve to the
  same row, and the section is capped at `SIDEBAR_LIMIT` (`… N more · ctrl+o for
  all` is the escape hatch) — it must stay a glanceable recent list.
- **Delete in the TUI is two-step.** The first `ctrl+x` arms `pendingDelete`,
  the second (or `y`, or Enter in the picker footer) commits, and `n`/Esc/moving
  cancels. The `y`/`n` layer is registered *only while armed*, so it can never
  shadow the search box's typing.
- **Picker `ctrl+g` is project scope**, not close (parity with the fzf picker's
  `Ctrl-G`); Esc is the only close key. `ctrl+f` forks through
  `api.client.session.fork` and navigates to the returned session.
- Row titles render through `<Highlighted>`, and JSX must stay out of the
  `function shortDir` … `const TRANSCRIPT_PREVIEW_TURNS` window that
  `tests/tui.mjs` extracts and evaluates as the data layer.

## Verifying

- `bun run test` — fixture-DB regression suite, hermetic via `SESH_*` overrides.
- `bun run test:changelog` — release-tooling regressions; builds its own git
  history in a temp dir (included in `bun run test`).
- `bun run test:picker` — PTY suite driving the real fzf picker (needs fzf
  `>= 0.73` and Python 3).
- `bun run typecheck` — `tsc` over `tui/` and `opencode/`.
- `bun run lint:sh` — `bash -n` on every script.
- `HOME=/tmp/fakehome bash install.sh` — installer smoke test.
- Keep `tui/sesh-panel.tsx` and any installed copy byte-identical when testing
  the panel locally.
