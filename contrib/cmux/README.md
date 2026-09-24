# sesh ↔ cmux

Optional glue for running sesh inside [cmux](https://cmux.dev). Nothing here is
bundled into the picker: sesh has no window-management code, and these recipes
keep it that way. cmux calls sesh; sesh never calls cmux.

## Command palette + shortcuts

Merge [`cmux.json.snippet`](cmux.json.snippet) into `~/.config/cmux/cmux.json`
(or `.cmux/cmux.json` in a project), then `cmux reload-config` (Cmd+Shift+,).
You get:

| Action | Shortcut | What it does |
| --- | --- | --- |
| `sesh.picker` | Cmd+Shift+S | Open the picker in a new tab |
| `sesh.needs` | Cmd+Shift+I | List sessions waiting on you |
| `sesh.costs` | — | Per-project spend digest |

Paste only the actions you want; the `ui.newWorkspace` block is optional.

## Resume a session in its own cmux workspace

The picker resumes in place (it `cd`s and `exec`s opencode). To instead open a
session in a **new cmux workspace** at its directory, shell out to cmux after
resolving the session with sesh's scriptable lookup:

```bash
sesh --print --json --query "auth refactor" \
  | jq -r '[.sessionId, .cwd] | @tsv' \
  | while IFS=$'\t' read -r id cwd; do
      cmux new-workspace --cwd "$cwd" --command "opencode --session $id"
    done
```

Wrap that in a cmux `command` action (as above) or a shell function; it is
caller-side on purpose, so sesh stays terminal-agnostic.

## Keep workspace names in step

The sidebar renames its workspace to the opencode session title as you work, and
`sesh cmux-sync` does it for every workspace at once:

```bash
sesh cmux-sync --dry-run   # preview
sesh cmux-sync             # rename to match
```

It reads cmux's own per-surface resume record, so it also names workspaces whose
agent was started outside the sidebar.

## Needs-input triage from cmux

`sesh --needs-input` prints (or `--json` emits) the sessions with unanswered
agent questions or runs stuck mid-tool. Bind it to a shortcut and it becomes
the "what is blocked on me right now" view without opening the picker.

## Global hotkey (resume from anywhere)

sesh is a normal CLI, so any system-wide launcher works — a cmux `shortcut`, an
`skhd` binding, a Raycast/Hammerspoon script:

```bash
# skhd example: Cmd+Shift+S opens the picker in a new cmux workspace
cmd + shift - s : cmux new-workspace --command "sesh"
```

Because `--print --json` resolves a session non-interactively, the same hook can
resume a specific session without any UI:

```bash
cmd + alt - r : cmux new-workspace --command "opencode --session $(sesh --print --json --limit 1 | jq -r .sessionId)"
```
