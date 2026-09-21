#!/usr/bin/env bash
# Changelog and release-notes tooling for this repository.
#
# Cutting a release used to be manual bookkeeping: promote the [Unreleased]
# section, stamp it with a date, insert the new compare link, and hand-write a
# GitHub release body. This script owns those mechanical parts, and can draft
# the section from conventional commits when nobody wrote entries by hand.
#
#   changelog.sh draft [--write] [--all] [--force]
#   changelog.sh promote <version>
#   changelog.sh notes [<version>]
#   changelog.sh check
#
# Run from the repository root. Reads and writes ./CHANGELOG.md (override with
# CHANGELOG_FILE) and uses the origin remote for compare links (override with
# CHANGELOG_REPO_URL).
set -euo pipefail

CHANGELOG=${CHANGELOG_FILE:-CHANGELOG.md}
TODAY=${CHANGELOG_TODAY:-$(date +%Y-%m-%d)}
UNRELEASED='Unreleased'
UNRELEASED_HEADING="## [$UNRELEASED]"

usage() {
  cat >&2 <<'USAGE'
usage: changelog.sh draft [--write] [--all] [--force]
       changelog.sh promote <version>
       changelog.sh notes [<version>]
       changelog.sh check

  draft     classify commits since the last release tag into Keep a Changelog
            sections and print them for [Unreleased]. Prints only; --write
            replaces the section (--force to overwrite entries already there,
            --all to include docs/test/build/ci/chore commits).
  promote   turn [Unreleased] into [<version>] - today, start a fresh
            [Unreleased], and move the compare links.
  notes     print the release-notes body for <version> (default: Unreleased).
            Exits non-zero when the section is missing or empty.
  check     structural checks: the Unreleased heading and link exist, the link
            ends in HEAD, and every released version has a link definition.
USAGE
  exit 2
}

die() { echo "changelog: $*" >&2; exit 1; }

[ -f "$CHANGELOG" ] || die "$CHANGELOG not found; run from the repository root"

# --- reading the file -------------------------------------------------------

heading_line() { # heading → 1-based line number, empty when absent
  grep -n -m1 -F -- "$1" "$CHANGELOG" | cut -d: -f1 || true
}

section_end() { # start line → exclusive end line (next heading, link block, EOF)
  local start=$1 end
  end=$(awk -v from="$start" 'NR > from && (/^## \[/ || /^\[[^]]+\]: /) { print NR; exit }' "$CHANGELOG")
  if [ -n "$end" ]; then printf '%s' "$end"; else printf '%s' "$(( $(wc -l < "$CHANGELOG") + 1 ))"; fi
}

trim_blanks() {
  awk '
    NF { started = 1 }
    started { line[++n] = $0; if (NF) last = n }
    END { for (i = 1; i <= last; i++) print line[i] }
  '
}

section_body() { # start end → the trimmed body between them
  sed -n "$(( $1 + 1 )),$(( $2 - 1 ))p" "$CHANGELOG" | trim_blanks
}

version_headings() {
  grep -E '^## \[[0-9]+\.[0-9]+\.[0-9]+\]' "$CHANGELOG" | sed -E 's/^## \[([^]]+)\].*/\1/'
}

last_version() { version_headings | head -n 1; }

link_url() { # version (or Unreleased) → URL from its link definition
  grep -F -m1 -- "[$1]: " "$CHANGELOG" | sed -E 's/^\[[^]]+\]: //' || true
}

repo_url() {
  local url=${CHANGELOG_REPO_URL:-}
  if [ -z "$url" ]; then
    url=$(git config --get remote.origin.url 2>/dev/null || true)
  fi
  case "$url" in
    # git@host:owner/repo → https://host/owner/repo. The colon is replaced
    # before the scheme is added, or the replacement would hit "https:".
    git@*:*)
      url=${url#git@}
      url="https://${url/:/\/}"
      ;;
    ssh://git@*) url="https://${url#ssh://git@}" ;;
  esac
  printf '%s' "${url%.git}"
}

# Replace lines [start, end) with stdin. Every rewrite goes through here so the
# file is never edited by a regex that could match somewhere else.
splice() { # start end
  local start=$1 end=$2 tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/changelog.XXXXXX")
  head -n "$(( start - 1 ))" "$CHANGELOG" > "$tmp"
  cat >> "$tmp"
  tail -n "+$end" "$CHANGELOG" >> "$tmp"
  mv "$tmp" "$CHANGELOG"
}

# --- draft ------------------------------------------------------------------

cmd_draft() {
  local write=0 all=0 force=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --write) write=1 ;;
      --all) all=1 ;;
      --force) force=1 ;;
      *) usage ;;
    esac
    shift
  done

  local start end last range subjects breaking
  start=$(heading_line "$UNRELEASED_HEADING")
  [ -n "$start" ] || die "no '$UNRELEASED_HEADING' heading in $CHANGELOG"
  end=$(section_end "$start")

  git rev-parse --git-dir >/dev/null 2>&1 || die "not a git repository; draft needs the commit log"
  last=$(last_version)
  if [ -n "$last" ] && git rev-parse -q --verify "refs/tags/v$last" >/dev/null; then
    range="v$last..HEAD"
  else
    range="HEAD"
  fi

  subjects=$(git log --no-merges --pretty=format:'%s' "$range")
  # A breaking change marks its commit twice: `type!:` in the subject, or a
  # BREAKING CHANGE footer in the body (which git matches per message line).
  breaking=$(git log --no-merges -E --grep='^BREAKING[ -]CHANGE:' --pretty=format:'%s' "$range" || true)

  local body
  body=$(printf '%s\n' "$subjects" | awk -v all="$all" -v breaking="$breaking" '
    BEGIN {
      n = split(breaking, list, "\n")
      for (i = 1; i <= n; i++) isBreaking[list[i]] = 1
      order[1] = "Breaking changes"; order[2] = "Added"; order[3] = "Changed"
      order[4] = "Fixed"; order[5] = "Internal"
    }
    {
      subject = $0
      if (subject !~ /^[a-z]+(\([^)]+\))?!?: /) { skipped++; next }
      match(subject, /^[a-z]+/); type = substr(subject, 1, RLENGTH)
      rest = substr(subject, RLENGTH + 1)
      scope = ""
      if (rest ~ /^\(/) {
        match(rest, /^\([^)]*\)/); scope = substr(rest, 2, RLENGTH - 2)
        rest = substr(rest, RLENGTH + 1)
      }
      bang = 0
      if (rest ~ /^!/) { bang = 1; rest = substr(rest, 2) }
      sub(/^: +/, "", rest)
      text = toupper(substr(rest, 1, 1)) substr(rest, 2)

      if (type == "feat") section = "Added"
      else if (type == "fix") section = "Fixed"
      else if (type == "perf" || type == "refactor" || type == "revert") section = "Changed"
      else section = "Internal"
      if (section == "Internal" && !all) { skipped++; next }
      if (bang || isBreaking[subject]) section = "Breaking changes"

      bullet = (scope == "" ? "- " text : "- **" scope ":** " text)
      if (section == "Breaking changes") bullet = bullet " _(breaking)_"
      lines[section] = lines[section] bullet "\n"
    }
    END {
      for (i = 1; i <= 5; i++) {
        s = order[i]
        if (lines[s] == "") continue
        printf "### %s\n\n%s\n", s, lines[s]
      }
    }
  ')

  local new
  new=$(printf '## [%s]\n\n%s' "$UNRELEASED" "$body")
  if [ -z "$body" ]; then
    echo "changelog: no notable commits in $range" >&2
  fi

  if [ "$write" = 0 ]; then
    printf '%s\n' "$new"
    return 0
  fi

  local existing
  existing=$(section_body "$start" "$end")
  if [ -n "$existing" ] && [ "$force" = 0 ]; then
    die "[$UNRELEASED] already has entries; pass --force to replace them, or edit by hand"
  fi
  printf '%s\n' "$new" | splice "$start" "$end"
  echo "changelog: rewrote [$UNRELEASED] from $range" >&2
}

# --- promote ----------------------------------------------------------------

cmd_promote() {
  local raw=${1:-} version prev url body
  [ -n "$raw" ] || usage
  version=${raw#v}
  case "$version" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) die "version must look like X.Y.Z (got '$raw')" ;;
  esac
  case "$version" in *[!0-9.]*) die "version must look like X.Y.Z (got '$raw')" ;; esac
  if grep -q -F -- "## [$version]" "$CHANGELOG"; then
    die "$version already has a section"
  fi

  local start end
  start=$(heading_line "$UNRELEASED_HEADING")
  [ -n "$start" ] || die "no '$UNRELEASED_HEADING' heading in $CHANGELOG"
  end=$(section_end "$start")

  prev=$(version_headings | head -n 1)
  body=$(section_body "$start" "$end")
  if [ -z "$body" ]; then
    echo "changelog: warning: [$UNRELEASED] is empty; releasing $version anyway" >&2
  fi

  # The released section keeps its body; a fresh, empty Unreleased goes above it.
  {
    printf '## [%s]\n\n## [%s] - %s\n\n' "$UNRELEASED" "$version" "$TODAY"
    if [ -n "$body" ]; then printf '%s\n' "$body"; fi
  } | splice "$start" "$end"

  url=$(repo_url)
  if [ -z "$url" ]; then
    echo "changelog: warning: no repository URL (no origin remote); compare links not updated" >&2
  else
    local new_link
    if [ -n "$prev" ]; then
      new_link="[$version]: $url/compare/v$prev...v$version"
    else
      new_link="[$version]: $url/releases/tag/v$version"
    fi
    awk -v url="$url" -v version="$version" -v new_link="$new_link" '
      /^\[Unreleased\]: / {
        print "[" "Unreleased]: " url "/compare/v" version "...HEAD"
        print new_link
        next
      }
      { print }
    ' "$CHANGELOG" > "$CHANGELOG.tmp"
    mv "$CHANGELOG.tmp" "$CHANGELOG"
  fi

  echo "changelog: [$version] - $TODAY promoted${prev:+ (after $prev)}" >&2
}

# --- notes ------------------------------------------------------------------

cmd_notes() {
  local raw=${1:-$UNRELEASED} version start end body url
  version=${raw#v}
  if [ "$version" = "unreleased" ]; then version=$UNRELEASED; fi

  if [ "$version" = "$UNRELEASED" ]; then
    start=$(heading_line "$UNRELEASED_HEADING")
  else
    start=$(heading_line "## [$version]")
  fi
  [ -n "$start" ] || { echo "changelog: no section for $raw" >&2; return 1; }
  end=$(section_end "$start")
  body=$(section_body "$start" "$end")
  [ -n "$body" ] || { echo "changelog: section for $raw is empty" >&2; return 1; }

  printf '%s\n' "$body"
  if [ "$version" != "$UNRELEASED" ]; then
    url=$(link_url "$version")
    [ -n "$url" ] || url=$(repo_url)
    printf '\n---\n\n'
    if [ -n "$url" ]; then
      printf 'Full changelog: %s\n' "$url"
    else
      printf 'Full changelog: %s\n' "$CHANGELOG"
    fi
  fi
}

# --- check ------------------------------------------------------------------

cmd_check() {
  local start version problems=0 url
  start=$(heading_line "$UNRELEASED_HEADING")
  if [ -z "$start" ]; then
    echo "changelog: missing '$UNRELEASED_HEADING' heading" >&2
    problems=$(( problems + 1 ))
  fi
  url=$(link_url "$UNRELEASED")
  if [ -z "$url" ]; then
    echo "changelog: missing '[$UNRELEASED]:' link definition" >&2
    problems=$(( problems + 1 ))
  else
    case "$url" in
      *HEAD) ;;
      *) echo "changelog: '[$UNRELEASED]:' link must end in HEAD (got $url)" >&2; problems=$(( problems + 1 )) ;;
    esac
  fi
  while IFS= read -r version; do
    [ -n "$version" ] || continue
    if [ -z "$(link_url "$version")" ]; then
      echo "changelog: [$version] has no link definition" >&2
      problems=$(( problems + 1 ))
    fi
  done < <(version_headings)

  if [ "$problems" -gt 0 ]; then
    echo "changelog: $problems problem(s) found" >&2
    return 1
  fi
  echo "changelog: ok"
}

# --- dispatch ---------------------------------------------------------------

command=''
if [ "$#" -gt 0 ]; then
  command=$1
  shift
fi
case "$command" in
  draft) cmd_draft "$@" ;;
  promote) cmd_promote "$@" ;;
  notes) cmd_notes "$@" ;;
  check) cmd_check ;;
  help|-h|--help) usage ;;
  *) usage ;;
esac
