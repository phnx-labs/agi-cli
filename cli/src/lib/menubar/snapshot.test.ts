import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ActiveSession } from '../session/active.js';
import { setActiveSessionsSnapshotPathForTest, setImmutableMemoPathForTest, writeActiveSessionsCache } from '../session/session-cache.js';
import { closeDB } from '../session/db.js';
import { computeMenubarSnapshot, readLastWatchdogTick } from './snapshot.js';

// The snapshot's device list reads the central device-config block, whose
// public API auto-folds legacy stores on first use. This file's statically
// imported graph uses the REAL HOME (read-only, as before) — pin the migration
// gate so a test run never folds the developer's real ~/.agents as a side
// effect. The central-block test below re-imports with a redirected HOME.
process.env.AGENTS_SKIP_MIGRATION = '1';

const dirs: string[] = [];
afterEach(() => {
  // Drop any open sessions.db handle before rmSync — Windows refuses to unlink
  // a better-sqlite3 file while the connection is live (EBUSY).
  closeDB();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('menubar snapshot', () => {
  it('reads the daemon-owned watchdog result without running a watchdog tick', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-snapshot-'));
    dirs.push(dir);
    const tick = {
      didNudge: true,
      counts: { total: 2, stalled: 1, nudged: 1, unaddressable: 0, skipped: 1 },
      outcomes: [],
    };
    fs.writeFileSync(path.join(dir, 'last-tick.json'), JSON.stringify(tick));

    expect(readLastWatchdogTick(dir)).toEqual(tick);
  });

  it('returns null when the daemon has not published a watchdog result', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-snapshot-'));
    dirs.push(dir);
    expect(readLastWatchdogTick(dir)).toBeNull();
  });

  it('emits preferred state layered from the device doc over the fleet default', async () => {
    // Auto-launch flags live in the tracked per-device doc
    // (devices/<name>/agents.yaml config:) — so this test needs a redirected
    // HOME, which state.ts captures at import time: fresh modules, dynamic
    // import.
    //
    // computeMenubarSnapshot also opens the sessions index (querySessions). On
    // Windows better-sqlite3 keeps sessions.db locked across rmSync. Pin the
    // DB outside the HOME we delete, and close BOTH the static-import singleton
    // and the post-resetModules singleton (vi.resetModules() creates a fresh
    // db.js instance that the static closeDB() cannot see).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-snapshot-home-'));
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-snapshot-db-'));
    dirs.push(home, dbDir);
    const prevHome = process.env.HOME;
    const previousDevicesDir = process.env.AGENTS_DEVICES_DIR;
    const prevSessionsDb = process.env.AGENTS_SESSIONS_DB;
    process.env.HOME = home;
    const devicesDir = path.join(home, '.agents', '.history', 'devices');
    process.env.AGENTS_DEVICES_DIR = devicesDir;
    process.env.AGENTS_SESSIONS_DB = path.join(dbDir, 'sessions.db');
    closeDB();
    vi.resetModules();

    const now = new Date().toISOString();
    const device = (name: string) => ({
      name,
      platform: 'macos',
      shell: 'posix',
      address: { via: 'tailscale', dnsName: `${name}.example.ts.net` },
      auth: { method: 'key' },
      createdAt: now,
      updatedAt: now,
    });
    fs.mkdirSync(devicesDir, { recursive: true });
    fs.writeFileSync(
      path.join(devicesDir, 'registry.json'),
      JSON.stringify({ alpha: device('alpha'), zion: device('zion'), bravo: device('bravo') }),
    );
    const docDir = path.join(home, '.agents', 'devices', 'zion');
    fs.mkdirSync(docDir, { recursive: true });
    fs.writeFileSync(
      path.join(docDir, 'agents.yaml'),
      'config:\n  autoLaunchPreferred: true\n',
    );
    // The fleet-defaults layer: bravo has no doc and inherits it; zion's doc
    // wins over it either way; an explicit device-level false would beat a
    // fleet true (covered in lib/device-config.test.ts).
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.agents', 'agents.yaml'),
      'fleet:\n  devices: {}\n  defaults:\n    config:\n      autoLaunchPreferred: true\n',
    );

    try {
      const { computeMenubarSnapshot: compute } = await import('./snapshot.js');
      const snapshot = await compute();
      expect(snapshot.devices.map(({ name, preferred }) => ({ name, preferred }))).toEqual([
        { name: 'alpha', preferred: true },  // inherited from the fleet default
        { name: 'bravo', preferred: true },  // inherited from the fleet default
        { name: 'zion', preferred: true },   // device doc
      ]);
    } finally {
      // Close the post-resetModules db singleton first (the one compute opened).
      const { closeDB: closeFresh } = await import('../session/db.js');
      closeFresh();
      closeDB();
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (previousDevicesDir === undefined) delete process.env.AGENTS_DEVICES_DIR;
      else process.env.AGENTS_DEVICES_DIR = previousDevicesDir;
      if (prevSessionsDb === undefined) delete process.env.AGENTS_SESSIONS_DB;
      else process.env.AGENTS_SESSIONS_DB = prevSessionsDb;
      vi.resetModules();
    }
  });
});

/**
 * PHNX-3999 F25 — Settings shows each device's role and useful hardware specs.
 *
 * Two properties matter and both are pinned here: the numbers come from the
 * fleet-stats CACHE (opening Settings must never probe the fleet — see
 * docs/menubar.md), and a device nobody has measured reports `stats: null`
 * rather than zeroes that would render as "idle box, empty disk".
 */
describe('computeMenubarSnapshot — device roles and specs (PHNX-3999 F25)', () => {
  it('projects role, auto-placement eligibility and cached specs, and says nothing about an unmeasured box', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-specs-home-'));
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-specs-db-'));
    dirs.push(home, dbDir);
    const prevHome = process.env.HOME;
    const prevDevicesDir = process.env.AGENTS_DEVICES_DIR;
    const prevSessionsDb = process.env.AGENTS_SESSIONS_DB;
    process.env.HOME = home;
    const devicesDir = path.join(home, '.agents', '.history', 'devices');
    process.env.AGENTS_DEVICES_DIR = devicesDir;
    process.env.AGENTS_SESSIONS_DB = path.join(dbDir, 'sessions.db');
    closeDB();
    vi.resetModules();

    const now = new Date().toISOString();
    const device = (name: string, platform: string) => ({
      name,
      platform,
      shell: 'posix',
      address: { via: 'tailscale', dnsName: `${name}.example.ts.net` },
      auth: { method: 'key' },
      createdAt: now,
      updatedAt: now,
    });
    fs.mkdirSync(devicesDir, { recursive: true });
    fs.writeFileSync(
      path.join(devicesDir, 'registry.json'),
      JSON.stringify({
        laptop: device('laptop', 'macos'),
        worker: device('worker', 'linux'),
        unmeasured: device('unmeasured', 'linux'),
      }),
    );
    // Real role marks in the tracked per-device docs — the same store
    // `--device auto` reads through filterAutoPool.
    for (const [name, role] of [['laptop', 'personal'], ['worker', 'worker'], ['unmeasured', 'worker']]) {
      const docDir = path.join(home, '.agents', 'devices', name);
      fs.mkdirSync(docDir, { recursive: true });
      fs.writeFileSync(path.join(docDir, 'agents.yaml'), `config:\n  role: ${role}\n  formFactor: ${name === 'laptop' ? 'laptop' : 'server'}\n`);
    }
    // A real fleet-stats cache: one fresh reachable row, one unreachable row that
    // kept its hardware facts from an earlier probe (retainHardwareFacts), and
    // nothing at all for `unmeasured`.
    const nowMs = Date.now();
    fs.mkdirSync(path.join(home, '.agents', '.cache'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.agents', '.cache', '.fleet-stats.json'),
      JSON.stringify({
        version: 1,
        entries: {
          worker: {
            host: 'worker', reachable: true, fetchedAt: nowMs,
            ncpu: 16, loadPercent: 12, memPercent: 40,
            memTotalBytes: 68719476736, memFreeBytes: 41231686041,
            diskTotalBytes: 1099511627776, diskFreeBytes: 549755813888, diskUsedPercent: 50,
          },
          laptop: {
            host: 'laptop', reachable: false, fetchedAt: nowMs - 60 * 60_000,
            ncpu: 10, memTotalBytes: 34359738368, diskTotalBytes: 494384795648,
            specsFetchedAt: nowMs - 2 * 60 * 60_000,
          },
        },
      }),
    );

    try {
      const { computeMenubarSnapshot: compute } = await import('./snapshot.js');
      const snapshot = await compute();
      const byName = Object.fromEntries(snapshot.devices.map((d) => [d.name, d]));

      // A `personal` box is never auto-placement capacity, whatever its specs.
      expect(byName.laptop.role).toBe('personal');
      expect(byName.laptop.autoEligible).toBe(false);
      expect(byName.worker.role).toBe('worker');
      expect(byName.worker.autoEligible).toBe(true);

      // Fresh reachable reading: hardware facts AND current-state numbers.
      expect(byName.worker.stats).toMatchObject({
        reachable: true, stale: false, cpus: 16, loadPercent: 12, memPercent: 40,
        memTotalBytes: 68719476736, diskFreeBytes: 549755813888, diskUsedPercent: 50,
      });
      expect(byName.worker.stats!.observedAt).toBe(new Date(nowMs).toISOString());

      // Unreachable and hour-old: the hardware facts survive, the live readings
      // are explicitly absent, and the row is labelled stale with its own age.
      expect(byName.laptop.stats).toMatchObject({
        reachable: false, stale: true, cpus: 10, loadPercent: null, memPercent: null, memFreeBytes: null,
      });
      expect(byName.laptop.stats!.specsObservedAt).toBe(new Date(nowMs - 2 * 60 * 60_000).toISOString());

      // Never measured — "unavailable", not zeroes.
      expect(byName.unmeasured.stats).toBeNull();
    } finally {
      const { closeDB: closeFresh } = await import('../session/db.js');
      closeFresh();
      closeDB();
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevDevicesDir === undefined) delete process.env.AGENTS_DEVICES_DIR; else process.env.AGENTS_DEVICES_DIR = prevDevicesDir;
      if (prevSessionsDb === undefined) delete process.env.AGENTS_SESSIONS_DB; else process.env.AGENTS_SESSIONS_DB = prevSessionsDb;
      vi.resetModules();
    }
  });
});

/**
 * RUSH-2336 — the menubar snapshot must apply the same canonical
 * `isRunningLiveSession` selector the CLI's bare `--active` view does. The
 * daemon warm-tick writer never stamps `machine` on a local row (unlike the
 * CLI's own gather), so this also pins the self-stamp fallback that lets a
 * process row satisfy the selector's "names its machine" requirement.
 */
describe('computeMenubarSnapshot — active-session selector (RUSH-2336)', () => {
  let snapDir: string;
  let prevSnap: string | null;
  let prevImm: string | null;
  let prevMachineId: string | undefined;
  let prevSessionsDb: string | undefined;
  let prevRoutinesDir: string | undefined;
  let prevSystemRoutinesDir: string | undefined;

  beforeEach(() => {
    snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-snapshot-active-'));
    dirs.push(snapDir);
    prevSnap = setActiveSessionsSnapshotPathForTest(path.join(snapDir, 'snap.json'));
    prevImm = setImmutableMemoPathForTest(path.join(snapDir, 'imm.json'));
    prevMachineId = process.env.AGENTS_SYNC_MACHINE_ID;
    process.env.AGENTS_SYNC_MACHINE_ID = 'test-box';
    prevSessionsDb = process.env.AGENTS_SESSIONS_DB;
    process.env.AGENTS_SESSIONS_DB = path.join(snapDir, 'sessions.db');
    closeDB();
    prevRoutinesDir = process.env.AGENTS_ROUTINES_DIR;
    process.env.AGENTS_ROUTINES_DIR = path.join(snapDir, 'routines');
    prevSystemRoutinesDir = process.env.AGENTS_SYSTEM_ROUTINES_DIR;
    process.env.AGENTS_SYSTEM_ROUTINES_DIR = path.join(snapDir, 'system-routines');
  });

  afterEach(() => {
    setActiveSessionsSnapshotPathForTest(prevSnap);
    setImmutableMemoPathForTest(prevImm);
    closeDB();
    if (prevMachineId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = prevMachineId;
    if (prevSessionsDb === undefined) delete process.env.AGENTS_SESSIONS_DB;
    else process.env.AGENTS_SESSIONS_DB = prevSessionsDb;
    if (prevRoutinesDir === undefined) delete process.env.AGENTS_ROUTINES_DIR;
    else process.env.AGENTS_ROUTINES_DIR = prevRoutinesDir;
    if (prevSystemRoutinesDir === undefined) delete process.env.AGENTS_SYSTEM_ROUTINES_DIR;
    else process.env.AGENTS_SYSTEM_ROUTINES_DIR = prevSystemRoutinesDir;
  });

  function row(partial: Partial<ActiveSession>): ActiveSession {
    return { context: 'terminal', kind: 'claude', status: 'running', ...partial } as ActiveSession;
  }

  it('excludes retained queued/closed/crashed and unverified-liveness rows, keeps verified process + cloud rows', async () => {
    const rows: ActiveSession[] = [
      // Real, positively-alive process row — no `machine` stamped (the daemon
      // warm-tick gather never sets it), so the snapshot must self-stamp it.
      row({ sessionId: 'alive-proc', pid: 4242, pidAlive: true, status: 'running' }),
      // A cloud row is active on the provider's word alone, no pid at all.
      row({ context: 'cloud', sessionId: 'alive-cloud', status: 'running', cloudProvider: 'rush', cloudTaskId: 'task-123' }),
      // Retained-dead rows the raw cache keeps around for --closed/--crashed.
      row({ sessionId: 'dead-closed', pid: 1111, pidAlive: false, status: 'closed' }),
      row({ sessionId: 'dead-crashed', pid: 2222, pidAlive: false, status: 'crashed' }),
      // Dispatched-but-not-started — belongs only behind --queued.
      row({ context: 'cloud', sessionId: 'not-started', status: 'queued', cloudProvider: 'rush', cloudTaskId: 'task-999' }),
      // A process row whose liveness was never positively verified (an older
      // peer's row, or a pid that could not be resolved) must not read as active.
      row({ sessionId: 'unknown-liveness', pid: 3333, status: 'running' }),
    ];
    writeActiveSessionsCache('local', rows, { capturedAt: Date.now() });

    const snap = await computeMenubarSnapshot();
    const ids = snap.activeSessions.map((s) => s.sessionId).sort();
    expect(ids).toEqual(['alive-cloud', 'alive-proc']);

    const proc = snap.activeSessions.find((s) => s.sessionId === 'alive-proc')!;
    expect(proc.machine).toBe('test-box');
    expect(proc.pid).toBe(4242);
    expect(proc.pidAlive).toBe(true);
    // No cwd on this row → the explicit 'other' bucket, never the harness (RUSH-2688).
    expect(proc.project).toBe('other');

    const cloud = snap.activeSessions.find((s) => s.sessionId === 'alive-cloud')!;
    expect(cloud.cloudProvider).toBe('rush');
    expect(cloud.cloudTaskId).toBe('task-123');
    expect(cloud.pid).toBeUndefined();
    // A cloud row with no cwd groups under the explicit 'cloud' bucket, never
    // its provider name (RUSH-2688).
    expect(cloud.project).toBe('cloud');
  });

  it('stamps the installed CLI version so the menu-bar header is not compiled-in (RUSH-2688)', async () => {
    writeActiveSessionsCache('local', [], { capturedAt: Date.now() });
    const snap = await computeMenubarSnapshot();
    const { getCliVersion } = await import('../version.js');
    expect(snap.cliVersion).toBe(getCliVersion());
    expect(snap.cliVersion.length).toBeGreaterThan(0);
  });

  it('emits no active sessions when the raw cache is empty or missing', async () => {
    const snap = await computeMenubarSnapshot();
    expect(snap.activeSessions).toEqual([]);
  });
});
