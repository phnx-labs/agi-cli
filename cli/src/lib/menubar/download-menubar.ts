
import { EXPECTED_TEAM_ID, type HelperSpec, downloadHelperApp, helperAssetUrls, helperCacheDir } from '../helper-download.js';
import { helperFloor } from '../helper-versions.js';

export const MENUBAR_HELPER_ASSET = 'MenubarHelper.app.zip';
export const MENUBAR_HELPER_APP_NAME = 'MenubarHelper.app';
export const MENUBAR_HELPER_BUNDLE_ID = 'com.phnx-labs.agents-menubar';

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

export function downloadMenubarHelperApp(version: string): Promise<string> {
  return downloadHelperApp(MENUBAR_HELPER_SPEC, version);
}
