import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Drives the REAL viewer policy against a real device-config store under a temp
// HOME. Profile DECLARATIONS and viewer suitability (Arc/Firefox/launchable) are
// the standalone `browser` CLI's now (PHNX-4101); agents-cli's `resolveViewer`
// only resolves the viewer NAME from config, then `showUrl` delegates the actual
// open to `browser show`. Nothing here spawns a browser or an OS opener: the OS
// branch goes through the injected `spawnOpen`, and the `browser show` branch is
// forced to fail (a nonexistent BROWSER_BIN) so it deterministically falls back.

let testHome = '';

async function fresh() {
  vi.resetModules();
  const openUrl = await import('./open-url.js');
  const config = await import('./device-config.js');
  return { ...openUrl, ...config };
}

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-viewer-'));
  process.env.HOME = testHome;
  process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
});

afterEach(() => {
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  delete process.env.BROWSER_BIN;
  vi.restoreAllMocks();
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('resolveViewer', () => {
  it('falls back to the OS handler when no viewer is configured at all', async () => {
    const { resolveViewer } = await fresh();
    expect(await resolveViewer()).toBe('os');
  });

  it('follows browser.profile when browser.viewer is unset — the whole point', async () => {
    // The original bug: a machine with a configured browser still leaked every
    // artifact to the OS handler. Unset viewer must mean "the profile agents drive".
    const { setConfigValue, resolveViewer } = await fresh();
    setConfigValue('browser.profile', 'work');
    expect(await resolveViewer()).toEqual({ profile: 'work' });
  });

  it('browser.viewer overrides browser.profile', async () => {
    const { setConfigValue, resolveViewer } = await fresh();
    setConfigValue('browser.profile', 'work');
    setConfigValue('browser.viewer', 'reading');
    expect(await resolveViewer()).toEqual({ profile: 'reading' });
  });

  it('browser.viewer=os opts out entirely', async () => {
    const { setConfigValue, resolveViewer } = await fresh();
    setConfigValue('browser.profile', 'work');
    setConfigValue('browser.viewer', 'os');
    expect(await resolveViewer()).toBe('os');
  });

  it('an explicit profile option beats configured keys', async () => {
    const { setConfigValue, resolveViewer } = await fresh();
    setConfigValue('browser.viewer', 'work');
    expect(await resolveViewer({ profile: 'chosen' })).toEqual({ profile: 'chosen' });
  });

  it('the osBrowser option beats a configured viewer', async () => {
    // If this ever stops winning, a caller that explicitly asked for the user's
    // own browser silently gets the agent profile instead.
    const { setConfigValue, resolveViewer } = await fresh();
    setConfigValue('browser.viewer', 'work');
    expect(await resolveViewer({ osBrowser: true })).toBe('os');
  });
});

describe('showFile — which kinds a browser tab is right for', () => {
  const opened: string[][] = [];
  const spawnOpen = (cmd: string, args: string[]) => {
    opened.push([cmd, ...args]);
    return true;
  };

  beforeEach(() => {
    opened.length = 0;
    // Force the `browser show` delegation to FAIL deterministically so the viewer
    // branch always falls back to the OS handler in the test — resolvable (so
    // browserInstalled() is true) but not spawnable.
    process.env.BROWSER_BIN = path.join(testHome, 'no-such-browser');
  });

  it('sends a screenshot to the OS app, not the browser viewer', async () => {
    // Preview/QuickTime are the better viewer for these; a browser tab is a
    // downgrade. BROWSER_RENDERABLE is html/htm/svg/xhtml only.
    const { setConfigValue, showFile } = await fresh();
    setConfigValue('browser.viewer', 'work');
    for (const ext of ['.png', '.jpg', '.webp', '.pdf', '.webm']) {
      const out = await showFile(`/tmp/capture${ext}`, { spawnOpen });
      expect(out.via, `${ext} should go to the OS app`).toBe('os');
    }
  });

  it('tries the viewer for an .html artifact, and says so when it cannot reach it', async () => {
    // The `browser show` attempt fails here (nonexistent BROWSER_BIN) and falls
    // back to the OS handler — that is correct, and the stderr line names the
    // profile, so it is proof the .html went to the viewer branch; a .png never
    // produces one.
    const { setConfigValue, showFile } = await fresh();
    setConfigValue('browser.viewer', 'work');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await showFile('/tmp/plan.html', { spawnOpen });
    expect(err).toHaveBeenCalledWith(expect.stringContaining('work'));

    err.mockClear();
    await showFile('/tmp/capture.png', { spawnOpen });
    expect(err).not.toHaveBeenCalled();
  });

  it('with no viewer configured, an .html still opens — via the OS handler', async () => {
    const { showFile } = await fresh();
    const out = await showFile('/tmp/plan.html', { spawnOpen });
    expect(out.via).toBe('os');
  });

  it('reports via:none when every opener fails, so the caller can print the URL', async () => {
    const { showUrl } = await fresh();
    const out = await showUrl('https://example.com', { spawnOpen: () => false });
    expect(out.via).toBe('none');
  });
});

describe('trySpawn — detection without blocking', () => {
  // Tested directly, NOT through showUrl. Driving the non-injected path meant
  // spawning the real platform opener against a real URL, so `bun run test` on
  // any Mac opened example.com in the developer's browser; on Linux CI xdg-open
  // is absent so it ENOENT'd and nobody noticed. These use binaries that exist
  // (or provably do not) and open nothing.

  it('detects a missing binary instead of reporting success', async () => {
    const { trySpawn } = await fresh();
    expect(await trySpawn('definitely-not-a-real-opener-binary', ['x'])).toBe(false);
  });

  it('resolves on spawn without waiting for the child to exit', async () => {
    const { trySpawn } = await fresh();
    const started = Date.now();
    expect(await trySpawn('/bin/sleep', ['2'])).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('reports via:none when every candidate fails, so a caller can print the URL', async () => {
    const { showUrl } = await fresh();
    const out = await showUrl('https://example.com', { spawnOpen: () => false });
    expect(out.via).toBe('none');
    expect(out.via === 'none' && out.reason).toMatch(/opener/i);
  });

  it('tries every platform candidate before giving up', async () => {
    const { showUrl } = await fresh();
    const tried: string[] = [];
    await showUrl('https://example.com', {
      spawnOpen: (cmd) => {
        tried.push(cmd);
        return false;
      },
    });
    const expected =
      process.platform === 'darwin'
        ? ['open']
        : process.platform === 'win32'
          ? ['cmd']
          : ['xdg-open', 'gnome-open'];
    expect(tried).toEqual(expected);
  });
});
