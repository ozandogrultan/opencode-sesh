# Contributing

Thanks for wanting to help. `sesh` is a small, opinionated tool — issues and
pull requests are welcome.

## Getting started

```bash
git clone https://github.com/ozandogrultan/opencode-sesh.git
cd opencode-sesh
bun install
```

There is no build step. `bin/` holds flat shell scripts, `tui/sesh-panel.tsx`
is the OpenTUI plugin, and `opencode/tools/sesh-list.ts` is the agent tool.

## Before you open a PR

Run the full check suite and make sure it passes:

```bash
bun run test         # fixture-database regression suite
bun run typecheck    # tsc over tui/ and opencode/
bun run lint:sh      # bash -n on every script
```

Also smoke-test the installer without touching your real config:

```bash
HOME=/tmp/fakehome bash install.sh
```

CI runs the same checks plus ShellCheck on the scripts.

## Guidelines

- Read [AGENTS.md](AGENTS.md) first. It documents the architecture, the data
  flow, and the hard-won TUI rules — in particular, changes that regress those
  rules will not be merged.
- Keep PRs focused. One concern per PR, with a clear description of the *why*.
- Match the surrounding style. Shell is POSIX-ish `bash`, formatted by hand; TS
  follows the existing SolidJS patterns.
- Never interpolate an unvalidated session id into SQL. Ids must match
  `^ses_[A-Za-z0-9]+$`.
- Only text parts belong in the search index and previews; reasoning and tool
  payloads stay out, and the tests assert this.
- New behaviour should come with a test in `tests/sesh.sh` where practical.

## Commit messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<optional scope>): <description>
```

| Type | Use for | Version impact |
| --- | --- | --- |
| `feat` | a new feature | minor |
| `fix` | a bug fix | patch |
| `perf` | a performance improvement | patch |
| `docs` | documentation only | none |
| `refactor` | behaviour-preserving change | none |
| `test` | tests only | none |
| `build` | build system or dependencies | none |
| `ci` | CI configuration | none |
| `chore` | other maintenance | none |

- Write the subject in the imperative mood, lower case, no trailing period.
- Add a body when the *why* is not obvious from the subject.
- Flag incompatible changes with `!` after the type/scope (`feat!:`) and/or a
  `BREAKING CHANGE:` footer; that maps to a major version.

Examples:

```text
feat(tui): open the picker with ctrl+o
fix(preview): show the newest transcript messages first
docs: document the glow fallback
feat!: drop support for opencode < 1.18
```

The type maps to the next version bump (`feat` → minor, `fix`/`perf` → patch,
`!`/`BREAKING CHANGE` → major), so keep subjects accurate.

This is enforced locally by Git hooks that `bun install` installs (via husky):

- `commit-msg` runs commitlint over your message.
- `pre-commit` runs `bun run lint:sh`, `bun run typecheck`, and `bun run test`.

Bypass a hook for one commit with `git commit --no-verify` (or `HUSKY=0`), but
CI lints the commits in a pull request regardless.

## Reporting bugs and requesting features

Use the issue templates. For bugs, include your OS, `opencode` and `fzf`
versions, and the steps to reproduce.

## Security

Please do not file public issues for security problems. See
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
