# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.1] - 2026-09-24

### Fixed

- Workspace naming no longer pushes the `ghost-hidden` sentinel that the
  opencode-ghost plugin uses for its internal sessions. The placeholder check
  was also corrected, so `New session - …` titles are skipped as intended
  rather than slipping through.
## [0.7.0] - 2026-09-24

### Added

- The sidebar renames its cmux workspace to the current session title, so the
  workspace list matches the session. Pre-first-turn placeholder titles
  (`New session - …`) are never pushed.
- `sesh cmux-sync [--dry-run] [--json]` names every cmux workspace after the
  opencode session it is running, using cmux's own per-surface resume record.

### Changed

- Click-to-focus now reads cmux's per-surface resume record (`checkpoint_id`)
  instead of heartbeat files, so it also finds background agents and panes
  running an older panel, and has no files to sweep.

## [0.6.0] - 2026-09-24

### Added

- Clicking (or Enter on) a sidebar session now switches to the live cmux
  workspace already showing it, instead of opening a duplicate in the current
  pane. Panes advertise their open session (cmux-only, one heartbeat file per
  session, ~45 s TTL); outside cmux or with no live claimant, the click opens
  the session locally as before.

## [0.5.0] - 2026-09-24

### Added

- `/sesh-costs` opens the per-project cost digest inside the TUI (24h beside
  lifetime, same message-level sums as `sesh costs`).
- `/sesh-needs` opens the sessions waiting on you as an openable list (Enter
  opens, Esc closes). Both new slashes are read-only; prune and retitle stay
  CLI-only.

## [0.4.0] - 2026-09-24

### Added

- `sesh costs [--days N] [--json]` sums assistant-message cost per project, with
  a recent window beside the lifetime total, so a day's work reads as a
  per-project record.
- `sesh retitle [--dry-run] [--yes]` replaces auto-generated placeholder titles
  (`New session - …`) with the start of the session's first user message. Only
  placeholder titles are touched.
- `contrib/cmux/` documents driving sesh from cmux: command-palette entries,
  shortcuts, resuming a session in its own workspace, and a global "resume from
  anywhere" hotkey. The glue is caller-side; sesh stays terminal-agnostic.

### Changed

- Search now weights results: a title match outranks a transcript-only match and
  the current project rises while a query is active. Pins still win outright,
  and the idle list keeps pure pin+recency ordering.
## [0.3.0] - 2026-09-24

### Added

- Needs-input triage: sessions with unanswered agent questions or runs stuck
  mid-tool pin a **Needs input** group above the sidebar directories (count in
  the heading), and `sesh --needs-input [--json]` lists the same set in the
  terminal. Detection reads the opencode store directly, so it works for every
  session, not just ones owned by the current server.
- `sesh prune [--older-than 30d] [--dry-run] [--yes] [--delete]` archives stale
  sessions so the list stays triageable. Pinned sessions, sessions waiting on
  you, fork children and already-archived sessions are never touched;
  archiving is reversible, `--delete` hard-deletes through the opencode CLI,
  and non-TTY runs need `--yes`.
## [0.2.1] - 2026-09-24

### Changed

- The TUI sidebar's Sessions section now lists every session and fills the
  available sidebar height: the fixed 15-row cap is gone, with overflow
  scrolling inside the section.

### Added

- Pin sessions with Option-S or directories with Option-D in both pickers. Pins live
  in a shared XDG data file, appear with a star, and sort ahead of recent
  sessions in the terminal picker, TUI picker, sidebar and home list.

### Fixed

- The sidebar delete confirm no longer disarms when the pointer leaves the
  armed row: the second Ctrl+X (or `y`) commits the visibly armed row wherever
  the pointer is, so deleting works while hovering the sidebar edges.

- Session previews now use Ctrl-P rather than Space in the terminal picker,
  sidebar and home list, so typing cannot accidentally open a preview.
- Hovering a sidebar session while keyboard navigation is active now moves the
  selection to that row, so Option-S/Option-D pin the row under the pointer rather
  than the previously selected (often currently open) session.
- The TUI sidebar's Sessions section now has a working show/hide control,
  separate from clicking the heading to activate keyboard navigation.
- Transcript previews pass OpenTUI's tree-sitter client to the markdown
  renderer, restoring themed Markdown and fenced-code highlighting.
- Preview Markdown now uses the active theme's semantic accents for headings,
  emphasis, code and list markers when the default Markdown colors read like
  body text.

### Changed

- Pin shortcuts are labeled Option-S/Option-D (the macOS key) in both pickers
  and the docs. The terminal picker still binds fzf's `alt-s`/`alt-d`, which is
  fzf's name for Option and unchanged.
- The TUI picker now shows transcript search matches as indexing progresses,
  identifies transcript-only hits, and distinguishes an in-progress search from
  a completed search with no results.
- Session previews identify the selected session and show loading feedback
  while it changes, instead of displaying another session's transcript.
- The TUI picker uses `Ctrl-P` for transcript preview; Space always enters a
  space in the search field, including at the start of a query.
- Sidebar and home searches direct users to the full picker for transcript
  search when no titles or directories match.
## [0.2.0] - 2026-09-21

### Added

- The picker header always names the effective scope, the session count and
  whether the index is fresh or stale (`sesh-list.sh --header`), so a `Ctrl-G`
  scope toggle or a degraded snapshot is no longer invisible.
- `sesh --print --json` emits `{"sessionId","cwd","fork"}` for scripting.
- Archived sessions are tagged `· archived` when included with `--archived`,
  replacing the agent-state colours that could never fire (opencode exposes no
  live agent state, so every row rendered grey either way).
- The TUI picker takes `Ctrl-X` (delete), `Ctrl-F` (fork) and `Ctrl-G` (scope to
  the selected session's project), so both UIs now agree on the same keys.
- The TUI sidebar is capped at the 15 most recent sessions with
  `… N more · ctrl+o for all`, and clicking the **Sessions** heading drives it
  from the keyboard (`↑`/`↓`, Enter, Space, `Ctrl-X`, Esc).
- Empty stores, queries that match nothing, vanished selections and an
  unavailable session list now say so instead of rendering a blank screen.
- Session titles highlight the part of the row the search matched, and the
  sidebar search accepts uppercase and punctuation.

### Changed

- Deleting a session asks first. The picker prompts `[y/N]` before dispatching,
  the TUI arms on the first `Ctrl-X` and commits on a second `Ctrl-X` (or `y`;
  `n`, Esc or moving cancels), and `sesh-delete.sh` refuses a non-terminal stdin
  unless given `--yes` — a piped newline can no longer authorize an irreversible
  delete.
- Resuming no longer stalls silently while the picker waits for a fresh scan: it
  prints a progress line first, and `--print` lookups skip that poll entirely.
- Selecting a directory header or a notice row explains itself with a one-shot
  notice row instead of repainting the same list as if the key had been ignored.
- Reconciled README, AGENTS.md and SECURITY.md with current behavior: the
  terminal UI is described as the full set of scripts (including the refresh
  worker and shortcut help), the extraction cache key documents the latest part
  timestamp, the PTY picker suite (`npm run test:picker`) is listed, and the
  npm distribution and supported-version policy are stated.
## [0.1.7] - 2026-09-13

### Fixed

- Sidebar and home session titles are capped to a consistent width so long
  names no longer run into the timestamp. Removed OpenTUI's `truncate` prop,
  which middle-truncated the already-shortened titles.
- The TUI picker no longer re-selects a session when the list scrolls under the
  cursor, and its preview keeps the current transcript visible while the next
  one loads instead of blanking on every cursor move.

### Changed

- Sidebar rows use muted `├`/`└` tree glyphs and directory headers get a blank
  line, so sessions are grouped clearly: a gap between directories, tight rows
  within one.
- `npm install` and upgrades refresh an already-installed TUI panel
  (`install.sh --sync-panel`), and `sesh --check` reports when the installed
  panel is out of date. Because opencode imports plugins once at startup,
  install now states that a full quit/reopen is required (a window reload reuses
  the running process).

## [0.1.6] - 2026-09-13

### Changed

- The TUI picker pages through the entire global session list instead of a
  fixed 500-session window, indexes transcript text for every session (not just
  the newest 150) in batches, bounds remote transcript fetching, and shows
  indexing progress/coverage in the search header.
- Transcript extraction reads parts in batches and assembles all records in a
  single `jq` pass. A 250-session cold index dropped from about 28 s to about
  7 s locally (warm ~0.3 s).

### Added

- TUI data-layer contract tests (pagination, full index coverage, bounded
  concurrency, progress, and the truncated cap), run on Node 24 in CI.

## [0.1.5] - 2026-09-13

### Fixed

- Transcript indexing no longer puts the whole conversation on the command line,
  so large sessions (over a megabyte of text) are indexed instead of silently
  dropped. A failed extraction now reports the snapshot as `stale` and retries
  on the next refresh rather than certifying an incomplete index as fresh.
- Transcript preview renders text parts even when newer tool parts outnumber
  them, and a long message no longer blanks the preview when the output pipe
  closes early.
- Warm extraction caches are invalidated on any part change (text or timestamp),
  not only when the session timestamp or part count moves.
- The installer refuses to replace a symlinked `sesh` launcher that is not a
  sesh install, and uninstall leaves foreign launcher symlinks untouched.

### Security

- Session ids are validated with the anchored `^ses_[A-Za-z0-9]+$` pattern at
  the preview and deletion boundaries before any SQL, and the local SQLite store
  is opened read-only.

### Added

- Regression coverage for large transcripts, part-only cache invalidation,
  preview text/tool ordering and long previews, malformed session ids, empty
  stores, and installer launcher ownership.

## [0.1.4] - 2026-09-13

### Fixed

- The picker keeps the selected session across automatic refreshes and no
  longer retargets Enter, Ctrl-F, or Ctrl-X when the selected session
  disappears (`--track`/`--id-nth` plus a non-actionable placeholder row).
- Ctrl-F now forks: fzf's `--print-query`/`--expect` output (query, key, row)
  was parsed as key, query, row, so forking resumed the original session.
- Require fzf >= 0.73 in the launcher, installer, README, and AGENTS — the
  `every()` refresh event the picker relies on was added in 0.73.
- Transcript extraction caches are written 0700/0600 regardless of the caller's
  umask, and existing caches are tightened on refresh.

### Changed

- The `sesh-list` agent tool queries the global session store, so it lists
  every project directory (roots, non-archived) instead of only the current
  project; directory filtering now happens before the limit.

### Added

- Real-fzf PTY regressions for selection tracking and fork parsing
  (`npm run test:picker`), an agent-tool contract/SQL suite, and fzf
  version-gate and cache-permission regressions.

## [0.1.3] - 2026-09-12

### Added

- npm distribution: `npm install -g opencode-sesh`, with `sesh install` /
  `sesh uninstall` wrappers and a tag-triggered publish workflow.

## [0.1.2] - 2026-09-12

### Fixed

- The home-screen recent-sessions list had no transcript preview binding, so
  pressing space while hovering a session typed into the prompt instead. It now
  opens the same preview as the sidebar.

## [0.1.1] - 2026-09-12

### Changed

- Transcript previews (terminal picker and TUI panel) now show the newest
  messages first instead of the oldest.

## [0.1.0] - 2026-09-12

### Added

- Fullscreen `fzf` terminal picker (`sesh`) listing every session across every
  project directory, grouped by directory and sorted by recency.
- Full-text search over session titles and text-only conversation parts, with a
  persistent, incrementally refreshed extraction cache.
- Transcript preview, rendered as Markdown via `glow` when available.
- Resume in place (`opencode --session <id>`) and fork (`--fork`) actions.
- Session deletion from the picker.
- `sesh-list` opencode tool so agents can list sessions across all directories.
- OpenTUI sidebar panel and `ctrl+o` / `/sesh` picker plugin, themed by the
  active opencode theme.
- `install.sh` / `--uninstall` installer that links the picker and merges the
  TUI plugin into the opencode config.
- Fixture-database regression suite, TypeScript typechecking, and ShellCheck in
  CI.

[Unreleased]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.7.1...HEAD
[0.7.1]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.1.7...v0.2.0
[0.1.7]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ozandogrultan/opencode-sesh/releases/tag/v0.1.0
