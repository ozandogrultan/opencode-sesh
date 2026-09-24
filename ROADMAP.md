# Roadmap

Productivity bets for sesh, roughly ordered by payoff. Status is tracked here
as items land.

## 1. Needs-input triage (done)

**Problem:** with 100+ sessions, the bottleneck is not finding a session but
knowing which ones are *waiting on you* (unanswered agent questions, stale
runs awaiting approval) versus done versus dead. Today that means polling rows
by hand.

**Approach:** server-independent detection straight from the opencode SQLite
store, so it works for every session, not just ones owned by the current TUI
server (whose in-memory permission/question state is invisible cross-project):

- a `question` tool part that is not `completed` with no later user message in
  the same session → awaiting an answer;
- a `tool` part stuck in `running` older than ~10 minutes → awaiting approval
  or orphaned by a dead server.

**Surfaces:** a "Needs input" section pinned above the directory groups in the
TUI sidebar, plus a terminal listing (`sesh --needs-input`).

## 2. Stale-session pruning (done)

**Problem:** the list grows without bound (127+ rows), which slows scanning
and bloats the transcript search index with archaeology.

**Approach:** `sesh prune --older-than 30d` archives (never deletes) sessions
older than the threshold: never pinned ones, never ones flagged as needing
input. Archive is reversible; `--delete` stays the explicit hard-delete path
through the existing two-step confirm. Interactive runs confirm with a
candidate summary; non-TTY runs require `--yes`; `--dry-run` lists only.

## 3. sesh ↔ cmux bridge (done)

**Approach:** kept caller-side. sesh has no window-management code (a hard
repo rule), so [`contrib/cmux/`](contrib/cmux/README.md) ships the cmux
actions, shortcuts and a `--print --json` recipe that resumes a session in its
own workspace. cmux calls sesh; sesh never calls cmux.

## 4. Per-project cost digest (done)

`sesh costs [--days N] [--json]` sums assistant-message cost per directory with
a recent window beside the lifetime total, so a day's work reads as a
per-project record. Message-level summing (not `session.cost`) keeps a
half-finished day from dragging in a session's earlier history.

## 5. Resume from anywhere (done)

Covered by the same contrib recipes: `sesh --print --json` resolves a session
non-interactively, so a cmux action, skhd binding or launcher can resume a
specific session — or open the picker — from any context.

## Smaller items (done)

- Search weighting: title matches outrank transcript-only matches and the
  current project rises while a query is active; pins still win outright.
- `sesh retitle [--dry-run] [--yes]` replaces placeholder titles
  (`New session - …`) with the start of the first user message.
