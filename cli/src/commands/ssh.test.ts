import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { renderDeviceTable, renderLeasedBoxesSection, showLeasedBoxesSection, raceFleetPingDeadline, leasedBoxRemoteCmd } from './ssh.js';
import { stripAnsi } from '../lib/text/width.js';
import type { CrabboxBox } from '../lib/crabbox/cli.js';
import type { DeviceProfile, DeviceRegistry } from '../lib/devices/registry.js';
import type { DeviceStats } from '../lib/devices/health.js';
import { fanOutDevices, type FanOutDeviceTarget } from '../lib/devices/fleet.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

let testHome = '';

afterEach(() => {
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
  testHome = '';
});

function guardedHome(): void {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devices-home-'));
  const systemDir = path.join(testHome, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
}

function run(args: string[], extraEnv: Record<string, string> = {}): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('bun', [INDEX, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      AGENTS_NO_UPDATE_CHECK: '1',
      AGENTS_NO_USAGE_TRACK: '1',
      ...extraEnv,
    },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

describe('devices command', () => {
  it('runs the list action when invoked without a subcommand', () => {
    guardedHome();
    const { stdout, status } = run(['devices']);

    expect(status).toBe(0);
    expect(stdout).toContain("No devices. Run 'agents devices sync'");
    expect(stdout).not.toContain('Usage: agents devices');
  });

  it("persists add, ignore, and unignore decisions in THIS box's device doc, not central", () => {
    guardedHome();
    const env = { AGENTS_SYNC_MACHINE_ID: 'testbox' };
    const docPath = path.join(testHome, '.agents', 'devices', 'testbox', 'agents.yaml');
    const centralPath = path.join(testHome, '.agents', 'agents.yaml');
    const central = () => (fs.existsSync(centralPath) ? fs.readFileSync(centralPath, 'utf-8') : '');
    const doc = () => (fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf-8') : '');

    const added = run(['devices', 'add', 'mac-mini', 'operator@mac-mini.internal', '--platform', 'macos'], env);
    expect(added.status).toBe(0);
    expect(doc()).toContain('mac-mini: approved');
    expect(central()).not.toContain('mac-mini: approved');

    const ignored = run(['devices', 'ignore', 'mac-mini'], env);
    expect(ignored.status).toBe(0);
    expect(doc()).toContain('mac-mini: ignored');
    expect(central()).not.toContain('mac-mini: ignored');

    const unignored = run(['devices', 'unignore', 'mac-mini'], env);
    expect(unignored.status).toBe(0);
    expect(doc()).not.toContain('mac-mini: approved');
    expect(doc()).not.toContain('mac-mini: ignored');
  });
});

const REAL_SECRETS_BIN = process.env.AGENTS_TEST_SECRETS_BIN;

describe.skipIf(!REAL_SECRETS_BIN)('ssh askpass (real standalone)', () => {
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = ['SECRETS_BIN', 'HOME', 'SECRETS_HOME', 'AGENTS_SECRETS_PASSPHRASE', 'SECRETS_NO_AGENT'];

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    guardedHome();
    process.env.SECRETS_BIN = REAL_SECRETS_BIN;
    process.env.HOME = testHome;
    process.env.SECRETS_HOME = path.join(testHome, '.agents');
    process.env.AGENTS_SECRETS_PASSPHRASE = 'rush-668-test';
    process.env.SECRETS_NO_AGENT = '1';
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    const { _resetSecretsClientForTest } = await import('../lib/secrets-client.js');
    _resetSecretsClientForTest();
  });

  it('resolves a bundle key by exact storage name', async () => {
    const { writeBundleWithItemsSync, readAndResolveBundleEnv, secretsKeychainItem, _resetSecretsClientForTest } = await import('../lib/secrets-client.js');
    _resetSecretsClientForTest();
    writeBundleWithItemsSync(
      { name: 'github.com', backend: 'file', vars: { 'password.work': 'keychain:password.work' } } as never,
      new Map([[secretsKeychainItem('github.com', 'password.work'), 'secret-pass']]),
    );

    const { env } = await readAndResolveBundleEnv('github.com', {
      caller: 'agents ssh',
      keys: ['password.work'],
      keyMode: 'storage',
      agentOnly: true,
    });

    expect(env['password.work']).toBe('secret-pass');
  });
});

describe('runFleetPing overall-deadline (RUSH-2041)', () => {
  it('exits promptly and marks all remotes failed/skipped when the overall deadline fires before probes settle', async () => {
    const OVERALL_TIMEOUT_MS = 50;

    const remoteTargets: FanOutDeviceTarget[] = [
      { name: 'worker-a' },
      { name: 'worker-b' },
      { name: 'offline-c', skip: 'offline' as const },
    ];

    const hangingFanOut = new Promise<Awaited<ReturnType<typeof fanOutDevices<string[], FanOutDeviceTarget>>>>(() => {
    });

    const start = Date.now();
    const remote = await raceFleetPingDeadline(hangingFanOut, remoteTargets, OVERALL_TIMEOUT_MS);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(OVERALL_TIMEOUT_MS * 20);

    expect(remote).toHaveLength(3);
    const byName = Object.fromEntries(remote.map((r) => [r.name, r]));

    expect(byName['worker-a'].status).toBe('failed');
    expect(byName['worker-a'].error).toBe('fleet ping overall deadline exceeded');

    expect(byName['worker-b'].status).toBe('failed');
    expect(byName['worker-b'].error).toBe('fleet ping overall deadline exceeded');

    expect(byName['offline-c'].status).toBe('skipped');
    expect(byName['offline-c'].reason).toBe('offline');
    expect(byName['offline-c'].error).toBeUndefined();
  }, 2000);
});

describe('renderLeasedBoxesSection — F4 devices "Leased boxes" (RUSH-1923)', () => {
  const NOW = 1_700_000_000;
  const box = (over: Partial<CrabboxBox> = {}): CrabboxBox => ({
    name: 'crabbox-x',
    status: 'running',
    slug: 'x',
    lease: 'cbx_x',
    state: 'ready',
    ready: true,
    keep: false,
    createdAt: NOW - 600,
    expiresAt: NOW + 600,
    lastTouchedAt: NOW - 60,
    idleTimeoutSecs: 1800,
    ...over,
  });

  it('is empty when there are no boxes (section omitted entirely)', () => {
    expect(renderLeasedBoxesSection([], NOW)).toEqual([]);
  });

  it('renders a header, one row per box (tailnet address), and reuse/stop hints', () => {
    const lines = renderLeasedBoxesSection(
      [box({ slug: 'blue-hermit', class: 'cpu-4', tailscaleFQDN: 'bh.ts.net', ip: '203.0.113.9' })],
      NOW,
    );
    const flat = lines.join('\n');
    expect(flat).toContain('Leased boxes');
    expect(flat).toContain('ephemeral · via crabbox');
    expect(flat).toContain('blue-hermit');
    expect(flat).toContain('cpu-4');
    expect(flat).toContain('bh.ts.net');
    expect(flat).not.toContain('203.0.113.9');
    expect(flat).toContain('agents run --box <slug>');
    expect(flat).toContain('agents devices lease stop <slug>');
  });
});

describe('leasedBoxRemoteCmd — crabbox ssh consent marker (PHNX-3065)', () => {
  it('stamps AGENTS_FLEET_REMOTE on agents/ag browser drives', () => {
    const a = leasedBoxRemoteCmd(['agents', 'browser', 'navigate', '--url', 'https://example.com']);
    expect(a.slice(0, 2)).toEqual(['env', 'AGENTS_FLEET_REMOTE=1']);
    expect(a.slice(-5)).toEqual(['agents', 'browser', 'navigate', '--url', 'https://example.com']);

    const b = leasedBoxRemoteCmd(['ag', 'browser', 'screenshot']);
    expect(b.slice(0, 2)).toEqual(['env', 'AGENTS_FLEET_REMOTE=1']);
    expect(b.slice(-3)).toEqual(['ag', 'browser', 'screenshot']);
  });

  it('stamps the standalone browser binary (the P0 hole the registered-device path also closed)', () => {
    const a = leasedBoxRemoteCmd(['browser', 'navigate', '--url', 'https://evil.example']);
    expect(a.slice(0, 2)).toEqual(['env', 'AGENTS_FLEET_REMOTE=1']);
    expect(a.slice(-4)).toEqual(['browser', 'navigate', '--url', 'https://evil.example']);

    const b = leasedBoxRemoteCmd(['browser navigate --url https://evil.example']);
    expect(b.slice(0, 2)).toEqual(['env', 'AGENTS_FLEET_REMOTE=1']);
    expect(b.at(-1)).toBe('browser navigate --url https://evil.example');
  });

  it('leaves non-browser commands unmarked', () => {
    expect(leasedBoxRemoteCmd(['uptime'])).toEqual(['uptime']);
    expect(leasedBoxRemoteCmd(['agents', 'sessions', 'list'])).toEqual(['agents', 'sessions', 'list']);
    expect(leasedBoxRemoteCmd([])).toEqual([]);
  });
});

describe('showLeasedBoxesSection — devices list leased-boxes gate (RUSH-2190)', () => {
  it('is off by default and off for --json-style calls (no flags)', () => {
    expect(showLeasedBoxesSection({})).toBe(false);
    expect(showLeasedBoxesSection({ stats: true })).toBe(false);
  });

  it('is on only with an explicit --all', () => {
    expect(showLeasedBoxesSection({ all: true })).toBe(true);
    expect(showLeasedBoxesSection({ all: true, stats: true })).toBe(true);
  });

  it('--no-stats stays a hard opt-out even with --all', () => {
    expect(showLeasedBoxesSection({ all: true, stats: false })).toBe(false);
    expect(showLeasedBoxesSection({ stats: false })).toBe(false);
  });
});

describe('devices ignored (RUSH-3062 surface)', () => {
  it('lists dismissed nodes with when and which machine, and emits --json entries', () => {
    guardedHome();
    run(['devices', 'add', 'old-laptop', 'operator@old-laptop.internal', '--platform', 'linux']);
    expect(run(['devices', 'ignore', 'old-laptop'], { AGENTS_SYNC_MACHINE_ID: 'zion' }).status).toBe(0);

    const list = run(['devices', 'ignored']);
    expect(list.status, list.stderr).toBe(0);
    expect(list.stdout).toContain('Ignored nodes (1)');
    expect(list.stdout).toContain('old-laptop');
    expect(list.stdout).toContain('dismissed on zion');
    expect(list.stdout).toContain('ago');
    expect(list.stdout).toContain('agents devices unignore');

    const json = run(['devices', 'ignored', '--json']);
    expect(json.status, json.stderr).toBe(0);
    const entries = JSON.parse(json.stdout) as Array<{ name: string; ignoredAt: string; ignoredOn: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('old-laptop');
    expect(entries[0].ignoredOn).toBe('zion');
    expect(Number.isFinite(Date.parse(entries[0].ignoredAt))).toBe(true);

    expect(run(['devices', 'unignore', 'old-laptop'], { AGENTS_SYNC_MACHINE_ID: 'zion' }).status).toBe(0);
    expect(run(['devices', 'ignored']).stdout).toContain('No ignored nodes');
  });

  it('warns (never falsely succeeds) when unignore runs on a box that did not record the dismissal (PHNX-3315)', () => {
    guardedHome();
    expect(run(['devices', 'add', 'old-laptop', 'operator@old-laptop.internal', '--platform', 'linux']).status).toBe(0);
    expect(run(['devices', 'ignore', 'old-laptop'], { AGENTS_SYNC_MACHINE_ID: 'zion' }).status).toBe(0);

    const r = run(['devices', 'unignore', 'old-laptop'], { AGENTS_SYNC_MACHINE_ID: 'other' });
    expect(r.stderr + r.stdout).toContain('still dismissed on');
    expect(r.stderr + r.stdout).toContain('zion');
    expect(r.stdout).not.toContain('No longer ignoring');
    expect(run(['devices', 'ignored']).stdout).toContain('old-laptop');
  });
});

describe('devices auto-launch preferences (per-device doc store)', () => {
  function devicesDir(): string {
    return path.join(testHome, '.agents', '.history', 'devices');
  }

  function devicesEnv(): Record<string, string> {
    return { AGENTS_DEVICES_DIR: devicesDir() };
  }

  function deviceDoc(name: string): string {
    const p = path.join(testHome, '.agents', 'devices', name, 'agents.yaml');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
  }

  function registerDevice(name: string): void {
    fs.mkdirSync(devicesDir(), { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(devicesDir(), 'registry.json'),
      JSON.stringify({
        [name]: {
          name,
          platform: 'macos',
          shell: 'posix',
          user: 'someone',
          address: { via: 'tailscale', dnsName: `${name}.example.ts.net` },
          auth: { method: 'key' },
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
  }

  it('disable and enable persist through the CLI into the per-device doc', () => {
    guardedHome();
    registerDevice('zion');

    const off = run(['devices', 'disable', 'zion'], devicesEnv());
    expect(off.status).toBe(0);
    expect(deviceDoc('zion')).toContain('autoLaunchEnabled: false');

    expect(run(['devices', 'enable', 'zion'], devicesEnv()).status).toBe(0);
    expect(deviceDoc('zion')).not.toContain('autoLaunchEnabled');
  });

  it('auto-launch.preferred persists through `devices config` into the per-device doc', () => {
    guardedHome();
    registerDevice('mac-mini');

    expect(run(['devices', 'config', 'mac-mini', 'auto-launch.preferred', 'on'], devicesEnv()).status).toBe(0);
    expect(deviceDoc('mac-mini')).toContain('autoLaunchPreferred: true');

    expect(run(['devices', 'config', 'mac-mini', 'auto-launch.preferred', '--unset'], devicesEnv()).status).toBe(0);
    expect(deviceDoc('mac-mini')).not.toContain('autoLaunchPreferred');
  });

  it('refuses a device that is not registered instead of writing a dead entry', () => {
    guardedHome();
    registerDevice('zion');
    const r = run(['devices', 'disable', 'zoin'], devicesEnv());
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Unknown device 'zoin'/);
    expect(fs.existsSync(path.join(testHome, '.agents', 'devices', 'zoin'))).toBe(false);
  });
});


describe('renderDeviceTable — spec/disk/description columns (RUSH-3062)', () => {
  const NOW = 1_700_000_000_000;

  function device(name: string, over: Partial<DeviceProfile> = {}): DeviceProfile {
    return {
      name,
      platform: 'linux',
      shell: 'posix',
      user: 'someone',
      address: { via: 'tailscale', dnsName: `${name}.example.ts.net` },
      auth: { method: 'key' },
      tailscale: { online: true, direct: true },
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
      ...over,
    };
  }

  function stats(host: string, over: Partial<DeviceStats> = {}): DeviceStats {
    return {
      host,
      reachable: true,
      ncpu: 12,
      loadPercent: 35,
      memPercent: 55,
      memTotalBytes: 64 * 1024 ** 3,
      memFreeBytes: 28 * 1024 ** 3,
      diskTotalBytes: 1024 ** 4,
      diskFreeBytes: 300 * 1024 ** 3,
      diskUsedPercent: 71,
      fetchedAt: NOW,
      ...over,
    };
  }

  function seedDeviceDoc(name: string, config: Record<string, string>): void {
    const dir = path.join(process.env.HOME!, '.agents', 'devices', name);
    fs.mkdirSync(dir, { recursive: true });
    const body = Object.entries(config)
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
      .join('\n');
    fs.writeFileSync(path.join(dir, 'agents.yaml'), `config:\n${body}\n`);
  }

  function fleet(): { reg: DeviceRegistry; names: string[]; statsMap: Map<string, DeviceStats> } {
    const reg: DeviceRegistry = {
      'ci-runner': device('ci-runner', { platform: 'linux' }),
      'mac-mini': device('mac-mini', { platform: 'macos' }),
      'mark-1': device('mark-1', { tailscale: { online: true, direct: false } }),
      zion: device('zion', { platform: 'macos' }),
    };
    const statsMap = new Map<string, DeviceStats>([
      ['ci-runner', stats('ci-runner', { reachable: false })],
      ['mac-mini', stats('mac-mini')],
      ['mark-1', stats('mark-1', { ncpu: 36, loadPercent: 1, memPercent: 6, diskUsedPercent: 8 })],
      ['zion', stats('zion', { ncpu: 16, loadPercent: 24, memPercent: 32, diskUsedPercent: 63 })],
    ]);
    seedDeviceDoc('ci-runner', { role: 'worker', description: 'hetzner CI runner' });
    seedDeviceDoc('mac-mini', { role: 'worker', description: 'signing + notarize box' });
    seedDeviceDoc('mark-1', { role: 'worker', description: 'gpu box - cuda 12.4' });
    seedDeviceDoc('zion', { role: 'personal', description: 'my laptop - never auto-place' });
    return { reg, names: Object.keys(reg).sort(), statsMap };
  }

  function loadColumn(line: string): number {
    return line.indexOf('%');
  }

  it('every row lines its post-spec columns up with the header, whatever the specs measure', () => {
    const { reg, names, statsMap } = fleet();
    statsMap.set('mac-mini', stats('mac-mini', {
      ncpu: 10,
      memTotalBytes: Math.round(23.5 * 1024 ** 3),
      diskTotalBytes: 460 * 1024 ** 3,
    }));
    const all = renderDeviceTable(reg, names, 'zion', statsMap, false, 'zion', { width: 200, ignoredCount: 0 }).map(stripAnsi);
    const rows: Record<string, string> = {};
    for (const line of all) {
      const m = line.match(/^\s*(?:▸\s+)?([a-z0-9-]+)\s/);
      if (m && names.includes(m[1])) rows[m[1]] = line;
    }
    const header = all.find((l) => /device\s+platform\s+spec\s+load/.test(l))!;
    const headerLoadEnd = header.indexOf('load') + 'load'.length - 1;

    const online = Object.entries(rows).filter(([, line]) => !line.includes('offline'));
    expect(online.length).toBeGreaterThan(1);

    const positions = online.map(([, line]) => loadColumn(line));
    expect(new Set(positions).size).toBe(1);
    expect(positions[0]).toBe(headerLoadEnd);
  });

  function rowsFrom(lines: string[], names: string[]): Record<string, string> {
    const rows: Record<string, string> = {};
    for (const line of lines) {
      const m = line.match(/^\s*(?:▸\s+)?([a-z0-9-]+)\s/);
      if (m && names.includes(m[1])) rows[m[1]] = line;
    }
    return rows;
  }

  function render(width: number, full = false, ignoredCount = 0): { rows: Record<string, string>; all: string[] } {
    const { reg, names, statsMap } = fleet();
    const lines = renderDeviceTable(reg, names, 'zion', statsMap, full, 'zion', { width, ignoredCount }).map(stripAnsi);
    return { rows: rowsFrom(lines, names), all: lines };
  }

  it('renders spec, disk, role, and description columns at a wide (200) terminal', () => {
    const { rows, all } = render(200);
    expect(all[0]).toMatch(/device\s+platform\s+spec\s+load\s+mem\s+disk\s+headroom/);

    expect(rows['mac-mini']).toContain('12c 64G 1T');
    expect(rows['mac-mini']).toContain('35%');
    expect(rows['mac-mini']).toContain('55%');
    expect(rows['mac-mini']).toContain('71%');
    expect(rows['mac-mini']).toContain('worker');
    expect(rows['mac-mini']).toContain('signing + notarize box');

    expect(rows['zion']).toContain('▸');
    expect(rows['zion']).toContain('← this machine');
    expect(rows['zion']).not.toContain('★ interactive');
    expect(rows['zion']).toContain('personal');
    expect(rows['mark-1']).toContain('relay');
  });

  it('keeps the interactive star when the pinned interactive host is NOT personal', () => {
    const { reg, names, statsMap } = fleet();
    const rows = rowsFrom(
      renderDeviceTable(reg, names, 'zion', statsMap, false, 'mac-mini', { width: 200, ignoredCount: 0 }).map(stripAnsi),
      names,
    );
    expect(rows['mac-mini']).toContain('★ interactive');
    expect(rows['mac-mini']).toContain('worker');
    expect(rows['zion']).not.toContain('★ interactive');
  });

  it('keeps the offline row behavior, now carrying role and description', () => {
    const { rows } = render(200);
    expect(rows['ci-runner']).toContain('offline');
    expect(rows['ci-runner']).not.toContain('%');
    expect(rows['ci-runner']).toContain('worker');
    expect(rows['ci-runner']).toContain('hetzner CI runner');
  });

  it('renders the retained spec on an offline row, with no live numbers', () => {
    const { rows } = render(200);
    expect(rows['ci-runner']).toContain('12c 64G 1T');
    expect(rows['ci-runner']).toContain('offline');
    expect(rows['ci-runner']).not.toContain('%');
    expect(rows['ci-runner'].indexOf('12c')).toBe(rows['mac-mini'].indexOf('12c'));
  });

  it('separates the spec from the offline marker even when the spec sets the column width', () => {
    const { reg, names, statsMap } = fleet();
    statsMap.set('ci-runner', stats('ci-runner', {
      reachable: false,
      ncpu: 16,
      memTotalBytes: Math.round(27.3 * 1024 ** 3),
      diskTotalBytes: 455 * 1024 ** 3,
      loadPercent: undefined,
      memPercent: undefined,
      diskUsedPercent: undefined,
    }));
    const lines = renderDeviceTable(reg, names, 'zion', statsMap, false, 'zion', { width: 200, ignoredCount: 0 }).map(stripAnsi);
    const rows = rowsFrom(lines, names);
    expect(rows['ci-runner']).toContain('16c 27.3G 455G');
    expect(rows['ci-runner']).not.toContain('455Goffline');
    expect(rows['ci-runner']).toMatch(/455G\s+offline/);
  });

  it('leaves the spec cell blank for an offline box no probe has ever seen', () => {
    const { reg, names, statsMap } = fleet();
    statsMap.set('ci-runner', { host: 'ci-runner', reachable: false, fetchedAt: NOW });
    const rows = rowsFrom(
      renderDeviceTable(reg, names, 'zion', statsMap, false, 'zion', { width: 200, ignoredCount: 0 }).map(stripAnsi),
      names,
    );
    expect(rows['ci-runner']).toContain('offline');
    expect(rows['ci-runner']).toContain('—');
    expect(rows['ci-runner']).not.toContain('12c');
  });

  it('truncates the description first at 105 columns; role and numerics intact', () => {
    const { rows } = render(105);
    expect(rows['zion']).not.toContain('my laptop - never auto-place');
    expect(rows['zion']).toContain('…');
    expect(rows['zion']).toContain('personal');
    expect(rows['zion']).toContain('24%');
    expect(rows['zion']).toContain('63%');
    expect(rows['mac-mini']).toContain('signing + notarize box');
  });

  it('drops the description then the role at 80 columns — numerics never truncate', () => {
    const { rows } = render(80);
    expect(rows['mac-mini']).not.toContain('signing + notarize box');
    expect(rows['mac-mini']).toContain('worker');
    expect(rows['mac-mini']).toContain('35%');
    expect(rows['mac-mini']).toContain('71%');
    expect(rows['mac-mini']).toContain('12c 64G 1T');
    expect(rows['zion']).not.toContain('my laptop');
    expect(rows['zion']).not.toContain('personal');
    expect(rows['zion']).toContain('24%');
    expect(rows['zion']).toContain('32%');
    expect(rows['zion']).toContain('63%');
    expect(rows['zion']).toContain('16c 64G 1T');
    expect(rows['zion']).toContain('← this machine');
  });

  it('full mode keeps the free/total memory detail alongside the spec cell', () => {
    const { rows, all } = render(200, true);
    expect(all[0]).toContain('free/total');
    expect(rows['mac-mini']).toContain('12c 64G 1T');
    expect(rows['mac-mini']).toContain('28G/64G');
  });

  it('extends the Fleet capacity footer with free disk, and names ignored nodes', () => {
    const { all } = render(200, false, 2);
    const footer = all.find((l) => l.includes('Fleet capacity'));
    expect(footer).toContain('64 cores');
    expect(footer).toContain('disk free');
    expect(all.some((l) => l.includes("2 ignored nodes not listed — 'agents devices ignored'"))).toBe(true);
  });

  it('omits the ignored-nodes line when nothing is ignored', () => {
    const { all } = render(200);
    expect(all.some((l) => l.includes('ignored'))).toBe(false);
  });
});
