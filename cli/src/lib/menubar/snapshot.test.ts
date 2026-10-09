import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ActiveSession } from '../session/active.js';
import { setActiveSessionsSnapshotPathForTest, setImmutableMemoPathForTest, writeActiveSessionsCache } from '../session/session-cache.js';
import { closeDB } from '../session/db.js';
import { emailDigest } from '../github/viewer.js';
import { computeMenubarSnapshot, readLastWatchdogTick } from './snapshot.js';

process.env.AGENTS_SKIP_MIGRATION = '1';

const dirs: string[] = [];
afterEach(() => {
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

  it('list preferences ride menuListPreferences; menuPreferences stays scalar so a shipped menu still decodes it', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-prefs-home-'));
    dirs.push(home);
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    vi.resetModules();
    try {
      const { setConfigValue } = await import('../device-config.js');
      const { buildMenuPreferences, buildMenuListPreferences } = await import('./snapshot.js');
      const scalarOnly = (prefs: Record<string, unknown>) =>
        Object.values(prefs).every((v) => ['string', 'number', 'boolean'].includes(typeof v));
      expect(scalarOnly(buildMenuPreferences())).toBe(true);
      expect(buildMenuPreferences()).toMatchObject({
        'menubar.menu.groupTicketsByMilestone': false,
        'menubar.statusbar.goalCountdown': false,
      });
      expect(buildMenuListPreferences()).toEqual({
        'menubar.menu.pinnedProjects': [],
        'menubar.menu.tabOrder': ['home', 'goals', 'projects', 'sessions', 'inbox'],
        'menubar.menu.hiddenTabs': [],
        'menubar.menu.homeGoals': ['company'],
      });
      setConfigValue('menubar.menu.pinnedProjects', ['Rush']);
      setConfigValue('menubar.menu.tabOrder', ['home', 'projects', 'sessions', 'inbox']);
      setConfigValue('menubar.menu.hiddenTabs', ['inbox']);
      setConfigValue('menubar.menu.homeGoals', ['company', 'myDay']);
      setConfigValue('menubar.menu.groupTicketsByMilestone', true);
      setConfigValue('menubar.statusbar.goalCountdown', true);
      expect(scalarOnly(buildMenuPreferences())).toBe(true);
      expect(buildMenuPreferences()).toMatchObject({
        'menubar.menu.groupTicketsByMilestone': true,
        'menubar.statusbar.goalCountdown': true,
      });
      expect(buildMenuListPreferences()).toEqual({
        'menubar.menu.pinnedProjects': ['Rush'],
        'menubar.menu.tabOrder': ['home', 'projects', 'sessions', 'inbox', 'goals'],
        'menubar.menu.hiddenTabs': ['inbox'],
        'menubar.menu.homeGoals': ['company', 'myDay'],
      });
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      vi.resetModules();
    }
  });

  it('emits preferred state layered from the device doc over the fleet default', async () => {
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
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.agents', 'agents.yaml'),
      'fleet:\n  devices: {}\n  defaults:\n    config:\n      autoLaunchPreferred: true\n',
    );

    try {
      const { computeMenubarSnapshot: compute } = await import('./snapshot.js');
      const snapshot = await compute();
      expect(snapshot.devices.map(({ name, preferred }) => ({ name, preferred }))).toEqual([
        { name: 'alpha', preferred: true },
        { name: 'bravo', preferred: true },
        { name: 'zion', preferred: true },
      ]);
    } finally {
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
    for (const [name, role] of [['laptop', 'personal'], ['worker', 'worker'], ['unmeasured', 'worker']]) {
      const docDir = path.join(home, '.agents', 'devices', name);
      fs.mkdirSync(docDir, { recursive: true });
      fs.writeFileSync(path.join(docDir, 'agents.yaml'), `config:\n  role: ${role}\n  formFactor: ${name === 'laptop' ? 'laptop' : 'server'}\n`);
    }
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

      expect(byName.laptop.role).toBe('personal');
      expect(byName.laptop.autoEligible).toBe(false);
      expect(byName.worker.role).toBe('worker');
      expect(byName.worker.autoEligible).toBe(true);

      expect(byName.worker.stats).toMatchObject({
        reachable: true, stale: false, cpus: 16, loadPercent: 12, memPercent: 40,
        memTotalBytes: 68719476736, diskFreeBytes: 549755813888, diskUsedPercent: 50,
      });
      expect(byName.worker.stats!.observedAt).toBe(new Date(nowMs).toISOString());

      expect(byName.laptop.stats).toMatchObject({
        reachable: false, stale: true, cpus: 10, loadPercent: null, memPercent: null, memFreeBytes: null,
      });
      expect(byName.laptop.stats!.specsObservedAt).toBe(new Date(nowMs - 2 * 60 * 60_000).toISOString());

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
      row({ sessionId: 'alive-proc', pid: 4242, pidAlive: true, status: 'running' }),
      row({ context: 'cloud', sessionId: 'alive-cloud', status: 'running', cloudProvider: 'rush', cloudTaskId: 'task-123' }),
      row({ sessionId: 'dead-closed', pid: 1111, pidAlive: false, status: 'closed' }),
      row({ sessionId: 'dead-crashed', pid: 2222, pidAlive: false, status: 'crashed' }),
      row({ context: 'cloud', sessionId: 'not-started', status: 'queued', cloudProvider: 'rush', cloudTaskId: 'task-999' }),
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
    expect(proc.project).toBe('other');

    const cloud = snap.activeSessions.find((s) => s.sessionId === 'alive-cloud')!;
    expect(cloud.cloudProvider).toBe('rush');
    expect(cloud.cloudTaskId).toBe('task-123');
    expect(cloud.pid).toBeUndefined();
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

describe('computeMenubarSnapshot — me', () => {
  const PHOENIX_PIC = 'https://lh3.googleusercontent.com/a/example=s96-c';
  const OCTOCAT = { login: 'octocat', name: 'The Octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4', emailSha256: emailDigest('octocat@github.com') };

  async function snapshotMe(files: { session?: object; viewer: object | null }) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-me-home-'));
    dirs.push(home);
    const saved = { HOME: process.env.HOME, AGENTS_STATE_DIR: process.env.AGENTS_STATE_DIR, AGENTS_SESSIONS_DB: process.env.AGENTS_SESSIONS_DB };
    const stateDir = path.join(home, 'state');
    process.env.HOME = home;
    process.env.AGENTS_STATE_DIR = stateDir;
    process.env.AGENTS_SESSIONS_DB = path.join(home, 'sessions.db');
    fs.mkdirSync(stateDir, { recursive: true });
    if (files.session) fs.writeFileSync(path.join(stateDir, 'phoenix-session.json'), JSON.stringify(files.session));
    fs.mkdirSync(path.join(home, '.agents', '.cache'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.agents', '.cache', 'github-viewer.json'),
      JSON.stringify({ checkedAt: Date.now(), ok: true, viewer: files.viewer }),
    );
    closeDB();
    vi.resetModules();
    try {
      const { computeMenubarSnapshot: compute } = await import('./snapshot.js');
      return (await compute()).me;
    } finally {
      const { closeDB: closeFresh } = await import('../session/db.js');
      closeFresh();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      vi.resetModules();
    }
  }

  it('a Phoenix session is the person: its name and picture win, and the same-email gh account adds the login', async () => {
    const session = { access_token: 't', email: 'OctoCat@GitHub.com ', name: 'Mona Lisa Octocat', avatarUrl: PHOENIX_PIC };
    expect(await snapshotMe({ session, viewer: OCTOCAT })).toEqual({
      name: 'Mona Lisa Octocat', email: 'OctoCat@GitHub.com', github: 'octocat', avatarUrl: PHOENIX_PIC, avatarSource: 'phoenix',
    });
  });

  it('the same-email gh account fills a missing session name and picture', async () => {
    const session = { access_token: 't', email: 'octocat@github.com', avatarUrl: 'http://insecure/x.png' };
    expect(await snapshotMe({ session, viewer: OCTOCAT })).toEqual({
      name: 'The Octocat', email: 'octocat@github.com', github: 'octocat', avatarUrl: OCTOCAT.avatarUrl, avatarSource: 'github',
    });
  });

  it('a gh account signed in as someone else lends nothing to the Phoenix person', async () => {
    const session = { access_token: 't', email: 'me@example.com' };
    expect(await snapshotMe({ session, viewer: OCTOCAT }))
      .toEqual({ name: null, email: 'me@example.com', github: null, avatarUrl: null, avatarSource: null });
    expect(await snapshotMe({ session, viewer: { ...OCTOCAT, emailSha256: null } }))
      .toMatchObject({ github: null, avatarUrl: null });
  });

  it('without a Phoenix session the gh account is the person; with neither, me is null', async () => {
    expect(await snapshotMe({ viewer: OCTOCAT })).toEqual({
      name: 'The Octocat', email: null, github: 'octocat', avatarUrl: OCTOCAT.avatarUrl, avatarSource: 'github',
    });
    expect(await snapshotMe({ viewer: null })).toBeNull();
  });
});
