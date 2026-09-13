import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// state.ts resolves HOME and the device id at import time, so we point both at a
// throwaway temp dir and re-import the modules fresh for each test — the REAL
// three-layer read/write path against real files, no mocks (mirrors
// state.test.ts).
let TMP = '';

async function freshModules() {
  vi.resetModules();
  const state = await import('./state.js');
  const deviceConfig = await import('./device-config.js');
  return { ...state, ...deviceConfig };
}

function centralPath() {
  return path.join(TMP, '.agents', 'agents.yaml');
}
function deviceDocPath(host = 'testbox') {
  return path.join(TMP, '.agents', 'devices', host, 'agents.yaml');
}
function readCentral(): string {
  return fs.existsSync(centralPath()) ? fs.readFileSync(centralPath(), 'utf-8') : '';
}
function readDoc(host = 'testbox'): string {
  return fs.existsSync(deviceDocPath(host)) ? fs.readFileSync(deviceDocPath(host), 'utf-8') : '';
}
function writeCentral(yamlText: string) {
  fs.mkdirSync(path.join(TMP, '.agents'), { recursive: true });
  fs.writeFileSync(centralPath(), yamlText);
}
function writeDoc(host: string, yamlText: string) {
  fs.mkdirSync(path.dirname(deviceDocPath(host)), { recursive: true });
  fs.writeFileSync(deviceDocPath(host), yamlText);
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-device-config-test-'));
  process.env.HOME = TMP;
  process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
});
afterEach(() => {
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('user-scope keys (interactive.host)', () => {
  it('round-trips through central agents.yaml under config:, never the device doc', async () => {
    const { setConfigValue, getConfigValue, unsetConfigValue } = await freshModules();

    setConfigValue('interactive.host', 'zion');

    const central = readCentral();
    expect(central).toContain('config:');
    expect(central).toContain('interactiveHost: zion');
    expect(readDoc()).not.toContain('interactiveHost');

    const got = getConfigValue('interactive.host');
    expect(got.value).toBe('zion');
    expect(got.source).toBe('user');

    unsetConfigValue('interactive.host');
    expect(getConfigValue('interactive.host').value).toBeUndefined();
    expect(readCentral()).not.toContain('interactiveHost');
  });

  it('rejects --fleet for a user-scope key (already fleet-wide)', async () => {
    const { setConfigValue, unsetConfigValue } = await freshModules();
    expect(() => setConfigValue('interactive.host', 'zion', { fleet: true })).toThrow(/user-scope/);
    expect(() => unsetConfigValue('interactive.host', { fleet: true })).toThrow(/user-scope/);
  });
});

describe('device-scope keys (per-device doc config:)', () => {
  it('round-trips through devices/<host>/agents.yaml under config:, never central', async () => {
    const { setConfigValue, getConfigValue, unsetConfigValue } = await freshModules();

    setConfigValue('agents.max-concurrent', 4);
    setConfigValue('scheduler.enabled', false);
    setConfigValue('notes', ['runs the releases']);

    const doc = readDoc();
    expect(doc).toContain('config:');
    expect(doc).toContain('maxAgents: 4');
    expect(doc).toContain('schedulerEnabled: false');
    expect(doc).toContain('- runs the releases');

    const central = readCentral();
    expect(central).not.toContain('maxAgents');
    expect(central).not.toContain('schedulerEnabled');

    expect(getConfigValue('agents.max-concurrent')).toMatchObject({ value: 4, source: 'device' });
    expect(getConfigValue('scheduler.enabled')).toMatchObject({ value: false, source: 'device' });
    expect(getConfigValue('notes')).toMatchObject({ value: ['runs the releases'], source: 'device' });

    unsetConfigValue('agents.max-concurrent');
    expect(getConfigValue('agents.max-concurrent').value).toBeUndefined();
    // The other device-scope keys survive an unset of a sibling key.
    expect(getConfigValue('scheduler.enabled').value).toBe(false);
    expect(readDoc()).not.toContain('maxAgents');
  });

  it('targets another device by writing its doc in place (devices/ tree syncs)', async () => {
    const { setConfigValue, getConfigValue, unsetConfigValue } = await freshModules();

    setConfigValue('agents.max-concurrent', 2, { device: 'mac-mini' });

    expect(readDoc('mac-mini')).toContain('maxAgents: 2');
    expect(readDoc()).not.toContain('maxAgents');
    expect(readCentral()).not.toContain('maxAgents');

    expect(getConfigValue('agents.max-concurrent', { device: 'mac-mini' }).value).toBe(2);
    expect(getConfigValue('agents.max-concurrent').value).toBeUndefined();

    unsetConfigValue('agents.max-concurrent', { device: 'mac-mini' });
    expect(getConfigValue('agents.max-concurrent', { device: 'mac-mini' }).value).toBeUndefined();
    // Unsetting the last key removes the doc entirely (no empty tracked file).
    expect(fs.existsSync(deviceDocPath('mac-mini'))).toBe(false);
    // Unsetting a key that was never set is a no-op — no doc created.
    unsetConfigValue('watchdog.enabled', { device: 'ghost' });
    expect(fs.existsSync(deviceDocPath('ghost'))).toBe(false);
  });

  it('preserves a doc’s routines: list across a config write', async () => {
    const { setConfigValue } = await freshModules();
    writeDoc('mac-mini', 'routines:\n  - watchdog\n');

    setConfigValue('watchdog.enabled', false, { device: 'mac-mini' });

    const doc = readDoc('mac-mini');
    expect(doc).toContain('- watchdog');
    expect(doc).toContain('watchdogEnabled: false');
  });
});

describe('description key (one-line synced summary)', () => {
  it('round-trips through devices/<host>/agents.yaml under config:, never central', async () => {
    const { setConfigValue, getConfigValue, unsetConfigValue } = await freshModules();

    setConfigValue('description', 'gpu box — cuda 12.4');

    const doc = readDoc();
    expect(doc).toContain('config:');
    expect(doc).toContain('description: gpu box — cuda 12.4');
    expect(readCentral()).not.toContain('description');

    expect(getConfigValue('description')).toMatchObject({ value: 'gpu box — cuda 12.4', source: 'device' });

    unsetConfigValue('description');
    expect(getConfigValue('description').value).toBeUndefined();
    expect(readDoc()).not.toContain('description');
  });

  it('is shared: any box may set it for a peer, landing in the peer’s tracked doc', async () => {
    const { setConfigValue, getConfigValue } = await freshModules();

    setConfigValue('description', 'release runner', { device: 'mac-mini' });

    expect(readDoc('mac-mini')).toContain('description: release runner');
    expect(readDoc()).not.toContain('description');
    expect(getConfigValue('description', { device: 'mac-mini' }).value).toBe('release runner');
  });

  it('rejects a newline outright — never silently truncated', async () => {
    const { setConfigValue } = await freshModules();
    expect(() => setConfigValue('description', 'line one\nline two')).toThrow(/single line/);
    expect(() => setConfigValue('description', 'line one\r\nline two')).toThrow(/single line/);
  });

  it('rejects an over-long value with a readable error naming the cap', async () => {
    const { setConfigValue } = await freshModules();
    const tooLong = 'x'.repeat(81);
    expect(() => setConfigValue('description', tooLong)).toThrow(/at most 80 characters \(got 81\)/);
    expect(() => setConfigValue('description', 'x'.repeat(80))).not.toThrow();
  });

  it('leaves notes untouched as an appended string-list', async () => {
    const { setConfigValue, getConfigValue } = await freshModules();

    setConfigValue('description', 'gpu box');
    setConfigValue('notes', ['runs the releases']);
    setConfigValue('notes', ['runs the releases', 'loud fans']);

    expect(getConfigValue('notes')).toMatchObject({ value: ['runs the releases', 'loud fans'], source: 'device' });
    expect(getConfigValue('description')).toMatchObject({ value: 'gpu box', source: 'device' });
    expect(() => setConfigValue('notes', 'just a string')).toThrow(/expects a list of strings/);
  });
});

describe('fleet-defaults layer (central fleet.defaults.config)', () => {
  it('--fleet writes land centrally under fleet.defaults.config', async () => {
    const { setConfigValue, getConfigValue, unsetConfigValue } = await freshModules();

    setConfigValue('scheduler.enabled', false, { fleet: true });

    const central = readCentral();
    expect(central).toContain('fleet:');
    expect(central).toContain('defaults:');
    expect(central).toContain('schedulerEnabled: false');
    // The fleet write materializes devices as an explicit EMPTY map (never
    // 'all') so `agents apply` targets nothing until a roster is declared.
    const { readMeta } = await freshModules();
    expect(readMeta().fleet?.devices).toEqual({});

    expect(getConfigValue('scheduler.enabled', { fleet: true })).toMatchObject({ value: false, source: 'fleet' });

    unsetConfigValue('scheduler.enabled', { fleet: true });
    expect(getConfigValue('scheduler.enabled', { fleet: true }).value).toBeUndefined();
    // The emptied block goes away entirely.
    expect(readCentral()).not.toContain('fleet:');
  });

  it('layering: built-in default < fleet default < device value', async () => {
    const { setConfigValue, getConfigValue, unsetConfigValue } = await freshModules();

    // Unset everywhere → built-in default.
    expect(getConfigValue('watchdog.enabled')).toMatchObject({ value: undefined, source: 'default' });

    // Fleet default applies to every device.
    setConfigValue('watchdog.enabled', false, { fleet: true });
    expect(getConfigValue('watchdog.enabled', { device: 'mac-mini' })).toMatchObject({ value: false, source: 'fleet' });

    // A device value wins over the fleet default.
    setConfigValue('watchdog.enabled', true, { device: 'mac-mini' });
    expect(getConfigValue('watchdog.enabled', { device: 'mac-mini' })).toMatchObject({ value: true, source: 'device' });
    // …only on that device.
    expect(getConfigValue('watchdog.enabled', { device: 'zion' })).toMatchObject({ value: false, source: 'fleet' });

    // Unsetting the device key falls back to the fleet default.
    unsetConfigValue('watchdog.enabled', { device: 'mac-mini' });
    expect(getConfigValue('watchdog.enabled', { device: 'mac-mini' })).toMatchObject({ value: false, source: 'fleet' });
  });

  it('a pre-existing fleet.devices map survives a --fleet defaults write', async () => {
    writeCentral('fleet:\n  devices:\n    mac-mini:\n      agents:\n        - claude@latest\n');
    const { setConfigValue, readMeta } = await freshModules();

    setConfigValue('agents.max-concurrent', 2, { fleet: true });

    const fleet = readMeta().fleet;
    expect(fleet?.defaults?.config).toEqual({ maxAgents: 2 });
    const devices = fleet?.devices as Record<string, unknown>;
    expect(devices['mac-mini']).toEqual({ agents: ['claude@latest'] });
  });
});

describe('browser.profile is a device-scope key in the per-device doc', () => {
  it('set/get/unset land under devices/<self>/agents.yaml config.defaultBrowserProfile', async () => {
    const { setConfigValue, getConfigValue, unsetConfigValue } = await freshModules();

    setConfigValue('browser.profile', 'comet-local');

    expect(readDoc()).toContain('defaultBrowserProfile: comet-local');
    expect(readCentral()).not.toContain('defaultBrowserProfile');

    const got = getConfigValue('browser.profile');
    expect(got.value).toBe('comet-local');
    expect(got.source).toBe('device');

    unsetConfigValue('browser.profile');
    expect(getConfigValue('browser.profile').value).toBeUndefined();
    expect(readDoc()).not.toContain('defaultBrowserProfile');
  });
});

describe('ssh.* / platform / auto-launch keys', () => {
  it('round-trip each new key class through the per-device doc', async () => {
    const { setConfigValue, getConfigValue, unsetConfigValue } = await freshModules();

    setConfigValue('ssh.user', 'muqsit', { device: 'win-mini' });
    setConfigValue('ssh.auth', 'password', { device: 'win-mini' });
    setConfigValue('ssh.bundle', 'fleet', { device: 'win-mini' });
    setConfigValue('ssh.bundle-key', 'password.work', { device: 'win-mini' });
    setConfigValue('ssh.identity-file', '/keys/fleet', { device: 'worker' });
    setConfigValue('platform', 'windows', { device: 'win-mini' });
    setConfigValue('auto-launch.enabled', false, { device: 'win-mini' });
    setConfigValue('auto-launch.preferred', true, { device: 'worker' });

    expect(getConfigValue('ssh.user', { device: 'win-mini' }).value).toBe('muqsit');
    expect(getConfigValue('ssh.auth', { device: 'win-mini' }).value).toBe('password');
    expect(getConfigValue('ssh.bundle', { device: 'win-mini' }).value).toBe('fleet');
    expect(getConfigValue('ssh.bundle-key', { device: 'win-mini' }).value).toBe('password.work');
    expect(getConfigValue('ssh.identity-file', { device: 'worker' }).value).toBe('/keys/fleet');
    expect(getConfigValue('platform', { device: 'win-mini' }).value).toBe('windows');
    expect(getConfigValue('auto-launch.enabled', { device: 'win-mini' }).value).toBe(false);
    expect(getConfigValue('auto-launch.preferred', { device: 'worker' }).value).toBe(true);

    unsetConfigValue('ssh.identity-file', { device: 'worker' });
    expect(getConfigValue('ssh.identity-file', { device: 'worker' }).value).toBeUndefined();
  });

  it('validates the enum keys', async () => {
    const { setConfigValue } = await freshModules();
    expect(() => setConfigValue('ssh.auth', 'magic')).toThrow(/key \| password/);
    expect(() => setConfigValue('platform', 'plan9')).toThrow(/windows \| linux \| macos \| unknown/);
  });

  it('the merged hot path (readDeviceConfigValues) layers fleet defaults under device values', async () => {
    const { setConfigValue, readDeviceConfigValues } = await freshModules();
    setConfigValue('ssh.user', 'fleetops', { fleet: true });
    setConfigValue('platform', 'linux', { fleet: true });
    setConfigValue('platform', 'windows', { device: 'win-mini' });

    expect(readDeviceConfigValues('win-mini')).toMatchObject({ sshUser: 'fleetops', platform: 'windows' });
    expect(readDeviceConfigValues('zion')).toMatchObject({ sshUser: 'fleetops', platform: 'linux' });
  });
});

describe('validation', () => {
  it('rejects unknown keys, naming the known set', async () => {
    const { setConfigValue, getConfigValue } = await freshModules();
    expect(() => setConfigValue('nope.nope', 1)).toThrow(/Unknown config key 'nope\.nope'.*interactive\.host/);
    expect(() => getConfigValue('nope.nope')).toThrow(/Unknown config key/);
  });

  it('rejects values of the wrong type', async () => {
    const { setConfigValue } = await freshModules();
    expect(() => setConfigValue('agents.max-concurrent', 'four')).toThrow(/expects an integer/);
    expect(() => setConfigValue('agents.max-concurrent', 2.5)).toThrow(/expects an integer/);
    expect(() => setConfigValue('scheduler.enabled', 'off')).toThrow(/expects a boolean/);
    expect(() => setConfigValue('notes', 'just a string')).toThrow(/expects a list of strings/);
    expect(() => setConfigValue('notes', ['ok', 7])).toThrow(/expects a list of strings/);
    expect(() => setConfigValue('interactive.host', '')).toThrow(/non-empty string/);
  });

  it('rejects out-of-domain values (maxAgents < 1, bad device name)', async () => {
    const { setConfigValue } = await freshModules();
    expect(() => setConfigValue('agents.max-concurrent', 0)).toThrow(/>= 1/);
    expect(() => setConfigValue('interactive.host', 'has spaces')).toThrow(/Invalid value/);
  });
});

describe('listConfig', () => {
  it('reports every known key with its effective value and source layer', async () => {
    const { listConfig, setConfigValue } = await freshModules();
    setConfigValue('interactive.host', 'zion');
    setConfigValue('scheduler.enabled', true);
    setConfigValue('watchdog.enabled', false, { fleet: true });

    const entries = listConfig();
    const byName = Object.fromEntries(entries.map((e) => [e.spec.name, e]));
    expect(Object.keys(byName).sort()).toEqual([
      'agents.max-concurrent',
      'auto-launch.enabled',
      'auto-launch.preferred',
      'auto.pool',
      'browser.device',
      'browser.profile',
      'browser.remote-control',
      'browser.task-idle-minutes',
      'browser.viewer',
      'computer.host',
      'daemon.enabled',
      'description',
      'interactive.host',
      'notes',
      'platform',
      'role',
      'scheduler.enabled',
      'ssh.auth',
      'ssh.bundle',
      'ssh.bundle-key',
      'ssh.identity-file',
      'ssh.user',
      'summarizer.baseUrl',
      'summarizer.enabled',
      'summarizer.model',
      'tmux.enabled',
      'updates.auto',
      'watchdog.enabled',
    ]);
    expect(byName['interactive.host']).toMatchObject({ value: 'zion', source: 'user' });
    expect(byName['scheduler.enabled']).toMatchObject({ value: true, source: 'device' });
    expect(byName['watchdog.enabled']).toMatchObject({ value: false, source: 'fleet' });
    expect(byName['notes']).toMatchObject({ value: undefined, source: 'default' });
  });
});

describe('scheduler gate (scheduler.enabled=false on this device)', () => {
  it('defaults to enabled when unset (unset = today’s behavior)', async () => {
    const { isSchedulerEnabled, assertSchedulerEnabled } = await freshModules();
    expect(isSchedulerEnabled()).toBe(true);
    expect(() => assertSchedulerEnabled()).not.toThrow();
  });

  it('isSchedulerEnabled reflects the stored value', async () => {
    const { isSchedulerEnabled, setConfigValue } = await freshModules();
    setConfigValue('scheduler.enabled', false);
    expect(isSchedulerEnabled()).toBe(false);
    setConfigValue('scheduler.enabled', true);
    expect(isSchedulerEnabled()).toBe(true);
  });

  it('a fleet-wide default gates this machine too', async () => {
    const { isSchedulerEnabled, setConfigValue } = await freshModules();
    setConfigValue('scheduler.enabled', false, { fleet: true });
    expect(isSchedulerEnabled()).toBe(false);
  });

  it('assertSchedulerEnabled throws naming the setting and the fix', async () => {
    const { assertSchedulerEnabled, setConfigValue } = await freshModules();
    setConfigValue('scheduler.enabled', false);
    expect(() => assertSchedulerEnabled()).toThrow(/scheduler\.enabled=false/);
    expect(() => assertSchedulerEnabled()).toThrow(
      /agents devices config testbox scheduler\.enabled on/,
    );
  });

  it('a peer’s scheduler.enabled cannot be written — it is machine-local', async () => {
    const { isSchedulerEnabled, setConfigValue } = await freshModules();
    expect(() => setConfigValue('scheduler.enabled', false, { device: 'mac-mini' }))
      .toThrow(/machine-local/);
    expect(isSchedulerEnabled()).toBe(true);
  });
});

describe('tmux gate (tmux.enabled on this device)', () => {
  it('defaults to disabled when unset', async () => {
    const { isTmuxEnabled } = await freshModules();
    const { resolveTmuxWrap } = await import('./exec.js');
    expect(resolveTmuxWrap({
      interactive: true,
      platform: 'linux',
      inTmux: false,
      raw: false,
      noTmuxEnv: false,
      configEnabled: isTmuxEnabled(),
      remoteDispatch: false,
      tmuxAvailable: true,
      hasTty: true,
    }).kind).toBe('bare');
  });

  it('isTmuxEnabled reflects the stored value', async () => {
    const { isTmuxEnabled, setConfigValue } = await freshModules();
    setConfigValue('tmux.enabled', false);
    expect(isTmuxEnabled()).toBe(false);
    setConfigValue('tmux.enabled', true);
    expect(isTmuxEnabled()).toBe(true);
  });

  it('persists to this box’s own doc, never the fleet-shared file', async () => {
    const { setConfigValue } = await freshModules();
    setConfigValue('tmux.enabled', false);
    expect(readCentral()).not.toMatch(/tmuxEnabled/);
  });

  it('cannot be set for a peer at all — it is machine-local', async () => {
    const { isTmuxEnabled, setConfigValue } = await freshModules();
    expect(() => setConfigValue('tmux.enabled', false, { device: 'mac-mini' }))
      .toThrow(/machine-local/);
    expect(isTmuxEnabled()).toBe(false);
  });
});

describe('resolveBrowserTaskIdleMs (browser.task-idle-minutes, RUSH-2622)', () => {
  it('defaults to 30 minutes in ms when unset', async () => {
    const { resolveBrowserTaskIdleMs } = await freshModules();
    expect(await resolveBrowserTaskIdleMs()).toBe(30 * 60_000);
  });

  it('reflects a stored value, in ms', async () => {
    const { resolveBrowserTaskIdleMs, setConfigValue } = await freshModules();
    setConfigValue('browser.task-idle-minutes', 15);
    expect(await resolveBrowserTaskIdleMs()).toBe(15 * 60_000);
  });

  it('0 resolves to null — the "idle reaping is off" signal, not a zero-ms window', async () => {
    const { resolveBrowserTaskIdleMs, setConfigValue } = await freshModules();
    setConfigValue('browser.task-idle-minutes', 0);
    expect(await resolveBrowserTaskIdleMs()).toBeNull();
  });

  it('rejects a negative value', async () => {
    const { setConfigValue } = await freshModules();
    expect(() => setConfigValue('browser.task-idle-minutes', -1)).toThrow(/must be >= 0/);
  });

  it('persists to this box’s own doc, never the fleet-shared file', async () => {
    const { setConfigValue } = await freshModules();
    setConfigValue('browser.task-idle-minutes', 15);
    expect(readCentral()).not.toMatch(/browserTaskIdleMinutes/);
  });

  it('cannot be set for a peer at all — it is machine-local', async () => {
    const { resolveBrowserTaskIdleMs, setConfigValue } = await freshModules();
    expect(() => setConfigValue('browser.task-idle-minutes', 15, { device: 'mac-mini' }))
      .toThrow(/machine-local/);
    expect(await resolveBrowserTaskIdleMs()).toBe(30 * 60_000);
  });
});

describe('readMaxConcurrentCaps', () => {
  it('reads caps from device docs + the fleet default, omitting uncapped devices', async () => {
    const { readMaxConcurrentCaps, setConfigValue } = await freshModules();
    setConfigValue('agents.max-concurrent', 4);                            // self (testbox)
    setConfigValue('agents.max-concurrent', 2, { device: 'mac-mini' });    // peer doc
    setConfigValue('agents.max-concurrent', 6, { fleet: true });           // fleet default

    expect(readMaxConcurrentCaps(['testbox', 'mac-mini', 'zion'])).toEqual({
      testbox: 4,
      'mac-mini': 2,
      zion: 6, // fleet default applies to a device with no own cap
    });
  });

  it('returns {} when no device has a cap', async () => {
    const { readMaxConcurrentCaps } = await freshModules();
    expect(readMaxConcurrentCaps(['testbox', 'ghost'])).toEqual({});
  });
});

describe('device doc corruption contract', () => {
  it('rejects valid-but-non-map YAML with the corruption error, not a later TypeError', async () => {
    const { getConfigValue, setConfigValue } = await freshModules();
    writeDoc('mac-mini', 'just a string\n');
    expect(() => getConfigValue('agents.max-concurrent', { device: 'mac-mini' }))
      .toThrow(/Device config corrupted.*expected a YAML map/);
    expect(() => setConfigValue('agents.max-concurrent', 2, { device: 'mac-mini' }))
      .toThrow(/Device config corrupted/);

    writeDoc('mac-mini', '- a\n- b\n');
    expect(() => getConfigValue('agents.max-concurrent', { device: 'mac-mini' }))
      .toThrow(/Device config corrupted.*got a list/);
  });

  it('still parses a header-only (empty) doc as empty', async () => {
    const { getConfigValue } = await freshModules();
    writeDoc('mac-mini', '# agents-cli metadata\n');
    expect(getConfigValue('agents.max-concurrent', { device: 'mac-mini' }).value).toBeUndefined();
  });
});

describe('auto-launch accessors', () => {
  it('default every device to enabled and not preferred', async () => {
    const { isAutoLaunchEnabled, isAutoLaunchPreferred } = await freshModules();
    expect(isAutoLaunchEnabled('zion')).toBe(true);
    expect(isAutoLaunchPreferred('zion')).toBe(false);
  });

  it('persist through the per-device doc and invert to a removal', async () => {
    const { setAutoLaunchEnabled, isAutoLaunchEnabled, setAutoLaunchPreferred, isAutoLaunchPreferred, loadAutoLaunchPreferences } = await freshModules();

    setAutoLaunchEnabled('zion', false);
    expect(isAutoLaunchEnabled('zion')).toBe(false);
    expect(readDoc('zion')).toContain('autoLaunchEnabled: false');

    setAutoLaunchPreferred('mac-mini', true);
    expect(isAutoLaunchPreferred('mac-mini')).toBe(true);
    expect(loadAutoLaunchPreferences()).toEqual({
      zion: { enabled: false },
      'mac-mini': { preferred: true },
    });

    // Back to the default removes the key.
    setAutoLaunchEnabled('zion', true);
    setAutoLaunchPreferred('mac-mini', false);
    expect(loadAutoLaunchPreferences()).toEqual({});
    expect(readDoc('zion')).not.toContain('autoLaunch');
  });

  it('layers the fleet default under device flags, reaching doc-less devices via the roster', async () => {
    const { setConfigValue, loadAutoLaunchPreferences } = await freshModules();

    setConfigValue('auto-launch.preferred', true, { fleet: true });
    // A doc-less device only appears when the caller passes the roster.
    expect(loadAutoLaunchPreferences()).toEqual({});
    expect(loadAutoLaunchPreferences(['zion'])).toEqual({ zion: { preferred: true } });

    // A device entry wins over the fleet default.
    setConfigValue('auto-launch.enabled', false, { fleet: true });
    setConfigValue('auto-launch.enabled', true, { device: 'mac-mini' });
    const prefs = loadAutoLaunchPreferences(['zion', 'mac-mini']);
    expect(prefs.zion).toEqual({ preferred: true, enabled: false });
    expect(prefs['mac-mini'].enabled).toBeUndefined(); // explicit device true wins → not disabled
    expect(prefs['mac-mini'].preferred).toBe(true); // fleet default still inherits
  });
});

describe('listConfiguredDeviceRoles (roster reaches doc-less devices)', () => {
  it('a fleet-default role only reaches a device with no per-device doc when the caller passes the roster', async () => {
    const { setConfigValue, listConfiguredDeviceRoles } = await freshModules();

    setConfigValue('role', 'worker', { fleet: true });

    // 'zion' has never had a per-device doc written — the bare, doc-scan-only
    // call (no roster) must not see it. This is the gap #2622's non-author
    // review flagged: a fleet-wide `role` default silently dropped a doc-less
    // device from the `--device auto` worker allowlist.
    expect(listConfiguredDeviceRoles()).toEqual({});
    expect(listConfiguredDeviceRoles(['zion'])).toEqual({ zion: 'worker' });

    // A device's own mark still wins over the fleet default, roster or not.
    setConfigValue('role', 'personal', { device: 'mac-mini' });
    expect(listConfiguredDeviceRoles(['zion', 'mac-mini'])).toEqual({
      zion: 'worker',
      'mac-mini': 'personal',
    });
  });
});

describe('devicesPinningBrowserProfile', () => {
  // These pins cannot be written through setConfigValue from here — the browser
  // keys are machine-local, so only the owning device can set them (it errors
  // with "can only be read or set on the device itself"). They reach this
  // machine by SYNC, as a device doc. So the fixture writes the doc, which is
  // the real-world shape.
  function writeDeviceDoc(device: string, body: string): void {
    const dir = path.join(TMP, '.agents', 'devices', device);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents.yaml'), body);
  }

  it('reports WHICH key each device pinned, not just that it matched', async () => {
    // A caller telling the user to fix `browser.profile` on a device that
    // actually pinned `browser.viewer` leaves the real pin broken AND sets a
    // second key nobody asked for. `profiles rename` prints these verbatim.
    writeDeviceDoc('peerbox', 'config:\n  defaultBrowserProfile: demo\n');
    writeDeviceDoc('otherbox', 'config:\n  browserViewer: demo\n');
    writeDeviceDoc('bothbox', 'config:\n  defaultBrowserProfile: demo\n  browserViewer: demo\n');

    const { devicesPinningBrowserProfile } = await freshModules();
    const hits = devicesPinningBrowserProfile('demo');

    expect(hits).toEqual([
      { device: 'bothbox', key: 'browser.profile' },
      { device: 'bothbox', key: 'browser.viewer' },
      { device: 'otherbox', key: 'browser.viewer' },
      { device: 'peerbox', key: 'browser.profile' },
    ]);
  });

  it('ignores devices pinning a different profile', async () => {
    writeDeviceDoc('peerbox', 'config:\n  defaultBrowserProfile: something-else\n');
    const { devicesPinningBrowserProfile } = await freshModules();
    expect(devicesPinningBrowserProfile('demo')).toEqual([]);
  });
});
