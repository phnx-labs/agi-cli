#!/usr/bin/env bash
#
# Bundle gate for the macOS menu-bar helper staged at bin/MenubarHelper.app.
#
# The bundle is the PUBLISHED AGI Menu release (source: phnx-labs/agi-menu),
# put in place by scripts/stage-menubar-helper.sh, which runs this gate after
# extraction; scripts/remote-sign-mac.sh pulls the same staged bundle back from
# the home base. The tarball has not shipped the bundle since RUSH-3100, so this
# is no longer a prepack gate -- it is what proves a staged bundle is the real,
# shippable helper and not a stale or dev artifact.
#
# We don't pin a sha: every helper release is a freshly signed bundle, so a
# pinned sha would false-positive on every release. Presence + a valid signature
# + a stapled notarization ticket catches the real failure modes (a missing or
# corrupt bundle, or an un-notarized cut Gatekeeper rejects as "damaged").
#
# This gate MUST hold on both platforms with no soft-skip: a Linux box can stage
# (--fetch-only) and inspect the bundle too, and a silent no-op off-Mac is
# exactly what let 1.22.44 ship broken (RUSH-3031, see below).

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

  # The Accessibility (TCC) grant survives upgrades ONLY because macOS re-validates
  # each new version against the DESIGNATED REQUIREMENT stored with the grant, not
  # the exact CDHash — and this helper's requirement is identity+team based
  # (`identifier "com.phnx-labs.agents-menubar" … certificate leaf[subject.OU] =
  # "2HTP252L87"`), which every re-signed, re-notarized release still satisfies. If
  # a signing change ever produced a requirement that DIDN'T (a wrong/absent Team
  # ID, an ad-hoc signature, a CDHash-pinned DR), macOS would revoke every user's
  # grant and re-prompt them for Accessibility on the next paste. That is a
  # fleet-wide, silent, per-user regression — so pin it here and fail the release
  # rather than ship it. (macOS-only: reading the requirement needs codesign; the
  # helper is always Developer-ID signed on a Mac, which is where this must hold.)
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

# Require the staged executable to be a universal (fat) Mach-O binary.
# agi-menu's release build always lipo's arm64+x86_64 together (a THIN
# single-arch build is a debug/dev artifact). RUSH-3031's shipped 1.22.44 binary was
# Dev-ID signed but thin (CodeDirectory hashes=47 vs the correct universal
# build's hashes=390) — a dev slice packed in place of a real release build.
# The Mach-O fat header's magic bytes (0xCAFEBABE / 0xCAFEBABF, `lipo -create`
# always writes them big-endian) are plain bytes on disk — checkable with
# `od` on any OS, so this hard-fails on a Linux packing box too.
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

# Require a stapled notarization ticket. agi-menu's build notarizes + staples
# every Developer-ID build; the ticket is a file inside the bundle, so it
# survives the zip round-trip. Refuse an un-notarized helper — Gatekeeper
# rejects it as "damaged" on macOS 26+, and the install path has no re-sign
# fallback to paper over it.
if command -v xcrun >/dev/null 2>&1; then
  if ! xcrun stapler validate "$APP" >/dev/null 2>&1; then
    echo "menubar helper is not notarized/stapled: $APP" >&2
    echo "Re-stage the published bundle (scripts/stage-menubar-helper.sh); if the published" >&2
    echo "release itself is unstapled, cut a new one from phnx-labs/agi-menu:" >&2
    echo "  agents secrets exec apple.com -- scripts/release.sh <x.y.z>   (in agi-menu)" >&2
    exit 1
  fi
else
  # No xcrun (a Linux producer, RUSH-3026). `stapler staple` writes the ticket
  # as a plain file at Contents/CodeResources, so its ABSENCE is provable
  # anywhere -- and exactly what let 1.22.44 ship an un-stapled helper that
  # Gatekeeper rejected on every Mac ("not notarized/valid; skipping launch"),
  # killing the menu bar. Presence is weaker than `stapler validate` (it cannot
  # prove the ticket matches this binary), but it turns the observed failure --
  # a dev bundle with no ticket at all -- into a hard pack error instead of a
  # shipped regression.
  if [ ! -f "$APP/Contents/CodeResources" ]; then
    echo "menubar helper has NO stapled notarization ticket (Contents/CodeResources missing): $APP" >&2
    echo "This is what shipped broken in 1.22.44 -- Gatekeeper rejects the bundle on every Mac." >&2
    echo "Stage the published, notarized bundle on a Mac: scripts/stage-menubar-helper.sh" >&2
    exit 1
  fi
fi

echo "menubar helper present, signed, notarized, and universal: $APP"
