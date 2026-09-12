# Releasing

[`.github/workflows/release.yml`](.github/workflows/release.yml) does the whole
job: run tests, publish to npm with provenance, and create the GitHub release.
There are two ways to trigger it.

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
npm version patch          # updates package.json + lock, commits, tags vX.Y.Z
git push --follow-tags     # the tag push triggers the same release workflow
```

`prepublishOnly` runs the tests and typecheck again before uploading.

## Before you release

Move the `## [Unreleased]` entries in [CHANGELOG.md](CHANGELOG.md) into a new
`## [x.y.z] - YYYY-MM-DD` section and update the compare links. The one-click
workflow does not edit the changelog for you.

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
