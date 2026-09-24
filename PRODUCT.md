# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

This is the schema's non-native category; sesh runs in a terminal and inside opencode's OpenTUI interface, not in a browser.

## Users

Individual opencode users working across multiple project directories who need to find an earlier conversation and continue it.

## Product Purpose

sesh lets users locate sessions across all their opencode projects, inspect a transcript, and resume or fork a selected session. Success means finding the right session without remembering which project directory it belongs to and continuing work in the intended context.

## Positioning

Unlike opencode's project-scoped native session lists, sesh browses and searches sessions across every project directory from both a standalone terminal picker and an in-TUI picker.

## Operating Context

Users work in terminals and the opencode TUI. The standalone picker uses fullscreen fzf and resumes a session in its own working directory; the TUI adds a recent-sessions sidebar section and a full picker. Session metadata and text transcript parts come from opencode's session store.

## Capabilities and Constraints

- Group sessions by project directory, search titles and conversation text, preview transcripts, and resume, fork, or confirm deletion of a session.
- Default to sessions across all directories; allow narrowing to a project or directory. Archived sessions and fork children are hidden by default.
- Index text parts only, excluding reasoning and tool payloads from search and previews.
- Preserve the terminal and OpenTUI workflows, including in-place terminal resume, existing opencode navigation, and confirmation for destructive actions.
- No iTerm2, AppleScript, panes, or window management. The opencode sidebar is an appended section, not a replacement for native sidebar content.

## Brand Commitments

The product is named `sesh` and described as a session browser for opencode. The README and CLI/TUI labels are the existing source of product terminology; no additional brand direction was established during init.

## Evidence on Hand

- `README.md` documents the user workflows, keyboard shortcuts, requirements, installation, and a text example of the picker.
- `AGENTS.md` records behavior contracts and technical constraints for the terminal picker and TUI panel.
- `tui/sesh-panel.tsx`, `bin/`, and `opencode/tools/sesh-list.ts` are the implemented product surfaces.

## Product Principles

- Make sessions from every project discoverable from the user's current context.
- Keep search and selection responsive while session data is indexed or refreshed.
- Make the next action and its scope clear before resuming, forking, or deleting.
- Preserve the user's terminal and opencode workflows rather than introducing window-management dependencies.
