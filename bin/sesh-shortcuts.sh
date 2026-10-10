#!/usr/bin/env bash
# Shortcut help shown in the sesh preview pane.
cat <<'HELP'
sesh shortcuts

  Type              Search session titles and transcript text
  Enter             Resume the selected session here
  Ctrl-F            Resume the selected session as a fork
  Ctrl-G            Toggle current-directory scope / all sessions
  Ctrl-P            Toggle transcript preview
  Ctrl-S            Pin / unpin selected session
  Ctrl-D            Pin / unpin selected directory
  ?                 Toggle this help
  Ctrl-X            Delete the selected session (asks to confirm)
  Escape            Exit the picker

Flags: --cwd (current directory only), --limit N (default: all),
       --archived (include archived and child sessions),
       --print (print selected id<TAB>cwd instead of resuming),
       --json (with --print, emit JSON), --fork (resume as a fork),
       --query TEXT (initial search), --check (check dependencies),
       --needs-input [--json] (list sessions waiting on you)

--print still opens the picker; select a session with Enter or Ctrl-F.
HELP
