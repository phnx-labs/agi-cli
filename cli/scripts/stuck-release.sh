#!/usr/bin/env bash

set -euo pipefail

LATEST="${1:-}"
BUMP_KIND="${2:-}"
MAIN_VERSION="${3:-}"
[[ -n "$LATEST" ]] || { echo "usage: stuck-release.sh <registry-latest> [<bump-kind> <main-version>] < tags" >&2; exit 2; }

newer_than_latest() {
  [[ "$1" != "$LATEST" ]] || return 1
  [[ "$(printf '%s\n%s\n' "$LATEST" "$1" | sort -V | tail -1)" == "$1" ]]
}

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
  if $EXEMPT_MAIN && [[ "$version" == "$MAIN_VERSION" ]]; then
    echo "note: v$version is tagged but unpublishable (main already carries it); $BUMP_KIND steps over it" >&2
    continue
  fi
  if [[ -z "$STUCK" ]] \
     || [[ "$(printf '%s\n%s\n' "$STUCK" "$version" | sort -V | head -1)" == "$version" ]]; then
    STUCK="$version"
  fi
done

[[ -n "$STUCK" ]] || exit 1
printf '%s\n' "$STUCK"
