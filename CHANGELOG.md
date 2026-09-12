# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-09-12

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

[Unreleased]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ozandogrultan/opencode-sesh/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ozandogrultan/opencode-sesh/releases/tag/v0.1.0
