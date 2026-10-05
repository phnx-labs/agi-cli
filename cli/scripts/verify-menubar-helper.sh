#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."

APP="bin/MenubarHelper.app"

if [ ! -d "$APP" ]; then
  echo "menubar helper missing: $APP not found" >&2
  echo "Stage the published helper (source lives in phnx-labs/agi-menu; this repo never builds it):" >&2
  echo "  scripts/stage-menubar-helper.sh" >&2
  exit 1
fi

if command -v codesign >/dev/null 2>&1; then
  if ! codesign --verify --deep --strict "$APP" 2>/dev/null; then
    echo "menubar helper failed codesign --verify --deep --strict: $APP" >&2
    echo "Re-stage the published bundle: scripts/stage-menubar-helper.sh" >&2
    exit 1
  fi

  REQ="$(codesign -d --requirements - "$APP" 2>/dev/null || true)"
  MENUBAR_BUNDLE_ID="com.phnx-labs.agents-menubar"
  MENUBAR_TEAM_ID="2HTP252L87"
  if ! printf '%s' "$REQ" | grep -qF "identifier \"$MENUBAR_BUNDLE_ID\""; then
    echo "menubar helper designated requirement is missing the pinned bundle identifier ($MENUBAR_BUNDLE_ID): $APP" >&2
    echo "TCC keys the Accessibility grant to this requirement — a change re-prompts every user on the next paste." >&2
    echo "Requirement read: ${REQ:-<none>}" >&2
    exit 1
  fi
  if ! printf '%s' "$REQ" | grep -qF "$MENUBAR_TEAM_ID"; then
    echo "menubar helper designated requirement is missing the Developer ID team ($MENUBAR_TEAM_ID): $APP" >&2
    echo "That team is what makes the requirement stable across re-signed releases; without it every" >&2
    echo "existing Accessibility grant is invalidated and users are re-prompted. Sign with the real" >&2
    echo "Developer ID Application: … ($MENUBAR_TEAM_ID) identity (phnx-labs/agi-menu scripts/release.sh)." >&2
    echo "Requirement read: ${REQ:-<none>}" >&2
    exit 1
  fi
fi

BIN="$APP/Contents/MacOS/AGI Menu"
if [ ! -f "$BIN" ]; then
  echo "menubar helper executable missing inside bundle: $BIN" >&2
  exit 1
fi
if ! command -v od >/dev/null 2>&1; then
  echo "menubar helper gate cannot verify architecture: 'od' not found on PATH" >&2
  exit 1
fi
MAGIC="$(od -An -tx1 -N4 "$BIN" | tr -d ' \t\n')"
case "$MAGIC" in
  cafebabe|cafebabf)
    ;;
  *)
    echo "menubar helper is a THIN (single-arch) binary, not the universal build a release requires: $BIN (magic: 0x$MAGIC)" >&2
    echo "This is the other half of the RUSH-3031 incident (1.22.44 shipped a thin, dev-signed helper)." >&2
    echo "Re-stage the published bundle: scripts/stage-menubar-helper.sh" >&2
    exit 1
    ;;
esac

if command -v xcrun >/dev/null 2>&1; then
  if ! xcrun stapler validate "$APP" >/dev/null 2>&1; then
    echo "menubar helper is not notarized/stapled: $APP" >&2
    echo "Re-stage the published bundle (scripts/stage-menubar-helper.sh); if the published" >&2
    echo "release itself is unstapled, cut a new one from phnx-labs/agi-menu:" >&2
    echo "  agents secrets exec apple.com -- scripts/release.sh <x.y.z>   (in agi-menu)" >&2
    exit 1
  fi
else
  if [ ! -f "$APP/Contents/CodeResources" ]; then
    echo "menubar helper has NO stapled notarization ticket (Contents/CodeResources missing): $APP" >&2
    echo "This is what shipped broken in 1.22.44 -- Gatekeeper rejects the bundle on every Mac." >&2
    echo "Stage the published, notarized bundle on a Mac: scripts/stage-menubar-helper.sh" >&2
    exit 1
  fi
fi

echo "menubar helper present, signed, notarized, and universal: $APP"
