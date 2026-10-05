#!/usr/bin/env bash
# Source this only inside the home-base release subprocess: it unlocks the
# signing keychain and exports the secrets passphrase for that process tree.
# It does not copy either credential or persist them into configuration.
set -euo pipefail

_RUSH_SUPPORT="$HOME/Library/Application Support/rush"

if [[ -f "$_RUSH_SUPPORT/signing.kcpass" ]]; then
  _kcpass="$(cat "$_RUSH_SUPPORT/signing.kcpass")"
  security unlock-keychain -p "$_kcpass" rush-signing.keychain-db
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$_kcpass" \
    rush-signing.keychain-db >/dev/null 2>&1 || true
  unset _kcpass
fi
if [[ -f "$_RUSH_SUPPORT/secrets.pass" ]]; then
  AGENTS_SECRETS_PASSPHRASE="$(cat "$_RUSH_SUPPORT/secrets.pass")"
  export AGENTS_SECRETS_PASSPHRASE
fi
