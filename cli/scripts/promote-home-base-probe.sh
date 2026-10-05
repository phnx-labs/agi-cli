#!/usr/bin/env bash
# Read-only readiness probe for the promote home base (RUSH-3026). `secrets exec ... test -n`
# proves the token resolves without printing it, so a locked keychain or missing bundle fails
# before the release's first mutation, not after merge+tag (the RUSH-2535 shape).
set -u

fail() { echo "promote-probe: $*" >&2; exit 1; }

command -v npm  >/dev/null 2>&1 || fail "npm not on PATH"
command -v node >/dev/null 2>&1 || fail "node not on PATH"
command -v git  >/dev/null 2>&1 || fail "git not on PATH"
command -v jq   >/dev/null 2>&1 || fail "jq not on PATH"
command -v gh   >/dev/null 2>&1 || fail "gh not on PATH (release-asset attach)"
command -v agents >/dev/null 2>&1 || fail "agents CLI not on PATH (npmjs.com token injection)"
gh auth status >/dev/null 2>&1 || fail "gh is not authenticated"
agents secrets exec npmjs.com -- sh -c 'test -n "$NPM_TOKEN"' >/dev/null 2>&1 \
  || fail "npmjs.com bundle NPM_TOKEN is not readable headlessly (agents secrets add npmjs.com NPM_TOKEN, file-backed)"

echo "promote-ready"
