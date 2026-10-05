/** Addressing a frozen installation: guards against silently picking the wrong install. Once two
 * installations can carry one release, and a label and a release can disagree, `resolve
 * <agent>@<something>` has no obvious single answer and must say so rather than guess. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let home: string;

async function load() {
  vi.resetModules();
  return {
    resolve: await import('./resolve.js'),
    store: await import('./store.js'),
    versions: await import('./versions.js'),
  };
}

function makeVersionDir(label: string, agent = 'claude'): string {
  const dir = path.join(home, '.agents', '.history', 'versions', agent, label);
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  return dir;
}

describe('resolveInstallation', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-resolve-'));
    process.env.HOME = home;
    // getGlobalDefault reads pins via AGENTS_DEVICES_DIR (fork-wide in setup.ts).
    // Scope pins to this home so a prior setGlobalDefault cannot leak a pin into
    // "no default refuses to pick".
    process.env.AGENTS_DEVICES_DIR = path.join(home, '.agents', '.history', 'devices');
    process.env.AGENTS_SYNC_MACHINE_ID = 'resolve-testbox';
  });

  afterEach(() => {
    delete process.env.HOME;
    delete process.env.AGENTS_DEVICES_DIR;
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('matches the frozen label even after the release moved past it', async () => {
    const { resolve, store } = await load();
    makeVersionDir('2.0.65');
    store.recordRelease(store.createInstallation('claude', '2.0.65', '2.0.65'), '2.1.220');

    const found = await resolve.resolveInstallation('claude', '2.0.65');
    expect(found.label).toBe('2.0.65');
    expect(found.releaseVersion).toBe('2.1.220');
    expect(resolve.describeInstallation(found)).toBe('2.0.65 (release 2.1.220)');
  });

  it('also matches the release the installation currently carries', async () => {
    const { resolve, store } = await load();
    makeVersionDir('2.0.65');
    store.recordRelease(store.createInstallation('claude', '2.0.65', '2.0.65'), '2.1.220');

    expect((await resolve.resolveInstallation('claude', '2.1.220')).label).toBe('2.0.65');
  });

  it('prefers a label hit over another installation that happens to carry it as a release', async () => {
    const { resolve, store } = await load();
    makeVersionDir('2.0.65');
    makeVersionDir('1.0.0');
    store.createInstallation('claude', '2.0.65', '2.0.65');
    // A second install whose RELEASE is 2.0.65 while its label is 1.0.0.
    store.recordRelease(store.createInstallation('claude', '1.0.0', '1.0.0'), '2.0.65');

    // The label is a directory name, so it is unique and decisive.
    expect((await resolve.resolveInstallation('claude', '2.0.65')).label).toBe('2.0.65');
  });

  it('refuses to guess between duplicate installations of the same release', async () => {
    const { resolve, store } = await load();
    makeVersionDir('a1.0.0');
    makeVersionDir('b1.0.0');
    store.recordRelease(store.createInstallation('claude', 'a1.0.0', 'a1.0.0'), '2.0.65');
    store.recordRelease(store.createInstallation('claude', 'b1.0.0', 'b1.0.0'), '2.0.65');

    await expect(resolve.resolveInstallation('claude', '2.0.65')).rejects.toThrow(
      /matches 2 .* installations/
    );
    await expect(resolve.resolveInstallation('claude', '2.0.65')).rejects.toThrow(/installation label/);
  });

  it('with no selector takes the sole installation', async () => {
    const { resolve, store } = await load();
    makeVersionDir('2.0.65');
    store.createInstallation('claude', '2.0.65', '2.0.65');

    expect((await resolve.resolveInstallation('claude', undefined)).label).toBe('2.0.65');
  });

  it('with no selector takes the pinned default rather than the newest install', async () => {
    const { resolve, store, versions } = await load();
    makeVersionDir('2.0.65');
    makeVersionDir('2.1.220');
    store.createInstallation('claude', '2.0.65', '2.0.65');
    store.createInstallation('claude', '2.1.220', '2.1.220');
    versions.setGlobalDefault('claude', '2.0.65');

    expect((await resolve.resolveInstallation('claude', undefined)).label).toBe('2.0.65');
  });

  it('with no selector and no default refuses to pick for the user', async () => {
    const { resolve, store } = await load();
    makeVersionDir('2.0.65');
    makeVersionDir('2.1.220');
    store.createInstallation('claude', '2.0.65', '2.0.65');
    store.createInstallation('claude', '2.1.220', '2.1.220');

    await expect(resolve.resolveInstallation('claude', undefined)).rejects.toThrow(/matches 2/);
  });

  it('names what is installed when nothing matches', async () => {
    const { resolve, store } = await load();
    makeVersionDir('2.0.65');
    store.createInstallation('claude', '2.0.65', '2.0.65');

    await expect(resolve.resolveInstallation('claude', '3.0.0')).rejects.toThrow(/Installed: 2\.0\.65/);
  });

  it('reports no installations rather than an empty match', async () => {
    const { resolve } = await load();
    await expect(resolve.resolveInstallation('claude', '2.0.65')).rejects.toThrow(/agents add claude\b/);
  });
});
