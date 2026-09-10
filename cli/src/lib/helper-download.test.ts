import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  EXPECTED_TEAM_ID,
  HELPER_RELEASE_REPO,
  checkDesignatedRequirement,
  helperAssetUrls,
  helperCacheDir,
  parseTeamId,
  type HelperSpec,
} from './helper-download.js';
import { parseSha256Asset, sha256File } from './sha256-asset.js';
import {
  MENUBAR_HELPER_ASSET,
  MENUBAR_HELPER_APP_NAME,
  MENUBAR_HELPER_BUNDLE_ID,
  MENUBAR_HELPER_SPEC,
  menubarHelperAssetUrls,
  menubarHelperCacheDir,
} from './menubar/download-menubar.js';
import { getCacheDir } from './state.js';

// A stand-in for either real helper spec; the shared URL/cache primitives are
// spec-driven, so this proves them without pulling in a network call.
const SAMPLE_SPEC: HelperSpec = {
  helper: 'menubar',
  assetName: 'MenubarHelper.app.zip',
  appName: 'MenubarHelper.app',
  cacheSubdir: ['menubar', 'mac-helper'],
  expectedTeamId: EXPECTED_TEAM_ID,
  expectedBundleId: 'com.phnx-labs.agents-menubar',
  localBuildHint: 'scripts/stage-menubar-helper.sh',
};

describe('menu-bar helper release-asset URLs', () => {
  it("builds asset URLs pinned to the HELPER's own tag, not the CLI's", () => {
    // The version here is a HELPER version. Keying these URLs to the CLI tag is
    // what forced every CLI release to re-stage every helper asset, and made a
    // helper fix unreachable without one — see lib/helper-versions.ts.
    const u = menubarHelperAssetUrls('1.0.0');
    expect(u.zip).toBe(
      'https://github.com/phnx-labs/agi-cli/releases/download/menubar/v1.0.0/MenubarHelper.app.zip',
    );
    expect(u.sha256).toBe(`${u.zip}.sha256`);
    // A bare `v<n>` tag here would be the old coupling coming back.
    expect(u.zip).not.toMatch(/download\/v\d/);
  });

  it('names the asset + bundle exactly what release upload + download expect (drift guard)', () => {
    // release.sh stages MenubarHelper.app.zip from bin/MenubarHelper.app; the
    // client URL and extracted dir must match those names byte-for-byte.
    expect(MENUBAR_HELPER_ASSET).toBe('MenubarHelper.app.zip');
    expect(MENUBAR_HELPER_APP_NAME).toBe('MenubarHelper.app');
    expect(MENUBAR_HELPER_ASSET).toBe(`${MENUBAR_HELPER_APP_NAME}.zip`);
  });

  it('caches under ~/.agents/.cache/menubar/mac-helper/v<version>', () => {
    expect(menubarHelperCacheDir('9.9.9')).toBe(
      path.join(getCacheDir(), 'menubar', 'mac-helper', 'v9.9.9'),
    );
  });

  it('shares the release repo + cache primitives with the generic spec', () => {
    expect(HELPER_RELEASE_REPO).toBe('phnx-labs/agi-cli');
    expect(helperAssetUrls(SAMPLE_SPEC, '1.0.0').zip).toBe(menubarHelperAssetUrls('1.0.0').zip);
    expect(helperCacheDir(SAMPLE_SPEC, '1.0.0')).toBe(menubarHelperCacheDir('1.0.0'));
  });
});

// cli/ — this file lives at cli/src/lib/, so two levels up. Resolved from
// import.meta.url, not __dirname: the package is "type": "module", so __dirname
// exists only because vite injects it, and every other test file here uses the
// ESM form.
const REPO_ROOT_FOR_PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the release repo slug is the GitHub repo, not the npm package', () => {
  // These are two different names and conflating them breaks something either
  // way. The repository was renamed agents-cli -> agi-cli; the published npm
  // package is still @phnx-labs/agents-cli. Renaming the package to match would
  // orphan every existing install, and leaving the slug on the old name means
  // signed-binary downloads resolve only through GitHub's rename redirect --
  // one re-created repo away from pointing elsewhere.
  it('uses the renamed repository, not the redirect', () => {
    expect(HELPER_RELEASE_REPO).toBe('phnx-labs/agi-cli');
    // Guard the specific regression: the pre-rename slug must not come back.
    expect(HELPER_RELEASE_REPO).not.toBe('phnx-labs/agents-cli');
  });

  it('builds asset URLs against that repo', () => {
    const { zip, sha256 } = helperAssetUrls(SAMPLE_SPEC, '1.0.0');
    for (const url of [zip, sha256]) {
      expect(url).toContain('https://github.com/phnx-labs/agi-cli/releases/download/');
      expect(url).not.toContain('phnx-labs/agents-cli');
    }
  });

  it('does not rename the npm package along with the repo', () => {
    // The package name lives in package.json and is load-bearing for every
    // installed CLI; it must NOT track the repository rename.
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT_FOR_PKG, 'package.json'), 'utf-8'),
    ) as { name: string; repository?: { url?: string } };
    expect(pkg.name).toBe('@phnx-labs/agents-cli');
    // ...while the repository metadata SHOULD track it.
    expect(pkg.repository?.url ?? '').toContain('phnx-labs/agi-cli');
  });
});

describe('helper spec verification policy', () => {
  it('pins the menu-bar helper to the DR bundle id + Developer ID Team', () => {
    expect(MENUBAR_HELPER_SPEC.expectedBundleId).toBe('com.phnx-labs.agents-menubar');
    expect(MENUBAR_HELPER_BUNDLE_ID).toBe('com.phnx-labs.agents-menubar');
    expect(MENUBAR_HELPER_SPEC.expectedTeamId).toBe('2HTP252L87');
    expect(EXPECTED_TEAM_ID).toBe('2HTP252L87');
  });
});

describe('checkDesignatedRequirement (the menu-bar DR pin)', () => {
  // A real Developer-ID designated requirement as `codesign -d --requirements -`
  // emits it — the same string shape scripts/verify-menubar-helper.sh greps.
  const validReq =
    'designated => identifier "com.phnx-labs.agents-menubar" and anchor apple generic ' +
    'and certificate leaf[subject.OU] = "2HTP252L87"';

  it('accepts a requirement that pins both the bundle id and the Team', () => {
    expect(checkDesignatedRequirement(validReq, 'com.phnx-labs.agents-menubar', '2HTP252L87')).toBeNull();
  });

  it('rejects a requirement pinning a DIFFERENT bundle id (grant-revoking substitution)', () => {
    const wrongId =
      'designated => identifier "com.evil.impostor" and anchor apple generic ' +
      'and certificate leaf[subject.OU] = "2HTP252L87"';
    const err = checkDesignatedRequirement(wrongId, 'com.phnx-labs.agents-menubar', '2HTP252L87');
    expect(err).toBeTruthy();
    expect(err).toContain('does not pin bundle id "com.phnx-labs.agents-menubar"');
  });

  it('rejects a requirement pinning a DIFFERENT Team (wrong signer)', () => {
    const wrongTeam =
      'designated => identifier "com.phnx-labs.agents-menubar" and anchor apple generic ' +
      'and certificate leaf[subject.OU] = "AAAAAAAAAA"';
    const err = checkDesignatedRequirement(wrongTeam, 'com.phnx-labs.agents-menubar', '2HTP252L87');
    expect(err).toBeTruthy();
    expect(err).toContain('does not pin Developer ID Team 2HTP252L87');
  });

  it('rejects an empty/unreadable requirement (ad-hoc or missing DR) loud, not silent', () => {
    const err = checkDesignatedRequirement('', 'com.phnx-labs.agents-menubar', '2HTP252L87');
    expect(err).toBeTruthy();
    expect(err).toContain('<none>');
  });
});

describe('parseTeamId (re-exported for both helpers)', () => {
  it('extracts the Team ID from real codesign -dv output', () => {
    expect(parseTeamId('TeamIdentifier=2HTP252L87\n')).toBe('2HTP252L87');
  });
  it('returns null for ad-hoc / unsigned / empty', () => {
    expect(parseTeamId('TeamIdentifier=not set')).toBeNull();
    expect(parseTeamId('')).toBeNull();
  });
});

describe('download sha256 gate (real hash + parse used in downloadHelperApp)', () => {
  it('a wrong published .sha256 does NOT equal the real bytes -> the download rejects', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-dl-'));
    const file = path.join(dir, 'MenubarHelper.app.zip');
    fs.writeFileSync(file, 'not the signed bundle');
    try {
      const actual = await sha256File(file);
      // The exact comparison downloadHelperApp makes: expected (from the .sha256
      // asset) vs actual (streamed hash of the downloaded bytes).
      const bogusPublished = `${'0'.repeat(64)}  MenubarHelper.app.zip`;
      const expected = parseSha256Asset(bogusPublished);
      expect(actual).not.toBe(expected); // -> "sha256 mismatch" throw, before extraction
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a malformed .sha256 asset fails loud (never a silent accept)', () => {
    expect(() => parseSha256Asset('garbage, not a digest')).toThrow(/malformed .sha256/);
  });
});

// RUSH-3113 regression. `helper-download.ts` must be importable as the FIRST
// local module in a fresh process. It used to reach `computer/ssh-tunnel.ts`
// for two sha256 helpers, and that graph ran through the (now-removed, PHNX-3989)
// in-repo secrets engine's own keychain-helper downloader, which imported back
// into this module while it was still evaluating — before `EXPECTED_TEAM_ID`
// (line 30) is bound. Every entry point that reached helper-download first died
// with `ReferenceError: Cannot access 'EXPECTED_TEAM_ID' before initialization`,
// taking drift-sync and self-heal's real-subprocess tests down with it.
//
// A SUBPROCESS is the only faithful reproduction: inside vitest the module
// registry is usually already warm, so the cycle does not re-trigger. Fails on
// the parent commit, passes here.
describe('module-init cycle (RUSH-3113)', () => {
  it('imports standalone in a fresh process without a TDZ error', () => {
    const mod = path.resolve(process.cwd(), 'src/lib/helper-download.ts');
    const out = execFileSync(
      'bun',
      ['-e', `const m = await import(${JSON.stringify(mod)}); console.log(m.EXPECTED_TEAM_ID);`],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(out.trim()).toBe(EXPECTED_TEAM_ID);
  });
});
