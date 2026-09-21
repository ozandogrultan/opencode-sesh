#!/bin/bash
# Regressions for scripts/changelog.sh: conventional-commit drafting, the
# [Unreleased] promotion, compare links and release notes. Everything runs in a
# throwaway repository, never this one.
set -euo pipefail
PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CHANGELOG_SH="$PACKAGE_DIR/scripts/changelog.sh"
command -v git >/dev/null 2>&1 || { echo "git is required for these tests" >&2; exit 1; }
[ -x "$CHANGELOG_SH" ] || { echo "$CHANGELOG_SH is not executable" >&2; exit 1; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/sesh-changelog.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

# Hermetic git: ignore the developer's identity, signing and hook setup, and pin
# the release date so the promoted heading is deterministic.
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
# An ssh remote still has to yield https compare links in the changelog.
git remote add origin git@github.com:acme/widgets.git

cat > CHANGELOG.md <<'MD'
# Changelog

## [Unreleased]

### Fixed

- An entry nobody promoted yet.

## [0.1.0] - 2026-01-01

### Added

- First release.

[Unreleased]: https://github.com/acme/widgets/compare/v0.1.0...HEAD
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

# Drafting classifies types, keeps notable changes, and pulls breaking changes
# (subject `!` or a BREAKING CHANGE footer) into their own section.
bash "$CHANGELOG_SH" draft > draft.md
expect_contains draft.md '### Added'
expect_contains draft.md '- **picker:** Confirm deletes'
expect_contains draft.md '### Fixed'
expect_contains draft.md '- **tui:** Stop stealing the arrow keys'
expect_contains draft.md '### Breaking changes'
expect_contains draft.md '- **cli:** Rename --old _(breaking)_'
expect_contains draft.md 'Drop the legacy flag _(breaking)_'
expect_missing draft.md 'Update the readme'

bash "$CHANGELOG_SH" draft --all > draft-all.md
expect_contains draft-all.md '### Internal'
expect_contains draft-all.md 'Update the readme'

# --write refuses to clobber entries a human wrote; --force replaces them.
expect_failure bash "$CHANGELOG_SH" draft --write
expect_contains CHANGELOG.md 'An entry nobody promoted yet.'
bash "$CHANGELOG_SH" draft --write --force
expect_contains CHANGELOG.md '- **picker:** Confirm deletes'
expect_missing CHANGELOG.md 'An entry nobody promoted yet.'
bash "$CHANGELOG_SH" check > check.out
expect_contains check.out 'changelog: ok'

# Promotion dates the section, opens a fresh Unreleased above it, and moves both
# compare links without touching released history.
bash "$CHANGELOG_SH" promote 0.2.0
expect_contains CHANGELOG.md '## [0.2.0] - 2026-01-01'
expect_contains CHANGELOG.md '- **picker:** Confirm deletes'
expect_contains CHANGELOG.md 'First release.'
expect_contains CHANGELOG.md '[0.2.0]: https://github.com/acme/widgets/compare/v0.1.0...v0.2.0'
expect_contains CHANGELOG.md '[Unreleased]: https://github.com/acme/widgets/compare/v0.2.0...HEAD'
expect_contains CHANGELOG.md '[0.1.0]: https://github.com/acme/widgets/releases/tag/v0.1.0'
unreleased_line=$(grep -n -m1 -F '## [Unreleased]' CHANGELOG.md | cut -d: -f1)
version_line=$(grep -n -m1 -F '## [0.2.0]' CHANGELOG.md | cut -d: -f1)
[ "$unreleased_line" -lt "$version_line" ] || { echo "promote left [Unreleased] below [0.2.0]" >&2; exit 1; }
bash "$CHANGELOG_SH" check > /dev/null
expect_failure bash "$CHANGELOG_SH" promote 0.2.0
expect_failure bash "$CHANGELOG_SH" promote not-a-version

# Notes print the released body with a link back to the compare range.
bash "$CHANGELOG_SH" notes 0.2.0 > notes.md
expect_contains notes.md '### Added'
expect_contains notes.md '### Breaking changes'
expect_contains notes.md 'Full changelog: https://github.com/acme/widgets/compare/v0.1.0...v0.2.0'
expect_failure bash "$CHANGELOG_SH" notes 9.9.9
# Promotion leaves Unreleased empty, so there is nothing to publish from it.
expect_failure bash "$CHANGELOG_SH" notes

# check catches a hand-edited file that lost a link definition.
grep -v -F '[0.1.0]: ' CHANGELOG.md > broken.md
mv broken.md CHANGELOG.md
expect_failure bash "$CHANGELOG_SH" check

echo "changelog tests passed"
