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

## 3. sesh ↔ cmux bridge (planned)

The cmux workspace layout (grouped by directory) and the session list (grouped
by directory) describe the same projects but don't know about each other.
A picker action to resume a session in a fresh cmux workspace
(`opencode --session <id>` in the session's cwd) closes the loop in both
directions.

## 4. Per-project cost digest (planned)

The statusline already tracks session and daily cost. Broken down by directory
with a "what moved today" summary, it becomes an end-of-day handover and a
per-project effort record.

## 5. Resume from anywhere (planned)

`sesh --print --json` already script-resolves a session id. Wiring it to a
global hotkey or a cmux command-palette entry (fuzzy-pick a session without
opening the picker first) removes the last context switch on the resume path.

## Smaller items (unplanned)

- Recency + pin + cwd-weighted ranking for transcript search hits.
- Auto-retitling of untitled sessions (`New session - …`) so rows scan faster.
