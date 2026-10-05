#!/usr/bin/env bash
# Headless signing and secrets context for the release home base (mac-mini). Single source for
# release.sh's run_home_base_phase and remote-sign-mac.sh. Usage: `.
# scripts/headless-sign-context.sh` (SOURCE it, do not exec): no Touch ID, no per-secret prompt.
set -euo pipefail

_RUSH_SUPPORT="$HOME/Library/Application Support/rush"

if [[ -f "$_RUSH_SUPPORT/signing.kcpass" ]]; then
  _kcpass="$(cat "$_RUSH_SUPPORT/signing.kcpass")"
  security unlock-keychain -p "$_kcpass" rush-signing.keychain-db
  # Authorize codesign/apple-tool to use the Developer ID key non-interactively. Without it the
  # key ACL prompts for UI approval that a headless SSH release cannot answer, and codesign fails
  # with errSecInternalComponent. Idempotent.
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$_kcpass" \
    rush-signing.keychain-db >/dev/null 2>&1 || true
  unset _kcpass
fi
if [[ -f "$_RUSH_SUPPORT/secrets.pass" ]]; then
  AGENTS_SECRETS_PASSPHRASE="$(cat "$_RUSH_SUPPORT/secrets.pass")"
  export AGENTS_SECRETS_PASSPHRASE
fi
