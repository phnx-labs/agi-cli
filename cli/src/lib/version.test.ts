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

  it('getCliVersionFresh follows an on-disk change; getCliVersion stays memoized (RUSH-2862)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-version-test-'));
    const pkgJsonPath = path.join(dir, 'package.json');
    fs.writeFileSync(pkgJsonPath, JSON.stringify({ version: '1.0.0-fixture-a' }));

    try {
      vi.resetModules();
      const mod = await import('./version.js');

      expect(mod.getCliVersion(pkgJsonPath)).toBe('1.0.0-fixture-a');

      fs.writeFileSync(pkgJsonPath, JSON.stringify({ version: '2.0.0-fixture-b' }));

      expect(mod.getCliVersionFresh(pkgJsonPath)).toBe('2.0.0-fixture-b');
      expect(mod.getCliVersion(pkgJsonPath)).toBe('1.0.0-fixture-a');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('installLayoutFromBin', () => {
  it('derives dist/, entry, and package.json from an nvm launcher path', () => {
    const bin =
      '/Users/me/.nvm/versions/node/v24.15.0/lib/node_modules/@phnx-labs/agents-cli/dist/bin/agents';
    const pkg = '/Users/me/.nvm/versions/node/v24.15.0/lib/node_modules/@phnx-labs/agents-cli';
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
