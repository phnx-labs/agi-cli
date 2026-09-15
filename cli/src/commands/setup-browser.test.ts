/**
 * `agents setup browser` — the non-interactive path must NEVER mint a profile
 * (PHNX-3296). It recognizes an already-configured default (the shared
 * `browser.profile` key browser-cli also writes) but otherwise defers to the
 * fleet hub. Profile creation and browser detection are the standalone `browser`
 * CLI's now (PHNX-4101); the interactive wizard delegates to it, so the
 * non-interactive contract is the one this pins.
 *
 * Real critical path: `runBrowserWizard` runs for real against a temp
 * device-config store; only the TTY probe is forced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let testHome = '';

// Force the non-interactive path — this is the headless-worker scenario.
vi.mock('./utils.js', async () => {
  const actual = await vi.importActual<typeof import('./utils.js')>('./utils.js');
  return { ...actual, isInteractiveTerminal: () => false };
});

async function fresh() {
  vi.resetModules();
  const wiz = await import('./setup-browser.js');
  const config = await import('../lib/device-config.js');
  return { ...wiz, ...config };
}

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-setup-browser-'));
  process.env.HOME = testHome;
  process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  vi.restoreAllMocks();
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('runBrowserWizard non-interactive (PHNX-3296)', () => {
  it('never sets a default with none configured — defers to the fleet hub, returns false', async () => {
    const { runBrowserWizard, getConfigValue } = await fresh();
    const ok = await runBrowserWizard();
    expect(ok).toBe(false);
    // The crux: nothing minted, even if a browser is installed on the box.
    expect(getConfigValue('browser.profile').value).toBeUndefined();
  });

  it('recognizes an already-configured default without changing it', async () => {
    const { runBrowserWizard, getConfigValue, setConfigValue } = await fresh();
    setConfigValue('browser.profile', 'work');
    const ok = await runBrowserWizard();
    expect(ok).toBe(true);
    expect(getConfigValue('browser.profile').value).toBe('work');
  });
});
