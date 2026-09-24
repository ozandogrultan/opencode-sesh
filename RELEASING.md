# Releasing

[`.github/workflows/release.yml`](.github/workflows/release.yml) does the whole
job: run tests, publish to npm with provenance, and create the GitHub release.
There are two ways to trigger it.

Development uses [bun](https://bun.sh) (`bun install`, `bun run test`). Publishing
still uses the npm CLI: npm trusted publishing (OIDC) and provenance
attestations are only supported through `npm publish`, so `bun publish` is not
used here.

## One-click (recommended)

From the Actions tab (**Release → Run workflow**) or:

```bash
gh workflow run release.yml -f bump=patch   # or minor / major
```

That workflow checks out `main`, bumps the version, commits and tags it,
pushes, publishes to npm, and cuts the GitHub release with generated notes.

Do this from a green `main` — it releases whatever is there.

## From a tag push

If you prefer to bump locally:

```bash
npm version minor          # patch / minor / major per the commit types
git push --follow-tags     # the tag push triggers the same release workflow
```

`prepublishOnly` runs the tests and typecheck again before uploading.

## Before you release

Pick the bump from the [Conventional Commits](CONTRIBUTING.md#commit-messages)
since the last release — the highest impact wins: `feat` → minor,
`fix`/`perf` → patch, `!`/`BREAKING CHANGE` → major.

Keep releasable entries under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md)
and do not promote them yourself: the workflow runs
`scripts/changelog.sh promote` during the release commit, and promoting
beforehand makes it fail (`0.x.y already has a section`). `changelog.sh check`
validates the structure; `changelog.sh notes` previews the release body.

## One-time setup

npm uses [trusted publishing][trusted], so no token is stored in the repo. On
npmjs.com, under `opencode-sesh` → Settings → Trusted Publishers, the GitHub
Actions publisher must point at:

- owner: `ozandogrultan`
- repository: `opencode-sesh`
- workflow filename: `release.yml`

Renaming that workflow file breaks publishing; update the npm setting too.

[trusted]: https://docs.npmjs.com/trusted-publishers

## Verifying

- npm: `npm view opencode-sesh version` and
  `npm view opencode-sesh dist.attestations` (provenance present).
- GitHub: a release exists for the tag, with generated notes.

## Manual fallback

Only if CI is unavailable:

```bash
npm login
npm publish --access public
```

Manual publishes do not get provenance attestations.
