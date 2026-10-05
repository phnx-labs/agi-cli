/** On-demand download and verification of the macOS menu-bar helper: a signed, notarized .app zip
 * on its own `menubar/v<x.y.z>` tag (helper-versions.ts). Unlike ComputerHelper it pins the
 * designated requirement, since macOS keys the Accessibility grant to it. */

import { EXPECTED_TEAM_ID, type HelperSpec, downloadHelperApp, helperAssetUrls, helperCacheDir } from '../helper-download.js';
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

/** Downloads the helper asset for `version`, verifies sha256 + signature + DR pin, and returns the
 * extracted `MenubarHelper.app` path in the cache. A missing asset is a hard error naming the tag. */
export function downloadMenubarHelperApp(version: string): Promise<string> {
  return downloadHelperApp(MENUBAR_HELPER_SPEC, version);
}
