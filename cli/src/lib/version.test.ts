import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getCliVersion, installLayoutFromBin } from './version.js';

describe('version', () => {
  it('getCliVersion returns a non-empty version string', () => {
    const v = getCliVersion();
    expect(typeof v).toBe('string');
    expect(v.length).toBeGreaterThan(0);
  });

  // getCliVersionFresh re-reads package.json each call, unlike memoized getCliVersion, but had no
  // honest test (same hardcoded path). RUSH-2862 added an optional path param so a test can swap
  // the file.
  it('getCliVersionFresh follows an on-disk change; getCliVersion stays memoized (RUSH-2862)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-version-test-'));
    const pkgJsonPath = path.join(dir, 'package.json');
    fs.writeFileSync(pkgJsonPath, JSON.stringify({ version: '1.0.0-fixture-a' }));

    try {
      // cached is module-level state, so get an unshared module instance —
      // otherwise the static import above (already exercised by the previous
      // test) has already memoized the real repo version.
      vi.resetModules();
      const mod = await import('./version.js');

      // Prime the memo from the fixture at version A.
      expect(mod.getCliVersion(pkgJsonPath)).toBe('1.0.0-fixture-a');

      // Mutate the fixture package.json on disk to version B.
      fs.writeFileSync(pkgJsonPath, JSON.stringify({ version: '2.0.0-fixture-b' }));

      // Fresh MUST re-read and follow the on-disk change...
      expect(mod.getCliVersionFresh(pkgJsonPath)).toBe('2.0.0-fixture-b');
      // ...while the memoized getter MUST stay at whatever it cached first,
      // proving the two are genuinely distinct reads, not one hop apart.
      expect(mod.getCliVersion(pkgJsonPath)).toBe('1.0.0-fixture-a');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Regression guard for the Bun single-file binary: `import.meta.url` is a virtual `/$bunfs/` path,
// so resolution falls back to the install found via the `agents` launcher symlink. Locks the
// dirname chain.
describe('installLayoutFromBin', () => {
  it('derives dist/, entry, and package.json from an nvm launcher path', () => {
    const bin =
      '/Users/me/.nvm/versions/node/v24.15.0/lib/node_modules/@phnx-labs/agents-cli/dist/bin/agents';
    const pkg = '/Users/me/.nvm/versions/node/v24.15.0/lib/node_modules/@phnx-labs/agents-cli';
    // distDir rides path.dirname, which preserves the input's separators, but
    // entry/pkgJson ride path.join, which emits native ones — so derive the
    // expectations the same way rather than hardcoding POSIX.
    expect(installLayoutFromBin(bin)).toEqual({
      distDir: `${pkg}/dist`,
      entryPath: path.join(`${pkg}/dist`, 'index.js'),
      pkgJsonPath: path.join(`${pkg}/dist`, '..', 'package.json'),
    });
  });

  it('derives the layout from a bun-global launcher path', () => {
    const bin = '/Users/me/.bun/install/global/node_modules/@phnx-labs/agents-cli/dist/bin/agents';
    const pkg = '/Users/me/.bun/install/global/node_modules/@phnx-labs/agents-cli';
    expect(installLayoutFromBin(bin)).toEqual({
      distDir: `${pkg}/dist`,
      entryPath: path.join(`${pkg}/dist`, 'index.js'),
      pkgJsonPath: path.join(`${pkg}/dist`, '..', 'package.json'),
    });
  });
});
