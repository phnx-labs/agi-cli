/**
 * On-demand download + verification of the macOS menu-bar helper
 * ("MenubarHelper.app").
 *
 * Mirrors the ComputerHelper download model (`../computer/download.ts`): the
 * helper ships as a signed + notarized `.app` zipped as a GitHub release asset
 * on the helper's own `menubar/v<x.y.z>` tag, NOT the CLI's tag (see
 * `helper-versions.ts`). A fresh `npm i -g` machine whose tarball lacks a
 * bundled copy fetches the asset for the pinned helper version, verifies its
 * sha256 + code signature before install.
 *
 * The one difference — and the reason this is not the ComputerHelper spec — is
 * the DESIGNATED-REQUIREMENT pin. macOS keys the menu bar's Accessibility (TCC)
 * grant to the bundle's designated requirement (bundle id
 * `com.phnx-labs.agents-menubar` + Developer ID Team `2HTP252L87`), and
 * re-validates each new version against it. A downloaded bundle whose DR drops
 * either pin would silently revoke the user's grant, so `MENUBAR_HELPER_SPEC`
 * sets `expectedBundleId` and the shared `verifyHelperApp` enforces the DR
 * before the bundle is ever installed. This matches the release-time gate in
 * `scripts/verify-menubar-helper.sh`.
 */

import {
  EXPECTED_TEAM_ID,
  type HelperSpec,
  downloadHelperApp,
  helperAssetUrls,
  helperCacheDir,
  verifyHelperApp,
} from '../helper-download.js';
import { helperFloor } from '../helper-versions.js';

/** The zipped `.app` release asset name. */
export const MENUBAR_HELPER_ASSET = 'MenubarHelper.app.zip';
/** The bundle directory name once extracted. */
export const MENUBAR_HELPER_APP_NAME = 'MenubarHelper.app';
/** The bundle id the Accessibility grant (and thus the designated requirement)
 *  is keyed to — the same value `install-menubar.ts`'s `SERVICE_LABEL_BASE` and
 *  `scripts/verify-menubar-helper.sh` pin. */
export const MENUBAR_HELPER_BUNDLE_ID = 'com.phnx-labs.agents-menubar';

/** MenubarHelper identity + verification policy — DR-pinned (see docblock). */
export const MENUBAR_HELPER_SPEC: HelperSpec = {
  helper: 'menubar',
  assetName: MENUBAR_HELPER_ASSET,
  appName: MENUBAR_HELPER_APP_NAME,
  cacheSubdir: ['menubar', 'mac-helper'],
  expectedTeamId: EXPECTED_TEAM_ID,
  expectedBundleId: MENUBAR_HELPER_BUNDLE_ID,
  // No local build exists in this repo: the source is phnx-labs/agi-menu. The
  // staging script downloads + verifies the same published asset into
  // bin/MenubarHelper.app, which the installer resolves from a checkout.
  localBuildHint: 'scripts/stage-menubar-helper.sh (stages the published menubar/v<floor> asset into bin/MenubarHelper.app; source: https://github.com/phnx-labs/agi-menu)',
};

/** Release-asset URLs for the menu-bar helper zip + its checksum at `v<version>`. */
export function menubarHelperAssetUrls(version: string): { zip: string; sha256: string } {
  return helperAssetUrls(MENUBAR_HELPER_SPEC, version);
}

/** Cache dir for the downloaded menu-bar helper, one subdir per release tag. */
export function menubarHelperCacheDir(version: string): string {
  return helperCacheDir(MENUBAR_HELPER_SPEC, version);
}

/** Verify a menu-bar helper `.app`: codesign + Team + DR pin + notarization. */
export function verifyMenubarHelper(appPath: string): void {
  verifyHelperApp(appPath, MENUBAR_HELPER_SPEC);
}

/**
 * Download the menu-bar helper release asset for `version`, verify sha256 +
 * signature + DR pin, and return the path to the extracted `MenubarHelper.app`
 * in the cache. A missing asset is a hard error naming the exact tag.
 */
export function downloadMenubarHelperApp(version: string): Promise<string> {
  return downloadHelperApp(MENUBAR_HELPER_SPEC, version);
}
