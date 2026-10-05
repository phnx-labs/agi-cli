/** On-demand download and verification of the macOS menu-bar helper: a signed, notarized .app zip
 * on its own `menubar/v<x.y.z>` tag (helper-versions.ts). Unlike ComputerHelper it pins the
 * designated requirement, since macOS keys the Accessibility grant to it. */

import { EXPECTED_TEAM_ID, type HelperSpec, downloadHelperApp, helperAssetUrls, helperCacheDir } from '../helper-download.js';
import { helperFloor } from '../helper-versions.js';

export const MENUBAR_HELPER_ASSET = 'MenubarHelper.app.zip';
export const MENUBAR_HELPER_APP_NAME = 'MenubarHelper.app';
export const MENUBAR_HELPER_BUNDLE_ID = 'com.phnx-labs.agents-menubar';

// Bundle ID plus Team designated requirement both preserve TCC identity and reject impostors.
export const MENUBAR_HELPER_SPEC: HelperSpec = {
  helper: 'menubar',
  assetName: MENUBAR_HELPER_ASSET,
  appName: MENUBAR_HELPER_APP_NAME,
  cacheSubdir: ['menubar', 'mac-helper'],
  expectedTeamId: EXPECTED_TEAM_ID,
  expectedBundleId: MENUBAR_HELPER_BUNDLE_ID,
  localBuildHint: 'scripts/stage-menubar-helper.sh (stages the published menubar/v<floor> asset into bin/MenubarHelper.app; source: https://github.com/phnx-labs/agi-menu)',
};

export function menubarHelperAssetUrls(version: string): { zip: string; sha256: string } {
  return helperAssetUrls(MENUBAR_HELPER_SPEC, version);
}

export function menubarHelperCacheDir(version: string): string {
  return helperCacheDir(MENUBAR_HELPER_SPEC, version);
}

/** Downloads the helper asset for `version`, verifies sha256 + signature + DR pin, and returns the
 * extracted `MenubarHelper.app` path in the cache. A missing asset is a hard error naming the tag. */
export function downloadMenubarHelperApp(version: string): Promise<string> {
  return downloadHelperApp(MENUBAR_HELPER_SPEC, version);
}
