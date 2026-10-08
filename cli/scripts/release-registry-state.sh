#!/usr/bin/env bash
set -euo pipefail

PACKAGE="${1:?usage: release-registry-state.sh <package> <version>}"
VERSION="${2:?usage: release-registry-state.sh <package> <version>}"
versions="$(npm view "$PACKAGE" versions --json)" \
  || { echo "error: could not query npm versions for $PACKAGE" >&2; exit 1; }
state="$(jq -er --arg version "$VERSION" '
  if type == "array" then
    if any(. == $version) then "present" else "absent" end
  elif type == "string" then
    if . == $version then "present" else "absent" end
  else error("npm versions response is not a string or array") end
' <<<"$versions")" \
  || { echo "error: invalid npm versions response for $PACKAGE" >&2; exit 1; }
echo "$state"
