import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let testHome = '';

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
