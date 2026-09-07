#!/usr/bin/env bash
#
# signing-home-base-probe.sh -- is THIS box a fully provisioned signing home base?
#
# The release's privileged phase (build + sign + notarize + npm publish +
# computer-helper, run_home_base_phase in release.sh) can ONLY run on a macOS box
# that carries ALL of:
#   - a `Developer ID Application` codesigning identity reachable in a
#     headless-unlockable keychain (rush-signing.keychain-db + signing.kcpass);
#   - the `apple.com` secrets bundle (notarytool creds) and the `npmjs.com`
#     bundle (the publish token), resolvable in the headless secrets context.
#
# These are what a provisioned home base (mac-mini) has and an unprovisioned
# `--device` fallback (e.g. zion) does not -- they are the checks that
# actually catch the RUSH-2535 case. (A third requirement, the Apple
# provisioning profile the keychain helper's signed build embedded, is gone —
# that helper moved out of this repo entirely with the standalone `secrets`
# engine, PHNX-3989.)
#
# release.sh runs this ON the resolved home base BEFORE any mutation. If the box
# is not provisioned it aborts there -- before the crabbox/PR/merge/tag phases --
# so a `--device <box>` fallback that lacks signing (e.g. the documented
# "mac-mini is down, use --device zion" path on a box that was never provisioned)
# can no longer merge the PR and push the tag and THEN die at the sign step,
# leaving a tagged-but-UNPUBLISHED release (RUSH-2535).
#
# The readiness logic lives here rather than inline in release.sh so it can be
# tested directly (scripts/signing-home-base-probe.test.ts) -- same split as
# stuck-release.sh / validate-bump.sh. It is READ-ONLY: it never runs git tag,
# push, commit, merge, worktree, checkout, switch, or reset, nor a gh/npm
# mutation, so invoking it can never advance the release.
#
# Usage:  scripts/signing-home-base-probe.sh
#
# Prints `OK` and exits 0 when every requirement is present. Otherwise prints one
# `MISSING: <reason>` line per gap to stderr and exits 1. Exit 2 is a usage error.

set -uo pipefail

missing=()

# 1) macOS -- codesign + notarytool (xcrun) exist only here.
if [[ "$(uname -s)" != "Darwin" ]]; then
  missing+=("not macOS -- codesign/notarytool only run on a Mac home base")
else
  command -v codesign >/dev/null 2>&1 || missing+=("codesign not found")
  command -v xcrun >/dev/null 2>&1    || missing+=("xcrun (notarytool) not found")
  command -v security >/dev/null 2>&1 || missing+=("security (keychain) not found")
fi

# 2) A Developer ID codesigning identity in a headless-unlockable keychain. Unlock
#    it from signing.kcpass first (the same preamble headless-sign-context.sh uses)
#    so the check reflects what a headless release would actually see -- an
#    identity that only appears after an interactive unlock does NOT qualify.
if [[ "$(uname -s)" == "Darwin" ]] && command -v security >/dev/null 2>&1; then
  SUPPORT="$HOME/Library/Application Support/rush"
  if [[ -f "$SUPPORT/signing.kcpass" ]]; then
    security unlock-keychain -p "$(cat "$SUPPORT/signing.kcpass")" rush-signing.keychain-db >/dev/null 2>&1 || true
  else
    missing+=("no signing.kcpass -- the signing keychain cannot be unlocked headlessly")
  fi
  if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
    missing+=("no 'Developer ID Application' codesigning identity reachable in a headless-unlockable keychain")
  fi
fi

# 3) The secrets bundles the privileged phase resolves on the home base. Export
#    the passphrase from secrets.pass (the headless secrets context) so the list
#    reflects the headless run, not an unlocked-by-a-human session.
SUPPORT="$HOME/Library/Application Support/rush"
[[ -f "$SUPPORT/secrets.pass" ]] && export AGENTS_SECRETS_PASSPHRASE="$(cat "$SUPPORT/secrets.pass")"
if command -v agents >/dev/null 2>&1; then
  bundles="$(agents secrets list 2>/dev/null || true)"
  printf '%s\n' "$bundles" | grep -qw "apple.com" || missing+=("no 'apple.com' secrets bundle -- notarytool creds")
  printf '%s\n' "$bundles" | grep -qw "npmjs.com" || missing+=("no 'npmjs.com' secrets bundle -- npm publish token")
else
  missing+=("agents CLI not on PATH -- cannot resolve the apple.com/npmjs.com secrets bundles")
fi

if [[ "${#missing[@]}" -ne 0 ]]; then
  for m in "${missing[@]}"; do printf 'MISSING: %s\n' "$m" >&2; done
  exit 1
fi
echo OK
