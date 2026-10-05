import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The v2 store convergence: central `fleet.devices.<name>.config` (#2458), legacy
 * `auto-launch.json` and `defaultBrowserProfile:` fold into each device doc's `config:`; agent
 * pins leave tracked docs. Real files, fresh modules per test, no mocks. */
let TMP = '';

async function freshModules() {
  vi.resetModules();
  const state = await import('../state.js');
  const migration = await import('./config-migration.js');
  const deviceConfig = await import('../device-config.js');
  const registry = await import('./registry.js');
  return { ...state, ...migration, ...deviceConfig, ...registry };
}

function centralPath() {
  return path.join(TMP, '.agents', 'agents.yaml');
}
function readCentral(): string {
  return fs.existsSync(centralPath()) ? fs.readFileSync(centralPath(), 'utf-8') : '';
}
function writeCentral(yamlText: string) {
  fs.mkdirSync(path.join(TMP, '.agents'), { recursive: true });
  fs.writeFileSync(centralPath(), yamlText);
}
function deviceDocPath(host: string) {
  return path.join(TMP, '.agents', 'devices', host, 'agents.yaml');
}
function writeDoc(host: string, yamlText: string) {
  fs.mkdirSync(path.dirname(deviceDocPath(host)), { recursive: true });
  fs.writeFileSync(deviceDocPath(host), yamlText);
}
function readDoc(host: string): string {
  return fs.existsSync(deviceDocPath(host)) ? fs.readFileSync(deviceDocPath(host), 'utf-8') : '';
}
function autoLaunchPath() {
  return path.join(TMP, '.agents', '.history', 'devices', 'auto-launch.json');
}
function pinsPath(host = 'testbox') {
  return path.join(TMP, '.agents', '.history', 'devices', `pins-${host}.json`);
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-config-migration-test-'));
  process.env.HOME = TMP;
  process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
  process.env.AGENTS_DEVICES_DIR = path.join(TMP, '.agents', '.history', 'devices');
});
afterEach(() => {
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  delete process.env.AGENTS_DEVICES_DIR;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {  }
});

describe('migrateDeviceConfigStores', () => {
  it('folds the central #2458 block into per-device docs (central wins) and strips it', async () => {
    writeCentral(
      'fleet:\n  devices:\n    mac-mini:\n      config:\n        maxAgents: 8\n        schedulerEnabled: false\n',
    );
    writeDoc('mac-mini', 'routines:\n  - watchdog\nconfig:\n  maxAgents: 4\n  notes:\n    - runs the releases\n');

    const { migrateDeviceConfigStores, getConfigValue, readMeta } = await freshModules();
    migrateDeviceConfigStores();

    expect(getConfigValue('agents.max-concurrent', { device: 'mac-mini' }).value).toBe(8);
    expect(readDoc('mac-mini')).toContain('schedulerEnabled: false');
    expect(getConfigValue('notes', { device: 'mac-mini' }).value).toEqual(['runs the releases']);

    const doc = readDoc('mac-mini');
    expect(doc).toContain('- watchdog');
    expect(doc).toContain('maxAgents: 8');

    expect(readCentral()).not.toContain('maxAgents');
    expect(readMeta().fleet).toBeUndefined();
  });

  it('keeps non-config override fields (agents/sync/login) in central while stripping config', async () => {
    writeCentral(
      'fleet:\n  devices:\n    mac-mini:\n      agents:\n        - claude@latest\n      config:\n        maxAgents: 8\n',
    );

    const { migrateDeviceConfigStores, readMeta } = await freshModules();
    migrateDeviceConfigStores();

    const fleet = readMeta().fleet;
    const devices = fleet?.devices as Record<string, Record<string, unknown>>;
    expect(devices['mac-mini']).toEqual({ agents: ['claude@latest'] });
    expect(readDoc('mac-mini')).toContain('maxAgents: 8');
  });

  it('folds auto-launch.json flags into device docs and removes the file', async () => {
    fs.mkdirSync(path.dirname(autoLaunchPath()), { recursive: true });
    fs.writeFileSync(
      autoLaunchPath(),
      JSON.stringify({
        devices: { zion: { enabled: false }, 'mac-mini': { preferred: true } },
        updatedAt: new Date().toISOString(),
      }),
    );

    const { migrateDeviceConfigStores, isAutoLaunchEnabled, isAutoLaunchPreferred, loadAutoLaunchPreferences } =
      await freshModules();
    migrateDeviceConfigStores();

    expect(isAutoLaunchEnabled('zion')).toBe(false);
    expect(isAutoLaunchPreferred('mac-mini')).toBe(true);
    expect(loadAutoLaunchPreferences()).toEqual({
      zion: { enabled: false },
      'mac-mini': { preferred: true },
    });
    expect(fs.existsSync(autoLaunchPath())).toBe(false);
    expect(readDoc('zion')).toContain('autoLaunchEnabled: false');
  });

  it('folds a doc-level defaultBrowserProfile into config:', async () => {
    writeDoc('testbox', 'defaultBrowserProfile: comet-local\n');

    const { migrateDeviceConfigStores, getConfigValue } = await freshModules();
    migrateDeviceConfigStores();

    expect(getConfigValue('browser.profile').value).toBe('comet-local');
    const doc = readDoc('testbox');
    expect(doc).toContain('config:');
    expect(doc).toContain('defaultBrowserProfile: comet-local');
    expect(doc.indexOf('defaultBrowserProfile')).toBe(doc.lastIndexOf('defaultBrowserProfile'));
  });

  it('moves SELF pins to the untracked pins file and drops peer pins from the tracked docs', async () => {
    writeDoc('testbox', 'agents:\n  claude: 2.1.0\nisolatedAgents:\n  codex: 0.144.6\nroutines:\n  - watchdog\n');
    writeDoc('mac-mini', 'agents:\n  claude: 2.0.14\nconfig:\n  maxAgents: 4\n');

    const { migrateDeviceConfigStores, readMeta } = await freshModules();
    migrateDeviceConfigStores();

    const pins = JSON.parse(fs.readFileSync(pinsPath(), 'utf-8'));
    expect(pins).toEqual({ agents: { claude: '2.1.0' }, isolatedAgents: { codex: '0.144.6' } });
    expect(readMeta().agents?.claude).toBe('2.1.0');
    expect(readMeta().isolatedAgents?.codex).toBe('0.144.6');

    const selfDoc = readDoc('testbox');
    expect(selfDoc).not.toContain('claude');
    expect(selfDoc).not.toContain('codex');
    expect(selfDoc).toContain('- watchdog');
    const peerDoc = readDoc('mac-mini');
    expect(peerDoc).not.toContain('claude');
    expect(peerDoc).toContain('maxAgents: 4');
    expect(fs.existsSync(pinsPath('mac-mini'))).toBe(false);
  });

  it('pins file wins over doc pins on conflict (destination-wins, crash-safe re-run)', async () => {
    fs.mkdirSync(path.dirname(pinsPath()), { recursive: true });
    fs.writeFileSync(pinsPath(), JSON.stringify({ agents: { claude: '2.2.0' } }, null, 2) + '\n');
    writeDoc('testbox', 'agents:\n  claude: 2.1.0\n');

    const { migrateDeviceConfigStores, readMeta } = await freshModules();
    migrateDeviceConfigStores();

    expect(readMeta().agents?.claude).toBe('2.2.0');
    expect(readDoc('testbox')).toBe('');
  });

  it('is idempotent — a second run changes nothing', async () => {
    writeCentral('fleet:\n  devices:\n    mac-mini:\n      config:\n        maxAgents: 8\n');
    writeDoc('testbox', 'agents:\n  claude: 2.1.0\n');

    const { migrateDeviceConfigStores } = await freshModules();
    migrateDeviceConfigStores();
    const afterFirst = [readCentral(), readDoc('testbox'), readDoc('mac-mini'), fs.readFileSync(pinsPath(), 'utf-8')];
    migrateDeviceConfigStores();
    expect([readCentral(), readDoc('testbox'), readDoc('mac-mini'), fs.readFileSync(pinsPath(), 'utf-8')]).toEqual(afterFirst);
  });

  it('skips a corrupted device doc loudly and leaves it for a later retry', async () => {
    writeDoc('broken', 'config:\n  maxAgents: [unclosed\n');
    writeDoc('mac-mini', 'config:\n  maxAgents: 4\n');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { migrateDeviceConfigStores, getConfigValue } = await freshModules();
    try {
      migrateDeviceConfigStores();

      expect(getConfigValue('agents.max-concurrent', { device: 'mac-mini' }).value).toBe(4);
      expect(fs.existsSync(deviceDocPath('broken'))).toBe(true);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('broken'));
    } finally {
      errSpy.mockRestore();
    }
  });

  it('is a no-op when no legacy stores exist', async () => {
    writeDoc('mac-mini', 'config:\n  maxAgents: 4\n');
    const { migrateDeviceConfigStores } = await freshModules();
    migrateDeviceConfigStores();
    expect(readCentral()).toBe('');
    expect(readDoc('mac-mini')).toContain('maxAgents: 4');
  });

  it("folds a legacy ignored.json into THIS box's device doc, removes the file, and re-running is a no-op", async () => {
    const legacy = path.join(TMP, '.agents', '.history', 'devices', 'ignored.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(
      legacy,
      JSON.stringify({ ignored: ['old-phone', 'ipad165'], updatedAt: '2026-08-01T10:00:00.000Z' }),
    );

    const { migrateDeviceConfigStores, loadIgnoredEntries } = await freshModules();
    migrateDeviceConfigStores();

    expect(loadIgnoredEntries()).toEqual([
      { name: 'ipad165', ignoredAt: '2026-08-01T10:00:00.000Z', ignoredOn: 'testbox' },
      { name: 'old-phone', ignoredAt: '2026-08-01T10:00:00.000Z', ignoredOn: 'testbox' },
    ]);
    expect(readDoc('testbox')).toContain('ignored:');
    expect(readDoc('testbox')).toContain('old-phone');
    expect(readCentral()).not.toContain('ignored:');
    expect(fs.existsSync(legacy)).toBe(false);

    const afterFirst = readDoc('testbox');
    migrateDeviceConfigStores();
    expect(readDoc('testbox')).toBe(afterFirst);
    expect(loadIgnoredEntries()).toHaveLength(2);
  });

  it('unions legacy names with an existing central dismissal — newest ignoredAt wins', async () => {
    writeCentral(
      'fleet:\n  devices: {}\n  ignored:\n    - name: ipad165\n      ignoredAt: "2026-07-01T00:00:00.000Z"\n      ignoredOn: zion\n',
    );
    const legacy = path.join(TMP, '.agents', '.history', 'devices', 'ignored.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ ignored: ['ipad165', 'kindle'], updatedAt: '2026-08-01T10:00:00.000Z' }));

    const { migrateDeviceConfigStores, loadIgnoredEntries } = await freshModules();
    migrateDeviceConfigStores();

    expect(loadIgnoredEntries()).toEqual([
      { name: 'ipad165', ignoredAt: '2026-08-01T10:00:00.000Z', ignoredOn: 'testbox' },
      { name: 'kindle', ignoredAt: '2026-08-01T10:00:00.000Z', ignoredOn: 'testbox' },
    ]);
    expect(readCentral()).not.toContain('ignored:');
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('leaves a malformed legacy ignored.json in place (loudly) for a later retry', async () => {
    const legacy = path.join(TMP, '.agents', '.history', 'devices', 'ignored.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, '{ this is not json');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { migrateDeviceConfigStores } = await freshModules();
    try {
      migrateDeviceConfigStores();

      expect(fs.existsSync(legacy)).toBe(true);
      expect(readCentral()).not.toContain('ignored:');
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('ignored.json'));
    } finally {
      errSpy.mockRestore();
    }
  });

  it('folds central dismissals into the device doc without losing them as the #2458 strip empties the fleet block', async () => {
    // A box carrying both legacy central per-device config and dismissals drains central twice.
    // The dismissal must survive the move to this box's device doc, or the node would be silently
    // un-ignored fleet-wide.
    writeCentral(
      'fleet:\n  devices:\n    mac-mini:\n      config:\n        maxAgents: 8\n  ignored:\n    - name: ipad165\n      ignoredAt: "2026-08-20T09:15:00.000Z"\n      ignoredOn: zion\n',
    );

    const { migrateDeviceConfigStores, loadIgnoredEntries, readMeta } = await freshModules();
    migrateDeviceConfigStores();

    expect(loadIgnoredEntries()).toEqual([
      { name: 'ipad165', ignoredAt: '2026-08-20T09:15:00.000Z', ignoredOn: 'zion' },
    ]);
    expect(readMeta().fleet).toBeUndefined();
    expect(readCentral()).not.toContain('ignored:');
    expect(readDoc('mac-mini')).toContain('maxAgents: 8');
  });
});

describe('migrateDeviceConfigStores — hosts + accounts device-scoping (PHNX-3315)', () => {
  it("folds a central hosts map into THIS box's device doc and drops the central key", async () => {
    writeCentral('hosts:\n  s1:\n    source: inline\n    address: yosemite-s1\n    addedAt: "2026-05-01T00:00:00.000Z"\n');

    const { migrateDeviceConfigStores, readMeta } = await freshModules();
    migrateDeviceConfigStores();

    expect(readDoc('testbox')).toContain('s1');
    expect(readDoc('testbox')).toContain('yosemite-s1');
    expect(readMeta().hosts).toBeUndefined();
    expect(readCentral()).not.toContain('yosemite-s1');

    const after = readDoc('testbox');
    migrateDeviceConfigStores();
    expect(readDoc('testbox')).toBe(after);
  });

  it("folds central scope:'device' natives (and their bindings) into the device doc, keeping version accounts central", async () => {
    writeCentral(
      'accounts:\n' +
        '  native:\n' +
        '    dev-1:\n      id: dev-1\n      name: opencode-me\n      agent: opencode\n      identityKey: "opencode:user=1"\n      identityLabel: me@example.com\n      scope: device\n' +
        '    ver-1:\n      id: ver-1\n      name: codex-me\n      agent: codex\n      identityKey: "codex:user=2"\n      scope: version\n' +
        '  bindings:\n    "opencode@1.0.0": dev-1\n    "claude@2.0.0": ver-1\n',
    );

    const { migrateDeviceConfigStores, readMeta } = await freshModules();
    migrateDeviceConfigStores();

    expect(readDoc('testbox')).toContain('opencode:user=1');
    expect(readDoc('testbox')).toContain('opencode@1.0.0');
    expect(readCentral()).not.toContain('opencode:user=1');

    const central = readMeta();
    expect(central.accounts?.native?.['ver-1']).toBeDefined();
    expect(central.accounts?.native?.['dev-1']).toBeUndefined();
    expect(central.accounts?.bindings?.['claude@2.0.0']).toBe('ver-1');
    expect(central.accounts?.bindings?.['opencode@1.0.0']).toBeUndefined();

    const after = readDoc('testbox');
    migrateDeviceConfigStores();
    expect(readDoc('testbox')).toBe(after);
  });
});
