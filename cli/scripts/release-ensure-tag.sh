#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?usage: release-ensure-tag.sh <version> <head-sha> <remote-tag-sha-or-empty> [release-branch]}"
HEAD_SHA="${2:?usage: release-ensure-tag.sh <version> <head-sha> <remote-tag-sha-or-empty> [release-branch]}"
REMOTE_TAG_SHA="${3-}"
RELEASE_BRANCH="${4-}"
SCRIPT_DIR="${BASH_SOURCE[0]%/*}"; [[ "$SCRIPT_DIR" != "${BASH_SOURCE[0]}" ]] || SCRIPT_DIR=.

HEAD_SHA="$(git rev-parse "$HEAD_SHA^{commit}")"
if [[ -n "$RELEASE_BRANCH" ]]; then
  "$SCRIPT_DIR/release-require-branch-head.sh" origin "$RELEASE_BRANCH" "$HEAD_SHA"
fi
if [[ -n "$REMOTE_TAG_SHA" ]]; then
  [[ "$REMOTE_TAG_SHA" == "$HEAD_SHA" ]] || {
    echo "error: v$VERSION already points at $REMOTE_TAG_SHA, not release branch head $HEAD_SHA" >&2
    exit 1
  }
  exit 0
fi

git config user.name "agents-cli release"
git config user.email "release@phnx-labs.invalid"
"$SCRIPT_DIR/create-annotated-release-tag.sh" "$VERSION" "$HEAD_SHA"
if [[ -n "$RELEASE_BRANCH" ]]; then
  git push --atomic --force-with-lease="refs/heads/$RELEASE_BRANCH:$HEAD_SHA" origin \
    "$HEAD_SHA:refs/heads/$RELEASE_BRANCH" "refs/tags/v$VERSION"
else
  git push origin "refs/tags/v$VERSION"
fi
