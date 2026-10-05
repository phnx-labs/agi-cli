#!/usr/bin/env bash
# Decide whether a target version is an acceptable next release and which bump it is. Extracted
# from release.sh so the arithmetic is testable. patch-from-main opens one step after an
# unpublishable main; it is not a bypass, since the release still earns its own PR and CI.

set -euo pipefail

[[ $# -eq 4 ]] || { echo "usage: validate-bump.sh <published> <pkg-json> <shim> <target>" >&2; exit 2; }

PHNX_LATEST="$1"
PKG_JSON_VERSION="$2"
SWARMIFY_LATEST="$3"
TARGET="$4"

parse_v() { echo "$1" | tr '.' ' '; }
read -r CMAJ CMIN CPAT <<< "$(parse_v "$PHNX_LATEST")"
read -r PMAJ PMIN PPAT <<< "$(parse_v "$PKG_JSON_VERSION")"
read -r SMAJ SMIN SPAT <<< "$(parse_v "$SWARMIFY_LATEST")"
read -r TMAJ TMIN TPAT <<< "$(parse_v "$TARGET")"

newer_than() {
  [[ $1 -gt $4 ]] && return 0
  [[ $1 -eq $4 && $2 -gt $5 ]] && return 0
  [[ $1 -eq $4 && $2 -eq $5 && $3 -gt $6 ]] && return 0
  return 1
}

BUMP=""
if [[ $TMAJ -eq $CMAJ && $TMIN -eq $CMIN && $TPAT -eq $((CPAT + 1)) ]]; then
  BUMP="patch"
elif [[ $TMAJ -eq $CMAJ && $TMIN -eq $((CMIN + 1)) && $TPAT -eq 0 ]]; then
  BUMP="minor"
elif [[ $TMAJ -eq $((CMAJ + 1)) && $TMIN -eq 0 && $TPAT -eq 0 ]]; then
  BUMP="major"
elif [[ "$TARGET" == "$PHNX_LATEST" ]] && newer_than "$TMAJ" "$TMIN" "$TPAT" "$SMAJ" "$SMIN" "$SPAT"; then
  BUMP="shim-catchup"
elif [[ "$TARGET" == "$PKG_JSON_VERSION" ]] && newer_than "$PMAJ" "$PMIN" "$PPAT" "$CMAJ" "$CMIN" "$CPAT"; then
  BUMP="phnx-catchup"
elif [[ $TMAJ -eq $PMAJ && $TMIN -eq $PMIN && $TPAT -eq $((PPAT + 1)) ]] \
     && newer_than "$PMAJ" "$PMIN" "$PPAT" "$CMAJ" "$CMIN" "$CPAT"; then
  BUMP="patch-from-main"
fi

if [[ -n "$BUMP" ]]; then
  echo "$BUMP"
  exit 0
fi

{
  echo "invalid bump: $PHNX_LATEST -> $TARGET"
  echo "expected one of:"
  echo "  $CMAJ.$CMIN.$((CPAT + 1))   (patch)"
  echo "  $CMAJ.$((CMIN + 1)).0   (minor)"
  echo "  $((CMAJ + 1)).0.0   (major)"
  if newer_than "$PMAJ" "$PMIN" "$PPAT" "$CMAJ" "$CMIN" "$CPAT"; then
    echo "  $PKG_JSON_VERSION   (phnx-catchup: package.json is ahead of registry)"
    echo "  $PMAJ.$PMIN.$((PPAT + 1))   (patch-from-main: the next patch after an unpublishable main)"
  fi
} >&2
exit 1
