# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ozandogrultan/opencode-sesh/releases/tag/v0.1.0
