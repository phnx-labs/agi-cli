#!/usr/bin/env bash
# Is this box a fully provisioned signing home base? Probe for a Developer ID identity in a
# headless-unlockable keychain plus the `apple.com` and `npmjs.com` secrets bundles, catching
# RUSH-2535 on an unprovisioned `--device` fallback. Read-only.

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

# A Developer ID codesigning identity in a headless-unlockable keychain. Unlock it from
# signing.kcpass first (as headless-sign-context.sh does), since an identity that appears only
# after an interactive unlock does not qualify.
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
