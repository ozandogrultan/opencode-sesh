#!/bin/bash
set -euo pipefail
PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CHANGELOG_SH="$PACKAGE_DIR/scripts/changelog.sh"
command -v git >/dev/null 2>&1 || { echo "git is required for these tests" >&2; exit 1; }
[ -x "$CHANGELOG_SH" ] || { echo "$CHANGELOG_SH is not executable" >&2; exit 1; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/sesh-changelog.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=sesh-test GIT_AUTHOR_EMAIL=sesh-test@example.com
export GIT_COMMITTER_NAME=sesh-test GIT_COMMITTER_EMAIL=sesh-test@example.com
export CHANGELOG_TODAY=2026-01-01

expect_contains() {
  grep -Fq -- "$2" "$1" || { echo "expected '$2' in $1" >&2; exit 1; }
}
expect_missing() {
  if grep -Fq -- "$2" "$1"; then echo "did not expect '$2' in $1" >&2; exit 1; fi
}
expect_failure() {
  if "$@" >/dev/null 2>&1; then echo "expected a failure: $*" >&2; exit 1; fi
}

cd "$tmp"
git init -q
git remote add origin git@github.com:acme/widgets.git

cat > CHANGELOG.md <<'MD'
# Changelog

## [0.1.0] - 2026-01-01

### Added

- First release.

[0.1.0]: https://github.com/acme/widgets/releases/tag/v0.1.0
MD
git add CHANGELOG.md
git commit -q -m 'chore: initial changelog'
git tag v0.1.0

commit() {
  if [ -n "${2:-}" ]; then git commit -q --allow-empty -m "$1" -m "$2"; else git commit -q --allow-empty -m "$1"; fi
}
commit 'feat(picker): confirm deletes'
commit 'fix(tui): stop stealing the arrow keys'
commit 'docs: update the readme'
commit 'feat!: drop the legacy flag'
commit 'fix(cli): rename --old' 'BREAKING CHANGE: use --new instead.'
commit 'docs: revise API' 'BREAKING CHANGE: remove old API docs.'

bash "$CHANGELOG_SH" draft > draft.md
expect_contains draft.md '### Added'
expect_contains draft.md '- **picker:** Confirm deletes'
expect_contains draft.md '### Fixed'
expect_contains draft.md '- **tui:** Stop stealing the arrow keys'
expect_contains draft.md '### Breaking changes'
expect_contains draft.md '- **cli:** Rename --old _(breaking)_'
expect_contains draft.md '- Revise API _(breaking)_'
expect_contains draft.md 'Drop the legacy flag _(breaking)_'
expect_missing draft.md 'Update the readme'

bash "$CHANGELOG_SH" draft --all > draft-all.md
expect_contains draft-all.md '### Internal'
expect_contains draft-all.md 'Update the readme'

expect_missing CHANGELOG.md 'Confirm deletes'
bash "$CHANGELOG_SH" check > check.out
expect_contains check.out 'changelog: ok'

bash "$CHANGELOG_SH" release 0.2.0
expect_contains CHANGELOG.md '## [0.2.0] - 2026-01-01'
expect_contains CHANGELOG.md '- **picker:** Confirm deletes'
expect_contains CHANGELOG.md 'First release.'
expect_contains CHANGELOG.md '[0.2.0]: https://github.com/acme/widgets/compare/v0.1.0...v0.2.0'
expect_contains CHANGELOG.md '[0.1.0]: https://github.com/acme/widgets/releases/tag/v0.1.0'
bash "$CHANGELOG_SH" check > /dev/null
expect_failure bash "$CHANGELOG_SH" release 0.2.0
expect_failure bash "$CHANGELOG_SH" release not-a-version
expect_failure bash "$CHANGELOG_SH" release 1.2.3.4
expect_failure bash "$CHANGELOG_SH" release 1..3

bash "$CHANGELOG_SH" notes 0.2.0 > notes.md
expect_contains notes.md '### Added'
expect_contains notes.md '### Breaking changes'
expect_contains notes.md 'Full changelog: https://github.com/acme/widgets/compare/v0.1.0...v0.2.0'
expect_failure bash "$CHANGELOG_SH" notes 9.9.9
bash "$CHANGELOG_SH" notes > latest.md
cmp notes.md latest.md
git add CHANGELOG.md
git commit -q -m 'chore: release notes'
git tag v0.2.0
expect_failure bash "$CHANGELOG_SH" release 0.2.1
[ -z "$(bash "$CHANGELOG_SH" draft)" ] || { echo 'expected empty draft' >&2; exit 1; }
commit 'docs: update docs again'
expect_failure bash "$CHANGELOG_SH" release 0.2.1
commit 'fix: next fix'
bash "$CHANGELOG_SH" release 0.2.1
expect_contains CHANGELOG.md '[0.2.1]: https://github.com/acme/widgets/compare/v0.2.0...v0.2.1'

cp CHANGELOG.md valid.md
printf '\n## [Unreleased]\n' >> CHANGELOG.md
expect_failure bash "$CHANGELOG_SH" check
cp valid.md CHANGELOG.md
printf '\n[Unreleased]: https://github.com/acme/widgets/compare/v0.2.1...HEAD\n' >> CHANGELOG.md
expect_failure bash "$CHANGELOG_SH" check
cp valid.md CHANGELOG.md
printf '\n## [0.2.1] - 2026-01-01\n' >> CHANGELOG.md
expect_failure bash "$CHANGELOG_SH" check
cp valid.md CHANGELOG.md
printf '\n## [0.2.2]\n' >> CHANGELOG.md
expect_failure bash "$CHANGELOG_SH" check
cp valid.md CHANGELOG.md

grep -v -F '[0.1.0]: ' CHANGELOG.md > broken.md
mv broken.md CHANGELOG.md
expect_failure bash "$CHANGELOG_SH" check

printf '# Changelog\n' > CHANGELOG.md
expect_failure bash "$CHANGELOG_SH" notes
expect_failure bash "$CHANGELOG_SH" last
expect_failure bash "$CHANGELOG_SH" check
git add CHANGELOG.md
git commit -q -m 'chore: initial empty changelog'
commit 'feat: initial feature'
bash "$CHANGELOG_SH" release 1.0.0
expect_contains CHANGELOG.md '## [1.0.0] - 2026-01-01'
expect_contains CHANGELOG.md '[1.0.0]: https://github.com/acme/widgets/releases/tag/v1.0.0'
bash "$CHANGELOG_SH" check > /dev/null

echo "changelog tests passed"
