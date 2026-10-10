# Contributing

Thanks for wanting to help. `sesh` is a small, opinionated tool — issues and
pull requests are welcome.

## Getting started

```bash
git clone https://github.com/ozandogrultan/opencode-sesh.git
cd opencode-sesh
bun install
```

`bin/` holds flat shell scripts, `tui-plugins/sesh-panel/tui.tsx` is the OpenTUI
plugin, and `plugins/sesh-list.ts` is the agent tool. The only build step is
`bun run build`, which compiles the panel to `dist/tui.js` (gitignored; `bun run
test` and `npm pack` run it for you).

## Before you open a PR

Run the full check suite and make sure it passes:

```bash
bun run test         # builds dist/tui.js, then the fixture-database regression suite
bun run typecheck    # tsc over tui-plugins/ and plugins/
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
feat(tui): open the picker with option+o
fix(preview): show the newest transcript messages first
docs: document the glow fallback
feat!: drop support for opencode < 1.18
```

The type maps to the next version bump (`feat` → minor, `fix`/`perf` → patch,
`!`/`BREAKING CHANGE` → major), so keep subjects accurate.

This is enforced locally by Git hooks that `bun install` installs (via husky):

- `commit-msg` runs commitlint over your message.
- `pre-commit` runs `bun run lint:sh`, `bun run typecheck`, and `bun run test`.

Fix failing checks before committing. CI also lints the commits in a pull request.

## Releases

Releases are cut from the **Release** workflow (`workflow_dispatch`), which asks
for a `patch`, `minor` or `major` bump and then:

1. bumps the version in `package.json`,
2. writes a dated section and compare link in [CHANGELOG.md](CHANGELOG.md)
   from notable Conventional Commits since the last tag,
3. commits and tags `vX.Y.Z`, publishes to npm with provenance, and creates the
   GitHub release with the new section as its body.

Write Conventional Commits for notable changes. A release with no notable
commits since the previous tag is a no-op. A tag without a matching section
uses GitHub-generated release notes.

`scripts/changelog.sh` drafts, writes, and validates the changelog locally;
it does not bump the package version, commit, tag, or publish:

```bash
scripts/changelog.sh draft          # classify commits since the last tag (prints only)
scripts/changelog.sh release 0.2.0  # write a dated section and compare link
scripts/changelog.sh notes 0.2.0    # the release-notes body for a version
scripts/changelog.sh notes          # the latest released version
scripts/changelog.sh check          # structure: headings and compare links
```

`bun run test:changelog` covers the tooling, and `check` also runs in CI: every
released heading needs its link definition.

## Reporting bugs and requesting features

Use the issue templates. For bugs, include your OS, `opencode` and `fzf`
versions, and the steps to reproduce.

## Security

Please do not file public issues for security problems. See
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
