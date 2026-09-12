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
    // The tag is the helper's own train. A `v1.22.48`-shaped tag here would be
    // the coupling this module exists to remove.
    expect(zip).toContain('/releases/download/menubar/v1.0.0/MenubarHelper.app.zip');
    expect(sha256).toBe(`${zip}.sha256`);
    expect(zip).not.toMatch(/download\/v\d/);
  });

  it('refuses an asset name with a space — GitHub dot-normalizes it and the URL 404s forever', () => {
    // The live bug: `Agents CLI.app.zip` was uploaded and served as
    // `Agents.CLI.app.zip`, so every client request missed. The published asset
    // is now `Agents_CLI.app.zip` -- a name GitHub leaves alone.
    expect(() => helperAssetUrls(spec({ assetName: 'Agents CLI.app.zip' }), '1.0.0'))
      .toThrow(/contains a space/);
  });

  it('rejects an unknown helper rather than minting a tag that cannot exist', () => {
    expect(() => helperTag('nope' as HelperName, '1.0.0')).toThrow(/unknown helper/);
    expect(() => helperFloor('nope' as HelperName)).toThrow(/unknown helper/);
  });

  it('lists only the helpers this CLI actually distributes', () => {
    // The table must not claim a helper agents-cli no longer downloads. The
    // computer helpers left with the standalone `computer` engine (PHNX-4075),
    // which resolves and verifies its own releases -- an entry here would be a
    // lying capability table, and would put the extracted helper back on this
    // CLI's release path.
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
    // Pins the pair that broke in production: the spec's assetName and the name
    // the release actually serves must agree. `Agents CLI.app.zip` was uploaded
    // and served as `Agents.CLI.app.zip`, so the client 404'd on every attempt.
    for (const s of [MENUBAR_HELPER_SPEC]) {
      expect(s.assetName, `${s.helper} asset name`).not.toContain(' ');
      expect(() => helperAssetUrls(s, helperFloor(s.helper))).not.toThrow();
    }
  });
});
