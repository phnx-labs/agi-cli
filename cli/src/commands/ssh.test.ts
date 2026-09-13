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
      // os.homedir() reads USERPROFILE on Windows, so HOME alone leaves the
      // spawned CLI resolving the real profile ('agents-cli is not set up').
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
    // The discovery decision lands in this box's device doc, never the shared
    // central agents.yaml (PHNX-3315).
    expect(doc()).toContain('mac-mini: approved');
    expect(central()).not.toContain('mac-mini: approved');

    const ignored = run(['devices', 'ignore', 'mac-mini'], env);
    expect(ignored.status).toBe(0);
    expect(doc()).toContain('mac-mini: ignored');
    expect(central()).not.toContain('mac-mini: ignored');

    const unignored = run(['devices', 'unignore', 'mac-mini'], env);
    expect(unignored.status).toBe(0);
    // The decision is cleared from the device doc; central was never touched.
    expect(doc()).not.toContain('mac-mini: approved');
    expect(doc()).not.toContain('mac-mini: ignored');
  });
});

// `agents ssh __askpass` now resolves the bundle through the standalone
// `secrets` CLI process client (PHNX-3989) — there is no in-process engine
// left to seed a fixture bundle into, so this drives the REAL standalone
// against a throwaway file-backed home, gated on AGENTS_TEST_SECRETS_BIN (see
// secrets-client.test.ts). The old macOS-keychain-helper skip no longer
// applies — the bundle below is file-backed, not keychain-backed.
//
// This calls `readAndResolveBundleEnv` directly with the exact options
// `runAskpass` passes (rather than spawning a full `agents ssh __askpass`
// subprocess via this file's `bun`-based `run()`): `run()` re-execs the CLI
// under `bun`, and the standalone's private fd3/fd4 pipe protocol does not
// survive that nesting (`process.execPath` inside a bun-run process is the
// bun binary, not node — a bun-vs-bun nesting artifact of this test harness,
// not of the shipped `#!/usr/bin/env node` CLI). `runAskpass` itself is 3
// lines of env-var plumbing around this exact call; this proves the wiring.
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
  // Calls the real exported raceFleetPingDeadline with a genuinely hanging
  // fanOut promise. The only test double is the fanOut (the network boundary) —
  // the deadline logic itself is the shipped code path, not a reimplementation.
  it('exits promptly and marks all remotes failed/skipped when the overall deadline fires before probes settle', async () => {
    const OVERALL_TIMEOUT_MS = 50;

    const remoteTargets: FanOutDeviceTarget[] = [
      { name: 'worker-a' },                            // probeable: hangs forever
      { name: 'worker-b' },                            // probeable: hangs forever
      { name: 'offline-c', skip: 'offline' as const }, // pre-skipped
    ];

    // A fanOut that never settles — stands in for a hung sshExecAsync call.
    // The per-device timeout is longer than OVERALL_TIMEOUT_MS so it can't
    // resolve the race before the overall deadline fires.
    const hangingFanOut = new Promise<Awaited<ReturnType<typeof fanOutDevices<string[], FanOutDeviceTarget>>>>(() => {
      /* intentionally never resolves */
    });

    const start = Date.now();
    const remote = await raceFleetPingDeadline(hangingFanOut, remoteTargets, OVERALL_TIMEOUT_MS);
    const elapsed = Date.now() - start;

    // The bug this guards is "hangs forever", so the budget only has to sit far
    // below a hang — not a tight fit around the timer. The old `+ 50` gave 50ms
    // of slack around a 50ms timer, which measured machine load rather than
    // correctness: this suite runs 12k tests across forked workers and the timer
    // fires a few ms late (observed 104ms against a 100ms ceiling — the only red
    // test in the suite). Scaling the caller's own value keeps the assertion
    // tied to raceFleetPingDeadline's argument instead of a flat wall-clock
    // number, so it still verifies the deadline it was handed; 20x is 1s here,
    // and a real hang never settles at all.
    expect(elapsed).toBeLessThan(OVERALL_TIMEOUT_MS * 20);

    // Every remote target comes back as failed or skipped — none are missing.
    expect(remote).toHaveLength(3);
    const byName = Object.fromEntries(remote.map((r) => [r.name, r]));

    expect(byName['worker-a'].status).toBe('failed');
    expect(byName['worker-a'].error).toBe('fleet ping overall deadline exceeded');

    expect(byName['worker-b'].status).toBe('failed');
    expect(byName['worker-b'].error).toBe('fleet ping overall deadline exceeded');

    // The pre-skipped device keeps its skip status and reason, no error.
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
    expect(flat).toContain('bh.ts.net'); // tailnet FQDN preferred over public IP
    expect(flat).not.toContain('203.0.113.9');
    expect(flat).toContain('agents run --box <slug>');
    expect(flat).toContain('agents devices lease stop <slug>');
  });
});

describe('leasedBoxRemoteCmd — crabbox ssh consent marker (PHNX-3065)', () => {
  // trySshLeasedBox does not go through buildSshInvocation; it stamps via this
  // helper. Pin the exact remote argv so a leased-box browser drive cannot
  // skip AGENTS_FLEET_REMOTE the way the registered-device path used to.
  // The marker leads; actor provenance tokens (PHNX-3317 ownership) ride between
  // it and the command, so assert the marker prefix + command tail structurally
  // (the resolved actor is environment-dependent, not byte-pinnable here).
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
  // The section load scans the keychain for bundle credentials and can raise a
  // Touch ID sheet after the table prints, so the default list must never reach
  // for it. These pin the exact gate so a refactor can't silently reopen it.
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

    // Dismissals are per-box now (PHNX-3315): the un-ignore must run on the same
    // box that recorded the dismissal (zion), since a box only edits its own doc.
    expect(run(['devices', 'unignore', 'old-laptop'], { AGENTS_SYNC_MACHINE_ID: 'zion' }).status).toBe(0);
    expect(run(['devices', 'ignored']).stdout).toContain('No ignored nodes');
  });

  it('warns (never falsely succeeds) when unignore runs on a box that did not record the dismissal (PHNX-3315)', () => {
    guardedHome();
    expect(run(['devices', 'add', 'old-laptop', 'operator@old-laptop.internal', '--platform', 'linux']).status).toBe(0);
    // Dismissed on box 'zion' only.
    expect(run(['devices', 'ignore', 'old-laptop'], { AGENTS_SYNC_MACHINE_ID: 'zion' }).status).toBe(0);

    // Un-ignore from a DIFFERENT box cannot touch zion's doc; it must say so
    // rather than print a misleading success — the node is still ignored.
    const r = run(['devices', 'unignore', 'old-laptop'], { AGENTS_SYNC_MACHINE_ID: 'other' });
    expect(r.stderr + r.stdout).toContain('still dismissed on');
    expect(r.stderr + r.stdout).toContain('zion');
    expect(r.stdout).not.toContain('No longer ignoring');
    expect(run(['devices', 'ignored']).stdout).toContain('old-laptop');
  });
});

describe('devices auto-launch preferences (per-device doc store)', () => {
  // tests/setup.ts pins AGENTS_DEVICES_DIR for hermeticity, and run() forwards
  // the whole env — so the spawned CLI reads its registry from there, NOT from
  // the fixture HOME. Pin it at the fixture's devices dir in both the seed and
  // the child env so the test exercises one registry under either runner.
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

  // These commands refuse a device that is not registered, so the fixture has
  // to contain one — seeding the registry the CLI reads is the cheapest way to
  // exercise the real command path end to end.
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

// ─── renderDeviceTable — Option B capacity columns (RUSH-3062) ──────────────
//
// Unit-level rendering tests over the REAL renderer: a fake registry plus real
// DeviceStats rows. Role and description ride the tracked per-device doc, so
// those are seeded into the fork-sandboxed HOME the config store already reads
// (tests/setup.ts) — nothing is mocked.

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
      memTotalBytes: 64 * 1024 ** 3, // 64G
      memFreeBytes: 28 * 1024 ** 3,
      diskTotalBytes: 1024 ** 4, // 1T
      diskFreeBytes: 300 * 1024 ** 3,
      diskUsedPercent: 71,
      fetchedAt: NOW,
      ...over,
    };
  }

  /** Seed the tracked per-device doc the config store reads (role/description). */
  function seedDeviceDoc(name: string, config: Record<string, string>): void {
    const dir = path.join(process.env.HOME!, '.agents', 'devices', name);
    fs.mkdirSync(dir, { recursive: true });
    const body = Object.entries(config)
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
      .join('\n');
    fs.writeFileSync(path.join(dir, 'agents.yaml'), `config:\n${body}\n`);
  }

  /** The four-device fleet the width matrix below reasons about. */
  function fleet(): { reg: DeviceRegistry; names: string[]; statsMap: Map<string, DeviceStats> } {
    const reg: DeviceRegistry = {
      'ci-runner': device('ci-runner', { platform: 'linux' }),
      'mac-mini': device('mac-mini', { platform: 'macos' }),
      'mark-1': device('mark-1', { tailscale: { online: true, direct: false } }), // relayed
      zion: device('zion', { platform: 'macos' }),
    };
    const statsMap = new Map<string, DeviceStats>([
      ['ci-runner', stats('ci-runner', { reachable: false })], // offline
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

  /** Column position of the `load` cell — the first column AFTER spec, so any
   * spec-width error shows up here as drift. Substring assertions cannot see
   * this: a row can contain "22%" while sitting in the wrong column.
   *
   * Measures where the cell ENDS, not where its digits begin. `pctCell`
   * right-aligns within a fixed width, so "35%" and " 1%" finish in the same
   * column while starting one apart — keying on the digits would report drift
   * that is not there. */
  function loadColumn(line: string): number {
    return line.indexOf('%');
  }

  it('every row lines its post-spec columns up with the header, whatever the specs measure', () => {
    // A FIXED spec width cannot work: fmtBytes emits an optional decimal, so a
    // real spec string runs from "8c 16G 256G" (11) to "10c 23.5G 460G" (14).
    // A width narrower than the widest row shifts load/mem/disk/headroom out of
    // alignment both row-to-row and against the header — the exact scannability
    // this column exists for. Pin positions, not substrings.
    // The shared fixture's specs all fit the old fixed width (`12c 64G 1T` is
    // 10 chars), so it cannot exercise the overflow. Give one device a real
    // decimal-RAM spec — `10c 23.5G 460G`, 14 chars — which is what an actual
    // probe of a Mac produces and what the fixed width truncated.
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
    // Compare ENDS on both sides: the header label and the right-aligned cell
    // both finish in the same column when the table is correct.
    const headerLoadEnd = header.indexOf('load') + 'load'.length - 1;

    const online = Object.entries(rows).filter(([, line]) => !line.includes('offline'));
    expect(online.length).toBeGreaterThan(1);

    const positions = online.map(([, line]) => loadColumn(line));
    // Every online row agrees with every other...
    expect(new Set(positions).size).toBe(1);
    // ...and lands under the header's own `load` label.
    expect(positions[0]).toBe(headerLoadEnd);
  });

  /** Render plain-text rows keyed by device name (plus a 'head'/'footer' view). */
  /** Index the rendered lines by device name (ansi already stripped). */
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

    expect(rows['mac-mini']).toContain('12c 64G 1T'); // spec cell: cores, RAM, disk
    expect(rows['mac-mini']).toContain('35%'); // load
    expect(rows['mac-mini']).toContain('55%'); // mem
    expect(rows['mac-mini']).toContain('71%'); // disk — same severity scale as load/mem
    expect(rows['mac-mini']).toContain('worker');
    expect(rows['mac-mini']).toContain('signing + notarize box');

    // The markers survive: this-machine caret + arrow, relay. The interactive
    // star is FOLDED into the `personal` role — a personal box is the interactive
    // seat by definition, so the star would just repeat it (it is suppressed here
    // and only shows for a non-personal pinned interactive host).
    expect(rows['zion']).toContain('▸');
    expect(rows['zion']).toContain('← this machine');
    expect(rows['zion']).not.toContain('★ interactive');
    expect(rows['zion']).toContain('personal');
    expect(rows['mark-1']).toContain('relay');
  });

  it('keeps the interactive star when the pinned interactive host is NOT personal', () => {
    // mac-mini is role=worker in the fixture. Pinning it as the interactive host
    // (an unusual but valid config) still shows the star, because `worker` does
    // not itself convey "the box you see things on" the way `personal` does.
    const { reg, names, statsMap } = fleet();
    const rows = rowsFrom(
      renderDeviceTable(reg, names, 'zion', statsMap, false, 'mac-mini', { width: 200, ignoredCount: 0 }).map(stripAnsi),
      names,
    );
    expect(rows['mac-mini']).toContain('★ interactive');
    expect(rows['mac-mini']).toContain('worker');
    // zion is no longer the interactive host here, so it shows neither.
    expect(rows['zion']).not.toContain('★ interactive');
  });

  it('keeps the offline row behavior, now carrying role and description', () => {
    const { rows } = render(200);
    expect(rows['ci-runner']).toContain('offline');
    expect(rows['ci-runner']).not.toContain('%'); // no phantom numbers for a dead box
    expect(rows['ci-runner']).toContain('worker');
    expect(rows['ci-runner']).toContain('hetzner CI runner');
  });

  // RUSH-3096: an offline row rendered as a bare `ci-runner  linux  offline`,
  // dropping cores/RAM/disk the last successful probe had already recorded.
  // Hardware is what the box IS, so it stays legible while the box is down.
  it('renders the retained spec on an offline row, with no live numbers', () => {
    const { rows } = render(200);
    expect(rows['ci-runner']).toContain('12c 64G 1T'); // retained by retainHardwareFacts
    expect(rows['ci-runner']).toContain('offline');
    // Only the STATIC facts appear. The volatile columns are absent, not stale:
    // '%' would mean a load/mem/disk reading for a box that never answered.
    expect(rows['ci-runner']).not.toContain('%');
    // The spec sits in the same column as every online row, which is the whole
    // point of the cell — a fleet inventory you can scan down. Both fixtures
    // carry the default `12c 64G 1T`, so the start index must match exactly.
    expect(rows['ci-runner'].indexOf('12c')).toBe(rows['mac-mini'].indexOf('12c'));
  });

  // Caught only by running the real command: `specCell` pads to the MEASURED
  // column width, so the fleet's WIDEST spec pads to nothing and the marker
  // collided with it — `16c 27.3G 455Goffline`. The shared fixture's specs are
  // all narrower than the floor, so they cannot reach this case.
  it('separates the spec from the offline marker even when the spec sets the column width', () => {
    const { reg, names, statsMap } = fleet();
    // 14 chars — the widest real spec shape, and wider than SPEC_WIDTH_MIN.
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
    // No retained facts: a box added to the registry and never successfully probed.
    statsMap.set('ci-runner', { host: 'ci-runner', reachable: false, fetchedAt: NOW });
    const rows = rowsFrom(
      renderDeviceTable(reg, names, 'zion', statsMap, false, 'zion', { width: 200, ignoredCount: 0 }).map(stripAnsi),
      names,
    );
    expect(rows['ci-runner']).toContain('offline');
    expect(rows['ci-runner']).toContain('—'); // honestly unknown, not invented
    expect(rows['ci-runner']).not.toContain('12c');
  });

  it('truncates the description first at 105 columns; role and numerics intact', () => {
    const { rows } = render(105);
    // zion's row is among the longest (self marker + role + description): its
    // description is the first thing to give. (Width is 105, not 120 — folding
    // the interactive star into the `personal` role freed ~15 columns, so the
    // full row now fits at 120 and only a tighter width forces the truncation
    // this test pins.)
    expect(rows['zion']).not.toContain('my laptop - never auto-place');
    expect(rows['zion']).toContain('…');
    expect(rows['zion']).toContain('personal'); // role survives
    expect(rows['zion']).toContain('24%');
    expect(rows['zion']).toContain('63%');
    // Shorter rows still fit their full description.
    expect(rows['mac-mini']).toContain('signing + notarize box');
  });

  it('drops the description then the role at 80 columns — numerics never truncate', () => {
    const { rows } = render(80);
    // mac-mini: description shrinks to an ellipsis stub, role survives.
    expect(rows['mac-mini']).not.toContain('signing + notarize box');
    expect(rows['mac-mini']).toContain('worker');
    expect(rows['mac-mini']).toContain('35%');
    expect(rows['mac-mini']).toContain('71%');
    expect(rows['mac-mini']).toContain('12c 64G 1T');
    // zion: fixed columns + markers alone exceed 80, so description is gone AND
    // the role has dropped — but every number and marker is still there.
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
    expect(rows['mac-mini']).toContain('12c 64G 1T'); // spec still carries cores
    expect(rows['mac-mini']).toContain('28G/64G');
  });

  it('extends the Fleet capacity footer with free disk, and names ignored nodes', () => {
    const { all } = render(200, false, 2);
    const footer = all.find((l) => l.includes('Fleet capacity'));
    expect(footer).toContain('64 cores'); // 12+36+16 — the offline box counts nothing
    expect(footer).toContain('disk free');
    expect(all.some((l) => l.includes("2 ignored nodes not listed — 'agents devices ignored'"))).toBe(true);
  });

  it('omits the ignored-nodes line when nothing is ignored', () => {
    const { all } = render(200);
    expect(all.some((l) => l.includes('ignored'))).toBe(false);
  });
});
