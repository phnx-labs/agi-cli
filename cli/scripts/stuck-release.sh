#!/usr/bin/env bash
# Find the release that died between `git tag` and `npm publish`: the tag is pushed but npm never
# saw it, so the next run validates against a behind npm and cuts the NEXT version, widening the
# gap. The pair <bump-kind> <main-version> carves out one deadlock.

set -euo pipefail

LATEST="${1:-}"
BUMP_KIND="${2:-}"
MAIN_VERSION="${3:-}"
[[ -n "$LATEST" ]] || { echo "usage: stuck-release.sh <registry-latest> [<bump-kind> <main-version>] < tags" >&2; exit 2; }

# Strictly newer than the registry's latest? `sort -V` is the semver order.
newer_than_latest() { # $1 = version
  [[ "$1" != "$LATEST" ]] || return 1
  [[ "$(printf '%s\n%s\n' "$LATEST" "$1" | sort -V | tail -1)" == "$1" ]]
}

# Is this the one deadlock case? Decided once up front so the loop drops only main's own version
# from the candidates; returning early would hide a genuine died-between-tag-and-publish jam
# behind main's version.
EXEMPT_MAIN=false
if [[ "$BUMP_KIND" == "patch-from-main" && -n "$MAIN_VERSION" ]]; then
  EXEMPT_MAIN=true
fi

STUCK=""
while read -r version published _rest; do
  [[ -n "${version:-}" ]] || continue
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
  [[ "${published:-}" == "no" ]] || continue
  newer_than_latest "$version" || continue
  # The sanctioned step over an unpublishable stuck release (see the header). Say so on stderr
  # rather than disarming silently, since stepping over a tagged-but-unpublished version without a
  # word is the silent skip this repo forbids at boundaries.
  if $EXEMPT_MAIN && [[ "$version" == "$MAIN_VERSION" ]]; then
    echo "note: v$version is tagged but unpublishable (main already carries it); $BUMP_KIND steps over it" >&2
    continue
  fi
  # Oldest stuck version wins: that is the one blocking the queue, and finishing
  # it is what lets every later version publish in order.
  if [[ -z "$STUCK" ]] \
     || [[ "$(printf '%s\n%s\n' "$STUCK" "$version" | sort -V | head -1)" == "$version" ]]; then
    STUCK="$version"
  fi
done

[[ -n "$STUCK" ]] || exit 1
printf '%s\n' "$STUCK"
