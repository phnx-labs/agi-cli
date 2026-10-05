import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { copyAppBundle, withInstallLock } from './app-bundle-install.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'app-bundle-install-'));
}

function makeBundle(root: string, marker: string): string {
  const app = path.join(root, 'Helper.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'Helper'), marker);
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<plist>${marker}</plist>`);
  return app;
}

function readMarker(app: string): string {
  return fs.readFileSync(path.join(app, 'Contents', 'MacOS', 'Helper'), 'utf-8');
}

function leftovers(dest: string): string[] {
  return fs
    .readdirSync(path.dirname(dest))
    .filter((n) => n.includes('.installing') || n.includes('.replaced'));
}

describe('copyAppBundle: atomic install', () => {
  it('copies a bundle completely into a fresh destination, leaving no staging artifacts', () => {
    const dir = tmpDir();
    const src = makeBundle(path.join(dir, 'src'), 'v1');
    const dest = path.join(dir, 'installed', 'Helper.app');

    copyAppBundle(src, dest);

    expect(fs.existsSync(dest)).toBe(true);
    expect(readMarker(dest)).toBe('v1');
    expect(fs.readFileSync(path.join(dest, 'Contents', 'Info.plist'), 'utf-8')).toBe('<plist>v1</plist>');
    expect(leftovers(dest)).toEqual([]);
  });

  it('replaces an existing bundle atomically with no half-written state or leftovers', () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'installed', 'Helper.app');
    copyAppBundle(makeBundle(path.join(dir, 'old'), 'v1'), dest);
    expect(readMarker(dest)).toBe('v1');

    copyAppBundle(makeBundle(path.join(dir, 'new'), 'v2'), dest);

    expect(readMarker(dest)).toBe('v2');
    expect(leftovers(dest)).toEqual([]);
  });

  it('a failed copy leaves the existing installed bundle intact (never rm-then-cp)', () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'installed', 'Helper.app');
    copyAppBundle(makeBundle(path.join(dir, 'good'), 'v1'), dest);
    expect(readMarker(dest)).toBe('v1');

    const missingSrc = path.join(dir, 'does-not-exist', 'Helper.app');
    expect(() => copyAppBundle(missingSrc, dest)).toThrow();

    expect(fs.existsSync(dest)).toBe(true);
    expect(readMarker(dest)).toBe('v1');
    expect(leftovers(dest)).toEqual([]);
  });

  it('rolls back to the original bundle when the swap-into-place rename fails', () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'installed', 'Helper.app');
    copyAppBundle(makeBundle(path.join(dir, 'good'), 'v1'), dest);
    expect(readMarker(dest)).toBe('v1');

    const failingRename = (from: string, to: string): void => {
      if (from.includes('.installing')) throw new Error('injected: swap failed');
      fs.renameSync(from, to);
    };
    expect(() =>
      copyAppBundle(makeBundle(path.join(dir, 'new'), 'v2'), dest, { renameSync: failingRename }),
    ).toThrow(/injected/);

    expect(fs.existsSync(dest)).toBe(true);
    expect(readMarker(dest)).toBe('v1');
    expect(leftovers(dest)).toEqual([]);
  });
});

describe('withInstallLock: serialization', () => {
  it('runs the install body once and releases the lock', () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'Helper.app');
    let ran = 0;
    withInstallLock(dest, () => {
      ran += 1;
      expect(fs.existsSync(`${dest}.install-lock.lock`)).toBe(true);
    });
    expect(ran).toBe(1);
    expect(fs.existsSync(`${dest}.install-lock.lock`)).toBe(false);
  });

  it('releases the lock even when the install body throws', () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'Helper.app');
    expect(() =>
      withInstallLock(dest, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(fs.existsSync(`${dest}.install-lock.lock`)).toBe(false);
  });
});
