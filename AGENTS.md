# AGENTS.md — sesh

Instructions for AI coding agents working in this repository. The map, not the
territory: read this first, then the specific file you need.

## What this is

`sesh` is an opencode-native session browser in three parts:

1. **`bin/`** — a fullscreen [fzf](https://github.com/junegunn/fzf) picker for
   any terminal. Lists **all** sessions across **all** project directories,
   full-text searchable, with transcript preview and resume/fork/delete.
2. **`tui-plugins/sesh-panel/tui.tsx`** — a SolidJS/OpenTUI plugin for the opencode TUI: a
   sessions section in the sidebar and on the home screen, plus an `option+o` / `/sesh` picker.
3. **`plugins/sesh-list.ts`** — the `sesh_list` custom tool, so the agent
   can list sessions across every directory by querying the global opencode
   SQLite store (the native `opencode session list` is project-scoped).

No iTerm2, no AppleScript, no panes, no window management — **never add any.**
The one exception is the TUI's right-click workspace action, which shells out to
`cmux new-workspace` when running inside cmux.
opencode has no persistent-sidebar API, so the TUI uses `sidebar_content` and
`home_bottom` slot sections plus an xlarge modal picker; the terminal UI is fullscreen fzf.

## Start here

```bash
bun install            # dev deps (TypeScript, opencode/OpenTUI types)
bun run build          # compile the panel to dist/tui.js
bun run test           # build + fixture-DB regression suite — must stay green
bun run test:changelog # release-tooling regressions (scripts/changelog.sh)
bun run test:picker    # PTY picker suite
bun run test:tui-home  # real OpenTUI home layout regressions (also in bun run test)
bun run test:tui-dialogs # picker / needs / costs / sidebar rendered through tui() (also in bun run test)
bun run test:tui-worker # real blob Worker + bun:sqlite regressions (also in bun run test)
bun run typecheck      # tsc over tui-plugins/ and plugins/
bun run lint:sh        # bash -n on every script
HOME=/tmp/fakehome bash install.sh   # installer smoke test (never touches ~/.config)
```

## Layout

- `bin/` — flat; no subdirs. Scripts resolve siblings from their own location.
  Never hardcode install paths. `sesh-waiting.sh` owns the needs-input query
  (shared heuristic with the TUI sidebar copy, marked `NEEDS_INPUT_SQL` in
  both); `sesh-pins.sh` manages persistent session/directory pins;
  `sesh-prune.sh` deletes stale sessions; `sesh-costs.sh` sums
  assistant-message cost per directory. Reads go through `sqlite3 -readonly`
  (required; `opencode db` no longer exists). Sesh never writes the database
  directly; deletes go through `opencode session delete`.
- `contrib/` — caller-side integrations (currently cmux). Nothing here may add
  window management to sesh itself.
- `tui-plugins/sesh-panel/tui.tsx` — SolidJS panel, `/** @jsxImportSource @opentui/solid */`.
- `plugins/sesh-list.ts` — the agent-facing `sesh_list` tool.
- `scripts/build-tui.mjs` — compiles the panel with Babel + `babel-preset-solid`
  (`moduleName: "@opentui/solid"`, universal) to `dist/tui.js` (gitignored).
  `package.json` exports `./tui` from `dist/tui.js`; `bun run build`, `bun run
  test`, `prepack` and CI all run it. OpenCode applies its Solid transform only
  to sources outside `node_modules`, so shipping raw `tui.tsx` in the npm package
  renders a non-reactive (empty) panel — never export the `.tsx` source.
- `scripts/changelog.sh` — release tooling: drafts conventional commits,
  writes a dated version, prints release notes and
  checks the compare links. `tests/changelog.sh` covers it in a throwaway repo.
- `assets/` — README logo (`logo.svg`) and square mark (`icon.svg`); wordmark is outlined paths, no font dependency.
- `themes/`, `tests/`, `install.sh`, `README.md`.

The tool name in opencode is `sesh_list`. Do not rename it without updating the docs.

## Data flow (fzf picker)

`bin/sesh-list.sh` owns the fzf picker's session store access (opencode SQLite
DB: `session_v2` / `session_message` tables); the `sesh_list` agent tool queries
the same store read-only through `bun:sqlite`. OpenCode discovers the tool from the
global config directory's `plugins/`. Keep its SQL column names in sync with
the schema below. Keystrokes never touch the database:

- `--refresh` (expensive): bulk-reads session metadata and per-session text
  parts, validates the persistent extraction cache
  (`$SESH_CACHE_DIR/extractions/<ses_*.json>`) against `time_updated`,
  message count and the latest message timestamp, re-extracts only changed sessions,
  prunes vanished ones, and atomically publishes `STATE_DIR/snapshot.jsonl`.
  Extraction reads user `data.text` and assistant `data.content` text entries,
  ordered by message `seq`, through files, never argv (no ARG_MAX limit); if
  any session fails, the published status is `stale` and that session stays
  uncached so the next refresh retries, otherwise `status = fresh`. Scope
  (`--cwd`/toggle) and `--limit` apply at assembly, so metadata always covers
  the whole DB and pruning is always safe.
- render (cheap, pure `jq`): reads the snapshot only. Filters on `searchText`
  (title + `fulltextLower`, both lowercased at extraction), groups by `cwd`,
  sorts groups/items by pins and recency, with current-project and title-match
  priority while searching, and renders the TSV. Notice rows (headers, a
  vanished selection, an empty store, a query matching nothing) carry an empty
  `sessionId` and a unique `trackingId`. `--header` prints the one-line
  scope/count/status that the picker uses as fzf's header, and a non-actionable
  selection leaves a one-shot `STATE_DIR/action-notice` the next render shows
  and consumes. Snapshot records carry `archived` as 0/1 (the DB column is an
  epoch, not a boolean).
- Session and directory pins live in `${XDG_DATA_HOME:-$HOME/.local/share}/sesh/pins.json`
  (`SESH_PINS_FILE` overrides it for tests), shared by fzf and the TUI. Writes
  use a sibling lock directory and atomic rename. Ctrl-S toggles a selected
  session; Ctrl-D toggles its directory (terminal picker and option+o picker).
  The option+o picker also pins with Option-S / Option-R (its pinned filter is
  Option-K). The sidebar and home lists use only Option-S / Option-R: opencode
  binds `ctrl+d` itself (composer delete-char, session delete), so ctrl pins
  would shadow the composer. Pinned directories sort before groups
  containing pinned sessions. The terminal picker puts pinned sessions first
  inside each group; the TUI picker ranks pinned sessions first before filtering
  and keeps sessions within each directory ordered by recency; the sidebar keeps
  sessions within each directory ordered by recency; the home list puts pinned
  sessions first.

**Output contract** (TSV, 6 fields):
`agentId  sessionId  liveState  display  cwd  trackingId`. `display` is the only
rendered column; `trackingId` is fzf's `--id-nth`. Headers/notices carry an
empty `sessionId` and are a selection no-op — keep that guard.

One worker (`sesh-refresh-worker.sh`, per picker, TERMed on exit) serializes
scans; fzf's `start`/`every(...)`/`change` bindings render only. Selection requests
a fresh poll (`request`/`wait`) before dispatch — skipped for `--print`,
which is a pure snapshot lookup — and prints a progress line to stderr while it
waits, because fzf has already exited and the terminal is idle. opencode has no
live-agent API, so `liveState` is always `unknown` and rows render gray unless
they are archived (opt-in, tagged `· archived`);
dispatch is always `opencode --session <id>`; Ctrl-F or `--fork` first creates the
fork with `opencode api session.fork` (the CLI has no fork flag) and resumes the new id.
Resume runs opencode in a subshell at the session's cwd in the same terminal;
when opencode exits, the picker reopens with the query preserved.

## Conventions

- Default scope is **all** sessions, every directory. `--cwd`/Ctrl-G narrows.
  Archived sessions and child sessions (spawned subagents) are
  hidden unless `--archived`; metadata and cache pruning still see them.
- **Text parts only** in search/preview; reasoning and tool payloads are
  excluded (asserted in tests).
- Validate session ids (`^ses_[A-Za-z0-9]+$`) before SQL interpolation — never
  interpolate unvalidated input. Open SQLite read-only (`sqlite3 -readonly`).
- Resolve the database as `SESH_DB`, then `$XDG_DATA_HOME/opencode/opencode.db`, then the
  `db` line of `opencode debug paths`. Never parse
  `sqlite3 -json` in `-R` mode; it pretty-prints — parse as JSON.
- `jq -R` output stays JSON-quoted: use `-Rr` when a shell variable needs the
  raw string.
- fzf: stock only (`transform:`, `every():`). `{q}` in binds is
  shell-quoted by fzf — don't add quoting. Ctrl-G is bind-only (stays open);
  Ctrl-F is `--expect` (accepts with fork). A `transform-header` inside a chained
  action must come **before** `reload`/`reload-sync`: placed after, fzf silently
  publishes an empty list.
- Destructive actions confirm. `sesh-delete.sh` prompts on a TTY and refuses
  without `--yes` when stdin is not one; the TUI arms on the first Option-D and
  commits on the second, `y`, or Enter.
- The installer prefers the local opencode version for `@opencode/*` and
  merges (never clobbers) the config `package.json`; opencode runs `bun install`
  at startup.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat`, `fix`, `docs`, `ci`, …). See
  [CONTRIBUTING.md](CONTRIBUTING.md#commit-messages) for the types and the
  version mapping.
- `CHANGELOG.md` follows Keep a Changelog and contains released versions only.
  The Release workflow drafts notable Conventional Commits since the last tag
  and writes the new dated version and compare link. The released section is
  used as the GitHub release body.

## TUI panel (`tui-plugins/sesh-panel/tui.tsx`)

- **Sidebar & Home list:** `api.slots.register` on `sidebar_content` (`sidebar.content`
  append mode by default — native sidebar content stays above Sessions;
  `sidebarPlacement: "prepend"` puts Sessions first) and `home_bottom` (`prompt.footer`
  append mode, absolutely positioned on the row right below the composer). `showSidebar: false` / `showHome: false` skip registering each
  slot; with both off (picker-only) nothing polls. In the sidebar, pinned
  directories sort first, then directory groups by recency; sessions within
  each group sort by last update regardless of pins.
  In the home list, pinned sessions sort first.
  The home list takes no layout space: it budgets its height from its own
  measured position (`renderAfter`) down to the native status footer, so it
  tracks a growing composer. Rows are always single-spaced (filtering never reflows them); it drops the top padding first, then rows, hidden when
  too short, and only on the `home` route (the session prompt shares the slot). Header/rows never wrap, and resizing releases captures for hidden rows.
  The header is `Recent sessions (option+o all)` with a right-aligned clickable `search…` box
  (ends at the age column); on narrow lists `(option+o all)` is dropped first, then the title
  truncates — the search box is always shown.
  `tests/tui-home.mjs` renders this against the native home layout with multiline
  and wrapped prompts; keep that regression in the default test suite.
  Home rows are fixed columns (marker: sidebar spinner running / ○ idle, title, last directory segment capped
  at 22 — distinct visible directories sharing one also show their parent (`homeDirLabels`) —, right-aligned age that is never dropped); the directory shrinks first,
  and the list spans the composer's width, flush with its left edge.
  Row markers alone signal session state: a running agent animates a loading
  spinner marker (`createRunningState`: the host's live status decides a
  session this process ran until the polled DB set agrees it is idle; every
  other session uses that set — `queryRunningIds`, root sessions in flight with
  activity within `STUCK_AFTER_MS`, run on every poll for both lists because it
  touches only in-flight sessions), the open session shows its own ●, and every other idle row
  stays neutral (polled periodically); Option-P previews
  a row and option+d deletes one (armed, then confirmed). Right-clicking a
  sidebar, home or picker row opens one shared action context menu
  (`createContextMenu` + `ContextMenuOverlay`: open, preview, cmux workspace
  only when `inCmux()` — `CMUX_WORKSPACE_ID` — fork, pin/unpin, delete). The
  picker's menu registers its key layer in `modal` mode, stays inside the list
  area (`createMenuView` bounds; borderless when squeezed, and windowed by
  `contextMenuWindow` so the selected item is always visible when the items
  outnumber the rows, with ▲/▼ hints on its edge rows; closed on resize) and
  hides the footer while open; the overlay portals to the renderer root at
  `CONTEXT_MENU_Z_INDEX` (3500), above OpenCode's dialog layer (3000) — a lower
  value renders the picker's menu behind the dialog; Esc closes the menu before the picker and Enter in the
  search input must not submit while it is open. The sidebar section lists every
  session without a row cap and flex-grows to fill the sidebar, with overflow
  scrolling inside; the picker remains the place for transcript search.
  Sessions waiting on the user (unanswered questions, stuck runs) pin a
  **Needs input** group above the directories, with the count in the heading —
  same `NEEDS_INPUT_SQL` heuristic as `bin/sesh-waiting.sh`. Message payloads are
  scanned only for in-flight root sessions (`time_suspended` set, `time_busy` newer
  than `time_idle`); databases lacking those columns (checked via
  `pragma_table_info`) fall back to the full scan. The query runs in
  a blob Worker (`createDbClient`; failure means "local store unavailable"),
  off the TUI thread but still costing worker CPU every poll, so the shared
  poll runs it only while the sidebar is subscribed
  (`poll(listener, { waiting: true })`); the home list never triggers it.
- **Picker chrome:** `chromeRows()` is reactive: the status line ("indexing
  transcripts i/n", "k of n transcripts indexed" on partial coverage, "showing
  newest N" when truncated, active scope/filters) takes a row only while it has
  text. Below `PICKER_TALL` (28) rows the footer is one line and directory
  headings lose their blank line (`groupLines`); below 20 rows the decorative
  gaps collapse too, and the dialog takes 85% of the terminal.
- **Picker:** a custom dialog (not `DialogSelect`) grouped by
  project/directory, recency-ordered, resume via
  `api.route.navigate("session", …)`. `option+o` and the command palette open it;
  Option-D arms and then confirms a delete through `api.client.session.delete` and
  removes the row only after the server confirms; Ctrl-F forks through
  `api.client.session.fork`; Ctrl-G scopes the list to the selected session's
  project.
- **Picker search:** pages the global session list (`SESSION_PAGE_LIMIT`, capped
  at `SESSION_MAX` and reported when truncated) rather than a fixed-size
  window, then indexes transcript text for **every** session in batches
  (`TRANSCRIPT_BATCH`, also capped by `TRANSCRIPT_BATCH_BYTES` of message
  payload; a single larger session forms its own batch) with bounded remote
  concurrency (`REMOTE_CONCURRENCY`). Transcript text is cached in memory for
  the plugin lifetime (never on disk, cleared on dispose); a worker signature
  query (session timestamp, message count, latest message timestamp, payload
  size; chunked by `SIGNATURE_CHUNK`) lets reopened pickers reuse unchanged
  sessions, extract only new or changed ones, and prune vanished ones. Sessions
  indexed through the remote path are not cached. If the signature query fails
  (`octet_length` needs SQLite ≥ 3.43; macOS Bun uses the system SQLite),
  extraction still runs locally, batched by count only, and caches nothing.
  Local extraction is one SQL statement per batch in the DB worker
  (`transcriptTextQuery`, JSON-guarded) that returns only `{sid, text}` rows,
  so tool payloads never reach the UI thread; if the worker rejects, sessions
  not yet indexed fall back to the remote path. The header shows indexing progress/coverage. Visible transcript hits get
  short excerpts from the text-only index (never tool or reasoning payloads).
  Project, needs-input (Option-W), and pinned-session (Option-K) filters compose
  with the query; the picker remembers query/scope/filters until plugin restart.
  `/sesh-needs` uses the shared needs-input set plus the oldest unresolved
  question or running-tool timestamp, lists longest-waiting first, and `n`
  opens the next waiting session. `tests/tui.mjs` locks the data layer.
- **Durable install:** OpenCode reloads plugins on watched configuration changes;
  unwatched dependencies may need a restart. If a panel update does not appear,
  fully quit/reopen opencode. `install.sh --sync-panel`
  (run by the `postinstall`) refreshes an already-installed panel and is a
  no-op when absent, and `sesh --check` reports when the installed copy differs
  from the bundled one.

Failure toasts (delete, fork, pins, session load, needs-input and cost data)
go through `withReason(message, error)`, which appends the error's message
when it has one (preferring `.message` / `.data.message`) and keeps the plain
text otherwise; markup-looking strings (proxy error pages) are ignored.

Dialog layouts derive from `trackSize(api)` (renderer dimensions as a signal,
released when the dialog closes): the picker's chrome, `/sesh-costs` columns
and `/sesh-needs` columns re-flow on resize instead of keeping values captured
when the dialog opened. A fork that finishes after the picker closed must not
clear a dialog (`forkEntry` checks `alive`).

### Hard-won rules — do not regress

- **Re-check the dialog z-index when bumping OpenCode.** `CONTEXT_MENU_Z_INDEX`
  (3500) must stay above the dialog layer, `zIndex={3000}` in OpenCode's
  `packages/tui/src/ui/dialog.tsx` (verified at v2.2.6, line 66). If the value
  changes, update the constant and `DialogHost` in `tests/dialog-harness.mjs`
  and the "OpenCode vX.Y.Z" notes next to them; `tests/tui.mjs` fails when the
  pinned `@opencode/*` version is newer than the one recorded there.
- **No `DialogSelect`.** Call `api.ui.dialog.setSize("xlarge")` **after**
  `dialog.replace(...)`; `replace` resets the size to medium.
- Use the `backgroundColor` **prop** on boxes, never `style={{backgroundColor}}`.
- No percentage heights/widths in the picker; size the list window explicitly.
  The dialog height is clamped to the terminal; the header block never shrinks
  (`flexShrink={0}`) and the footer hint is a fixed number of non-wrapping
  lines (`pickerHintLines`, compact form on narrow widths), so the chrome
  budget (`chromeRows`) is exact and the list absorbs any shortfall.
  Below 20 rows, decorative gaps collapse before functional chrome. Preview
  metadata and its back hint never shrink or wrap. `/sesh-costs` shows the
  project first, then right-aligned money columns under a heading row (`24h`
  and `Total` spend from assistant-message cost; `Sess` is the number of
  sessions with recorded cost) and an "All projects" total line (always an amount, `$0.00` for no spend;
  project rows show "—"). The heading
  and total stay put while the project rows scroll (↑↓, Ctrl-P/N, PgUp/PgDn,
  Home/End); `Sess`, then `24h`, drop when the project name would starve, and
  `fitDir` shortens leading directory segments first, cutting the last segment
  only when it alone is wider than the column; `/sesh-needs` uses fixed
  columns that truncate with an ellipsis (title, reason, then directory · wait
  time, where the wait time stays whole and "waiting (start unknown)" covers a
  missing start), drops the directory metadata and shortens reasons and the
  heading below 80 columns, and scrolls keyboard selection into view.
- The picker windows by visible terminal lines: directory headings take two
  lines (one on terminals under 28 rows), transcript excerpts can take a second line, and a sticky directory
  heading keeps a scrolled group identifiable. Wheel scroll follows every
  OpenTUI delta and changes only the viewport; real mouse movement changes
  selection without recentering it.
  Option-P previews in a full-size overlay over the picker; Esc first closes the
  preview, then the picker on the next press.
- An inline `<input>` in a slot does **not** receive keyboard focus. Sidebar and
  home search are keymap-captured queries (priority-20 base layer, letters /
  space / backspace, Esc exits); click the box to activate, click elsewhere to
  leave.
- **`/sesh` is the plugin's slash**, registered with
  `slash: { name: "sesh" }` on the `api.command.register` entry — that is the
  only way to open the dialog. A markdown command under `commands/` cannot drive
  the picker (it just prompts the model), so never ship one; the installer
  removes any leftover `commands/sesh.md`. The command API never passes slash
  arguments, so subcommands are separate registrations (`/sesh-costs`,
  `/sesh-needs`) — all read-only. Destructive actions stay CLI-only.
- Do not bind `<leader>l` (native `session_list`) or shadow the native
  `/sessions` command.
- **The sidebar never binds arrow keys globally.** Keyboard navigation is
  opt-in: clicking the *Sessions* heading (or its search box) activates a
  priority-20 layer, because a global `↑`/`↓` would hijack the main prompt.
  Clicking outside the sidebar, opening a session, or navigating releases it
  again (with search, hover and any armed delete), so the sidebar cannot
  shadow the composer afterwards. Sidebar-internal clicks stop propagation so
  the outside-click release cannot undo them.
  Cursor state is derived from `itemRows()`, so hover and cursor resolve to the
  same row. The section lists every session with no row cap
  (`tests/tui.mjs` asserts the cap stays out); overflow scrolls inside the
  stretched section.
  Its heading never wraps. Sidebar/picker titles and picker excerpts use
  `Highlighted` with `fit` to reserve a blank cell and show an ellipsis at
  their measured width rather than hard-clipping against the age column.
- **Hover shortcuts yield to typing.** Sidebar and home rows bind Option-P/D/S/R
  only while hovered; `/` is never a hover shortcut (click the search box to
  search sessions). Any keypress no keymap layer
  consumed (composer typing) drops the hover (`releaseHoverOnTyping`), and
  pointer movement over a row restores it. A resting pointer must never shadow
  composer keys such as Option-D (delete word).
- **Delete in the TUI is two-step.** The first `option+d` arms `pendingDelete`,
  the second (or `y`, or Enter) commits the armed row
  wherever the pointer or cursor is, and `n`/Esc (or a timeout)
  cancels. Moving the pointer must never disarm: edge-hover flicker ate the
  confirm before `confirmArmed` landed. The `y`/`n` layer is registered *only
  while armed*, so it can never shadow the search box's typing.
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
  and Python 3).
- `bun run test:tui-home` — real OpenTUI render regressions for the home list
  (also run by `bun run test`).
- `bun run test:tui-dialogs` — drives the real `tui()` with a mock host API
  (`tests/dialog-harness.mjs`) and asserts frames of the picker and the slash
  dialogs at small terminal sizes (also run by `bun run test`).
- `bun run test:tui-worker` — starts the real blob Worker against a bun:sqlite
  fixture; asserts results round-trip and the main thread keeps ticking during
  a slow query and during transcript indexing of large tool payloads (also run
  by `bun run test`).
- `bun run typecheck` — `tsc` over `tui-plugins/` and `plugins/`.
- `bun run lint:sh` — `bash -n` on every script.
- `HOME=/tmp/fakehome bash install.sh` — installer smoke test.
- Keep `tui-plugins/sesh-panel/tui.tsx` and any installed copy byte-identical when testing
  the panel locally.
- The npm install path needs the plugin in both `opencode.json` (server tool) and
  `cli.json` (TUI panel); `plugin.list` shows only server plugins, so verify the
  panel by launching the TUI against a fixture or the real store.
