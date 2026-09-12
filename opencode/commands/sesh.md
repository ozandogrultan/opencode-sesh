---
description: Browse all opencode sessions across every project directory and resume one.
---

The user wants to pick an opencode session. List sessions with the native CLI (no external picker needed inside the TUI):

```
!opencode session list -n 50 --format json
```

Present the sessions grouped by `directory`, newest first, with title and last-updated time. Show sessions from ALL directories by default; only narrow to the current directory if the user asks (compare against $ARGUMENTS — if it names a directory or says "here", filter to it).

Then ask which session to open and how:

- **resume** (default): `opencode --session <id>` in that session's directory
- **fork**: `opencode --session <id> --fork` to continue without touching the original
- **delete**: `opencode session delete <id>` (confirm first — this is destructive)

For a rich interactive picker with transcript preview and full-text search (outside the TUI, in any terminal), point the user at the `sesh` shell command if it is installed (`sesh --check` verifies it).
