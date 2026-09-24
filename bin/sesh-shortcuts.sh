#!/usr/bin/env bash
# Shortcut help shown in the sesh preview pane.
cat <<'HELP'
sesh shortcuts

  Type              Search session titles and transcript text
  Enter             Resume the selected session here
  Ctrl-F            Resume the selected session as a fork
  Ctrl-G            Toggle current-directory scope / all sessions
  Ctrl-P            Toggle transcript preview
  Option-S          Pin / unpin selected session
  Option-D          Pin / unpin selected directory
  ?                 Toggle this help
  Ctrl-X            Delete the selected session (asks to confirm)
  Escape            Exit the picker

Flags: --cwd (current directory only), --limit N (default: all),
       --archived (include archived), --print (print id instead of resuming),
       --json (with --print, emit JSON)
HELP
