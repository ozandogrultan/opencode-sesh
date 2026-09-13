#!/usr/bin/env bash
# Shortcut help shown in the sesh preview pane.
cat <<'HELP'
sesh shortcuts

  Type              Search session titles and transcript text
  Enter             Resume the selected session here
  Ctrl-F            Resume the selected session as a fork
  Ctrl-G            Toggle current-directory scope / all sessions
  Space             Toggle transcript preview
  ?                 Toggle this help
  Ctrl-X            Delete the selected session
  Escape            Exit the picker

Flags: --cwd (current directory only), --limit N (default: all),
       --archived (include archived), --print (print id instead of resuming)
HELP
