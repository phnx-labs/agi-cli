import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Use injected opener callbacks and inert/missing binaries; never launch the operator's real browser.

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
    process.env.BROWSER_BIN = path.join(testHome, 'no-such-browser');
  });

  it('sends a screenshot to the OS app, not the browser viewer', async () => {
    const { setConfigValue, showFile } = await fresh();
    setConfigValue('browser.viewer', 'work');
    for (const ext of ['.png', '.jpg', '.webp', '.pdf', '.webm']) {
      const out = await showFile(`/tmp/capture${ext}`, { spawnOpen });
      expect(out.via, `${ext} should go to the OS app`).toBe('os');
    }
  });

  it('tries the viewer for an .html artifact, and says so when it cannot reach it', async () => {
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
