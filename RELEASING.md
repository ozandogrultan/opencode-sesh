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

That workflow checks out `main`, drafts notable commits, bumps the version,
writes the changelog, commits and tags it, pushes, publishes to npm, and cuts
the GitHub release using the new changelog section. It does nothing when there
are no notable commits since the last release.

Do this from a green `main` — it releases whatever is there.

## From a tag push

If you prefer to bump locally:

```bash
npm version minor --no-git-tag-version   # patch / minor / major per the commit types
version=$(node -p "require('./package.json').version")
bash scripts/changelog.sh release "$version"
bash scripts/changelog.sh check
git add package.json CHANGELOG.md
git commit -m "chore(release): v$version"
git tag -a "v$version" -m "v$version"
git push --follow-tags
```

`prepublishOnly` runs the tests and typecheck again before uploading.
The tag workflow skips npm publication if that version is already published,
but still creates or updates the GitHub release. It uses the matching changelog
section, falling back to generated notes only when that section is unavailable.

## Before you release

Pick the bump from the [Conventional Commits](CONTRIBUTING.md#commit-messages)
since the last release — the highest impact wins: `feat` → minor,
`fix`/`perf` → patch, `!`/`BREAKING CHANGE` → major.

The workflow drafts notable Conventional Commits since the last release tag,
then runs `scripts/changelog.sh release` to write the new version section in
[CHANGELOG.md](CHANGELOG.md). `changelog.sh draft` previews the next release;
`changelog.sh check` validates links, and `changelog.sh notes` reads the latest
released body. A dispatch with no notable new commits does nothing.

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
- GitHub: a release exists for the tag, with the matching changelog section
  (or generated notes when that section is unavailable).

## Manual fallback

Only if CI is unavailable:

```bash
npm login
npm publish --access public
```

Manual publishes do not get provenance attestations.
