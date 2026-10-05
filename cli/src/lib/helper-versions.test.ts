import { describe, expect, it } from 'vitest';
import { HELPER_RELEASES, helperFloor, helperTag, type HelperName } from './helper-versions.js';
import { helperAssetUrls, type HelperSpec } from './helper-download.js';
import { MENUBAR_HELPER_SPEC } from './menubar/download-menubar.js';

const spec = (over: Partial<HelperSpec> = {}): HelperSpec => ({
  helper: 'menubar',
  assetName: 'MenubarHelper.app.zip',
  appName: 'MenubarHelper.app',
  cacheSubdir: ['menubar'],
  expectedTeamId: '2HTP252L87',
  localBuildHint: 'x',
  ...over,
});


describe('helper release tags', () => {
  it('builds a URL from the HELPER version, never the CLI version', () => {
    const { zip, sha256 } = helperAssetUrls(spec(), '1.0.0');
    expect(zip).toContain('/releases/download/menubar/v1.0.0/MenubarHelper.app.zip');
    expect(sha256).toBe(`${zip}.sha256`);
    expect(zip).not.toMatch(/download\/v\d/);
  });

  it('refuses an asset name with a space — GitHub dot-normalizes it and the URL 404s forever', () => {
    expect(() => helperAssetUrls(spec({ assetName: 'Agents CLI.app.zip' }), '1.0.0'))
      .toThrow(/contains a space/);
  });

  it('rejects an unknown helper rather than minting a tag that cannot exist', () => {
    expect(() => helperTag('nope' as HelperName, '1.0.0')).toThrow(/unknown helper/);
    expect(() => helperFloor('nope' as HelperName)).toThrow(/unknown helper/);
  });

  it('lists only the helpers this CLI actually distributes', () => {
    expect(Object.keys(HELPER_RELEASES).sort()).toEqual(['menubar']);
    expect(() => helperTag('computer-win' as HelperName, '1.0.0')).toThrow(/unknown helper/);
    expect(() => helperTag('computer-mac' as HelperName, '1.0.0')).toThrow(/unknown helper/);
  });

  it('every declared helper has a usable floor', () => {
    for (const name of Object.keys(HELPER_RELEASES) as HelperName[]) {
      expect(helperFloor(name)).toMatch(/^\d+\.\d+\.\d+$/);
      expect(helperTag(name, helperFloor(name))).toBe(`${HELPER_RELEASES[name].tagPrefix}/v${helperFloor(name)}`);
    }
  });

  it('every shipped spec names a space-free asset, and its URL resolves', () => {
    for (const s of [MENUBAR_HELPER_SPEC]) {
      expect(s.assetName, `${s.helper} asset name`).not.toContain(' ');
      expect(() => helperAssetUrls(s, helperFloor(s.helper))).not.toThrow();
    }
  });
});
