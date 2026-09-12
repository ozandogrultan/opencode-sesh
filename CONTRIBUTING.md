# Contributing

Thanks for wanting to help. `sesh` is a small, opinionated tool — issues and
pull requests are welcome.

## Getting started

```bash
git clone https://github.com/ozandogrultan/opencode-sesh.git
cd opencode-sesh
npm install
```

There is no build step. `bin/` holds flat shell scripts, `tui/sesh-panel.tsx`
is the OpenTUI plugin, and `opencode/tools/sesh-list.ts` is the agent tool.

## Before you open a PR

Run the full check suite and make sure it passes:

```bash
npm test             # fixture-database regression suite
npm run typecheck    # tsc over tui/ and opencode/
npm run lint:sh      # bash -n on every script
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

## Reporting bugs and requesting features

Use the issue templates. For bugs, include your OS, `opencode` and `fzf`
versions, and the steps to reproduce.

## Security

Please do not file public issues for security problems. See
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
