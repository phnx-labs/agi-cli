import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeActiveSessionsCache } from './session-cache.js';
import { getTerminalsDir } from '../state.js';
import { hostProcessView, recordDaemonProcessView } from './process-view.js';
import {
  writePidSessionEntry,
  readPidSessionEntry,
  listPidSessionEntries,
  prunePidSessionRegistry,
  extractSessionIdArg,
  sessionIdFromLivePid,
  readProcessArgv,
  isSessionIdShape,
  pidSessionEntryMatchesLiveProcess,
  readLivePidSessionEntry,
  processStartTimesMatch,
} from './pid-registry.js';

const FAKE_PID = 999_000_001;

afterEach(() => {
  fs.rmSync(path.join(getTerminalsDir(), 'by-pid'), { recursive: true, force: true });
  fs.rmSync(path.join(getTerminalsDir(), 'by-pid-ownership'), { recursive: true, force: true });
});

describe('pid session registry', () => {
  it('compares normalized ps start times without treating missing or invalid evidence as a match', () => {
    const recorded = 'Fri Oct  2 01:02:03 2026';
    expect(processStartTimesMatch(recorded, '  Fri\tOct 02 01:02:03 2026\n')).toBe(true);
    expect(processStartTimesMatch('  Fri\tOct 02 01:02:03 2026\n', recorded)).toBe(true);
    expect(processStartTimesMatch(recorded, '2026-10-02T01:02:03Z')).toBe(true);
    expect(processStartTimesMatch(recorded, 'Fri Oct  2 01:02:04 2026')).toBe(false);
    expect(processStartTimesMatch(undefined, recorded)).toBeUndefined();
    expect(processStartTimesMatch(recorded, '')).toBeUndefined();
    expect(processStartTimesMatch('invalid', 'invalid')).toBeUndefined();
    expect(processStartTimesMatch(JSON.parse('{"startTime":42}').startTime, recorded)).toBeUndefined();
  });

  it.skipIf(process.platform !== 'darwin')('uses the shared ps snapshot startTime to verify a Darwin PID entry', () => {
    writePidSessionEntry({ pid: process.pid, agent: 'claude', sessionId: 'darwin-start', startedAtMs: Date.now() });
    const snapshot = execFileSync('ps', ['-A', '-o', 'pid=,lstart='], { encoding: 'utf8' });
    const startTime = snapshot.split('\n').map(line => line.trim().match(/^(\d+)\s+(.+)$/))
      .find(match => Number(match?.[1]) === process.pid)?.[2];
    expect(startTime).toBeDefined();
    expect(readLivePidSessionEntry(process.pid, startTime)?.sessionId).toBe('darwin-start');
    const entry = readPidSessionEntry(process.pid)!;
    entry.processIdentity!.startTime = `  ${entry.processIdentity!.startTime!.trim().replace(/\s+/g, '\t')}\n`;
    fs.writeFileSync(path.join(getTerminalsDir(), 'by-pid', `${process.pid}.json`), JSON.stringify(entry));
    expect(readLivePidSessionEntry(process.pid, startTime?.replace(/\s+/g, ' '))?.sessionId).toBe('darwin-start');
    expect(readLivePidSessionEntry(process.pid)?.sessionId).toBe('darwin-start');
    const differentStart = new Date(Date.parse(startTime!) + 1000).toISOString();
    expect(readLivePidSessionEntry(process.pid, differentStart)).toBeUndefined();
    expect(readLivePidSessionEntry(process.pid, 'invalid')).toBeUndefined();
  });

  it('migrates an existing native legacy launch without losing its session and pane joins', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      recordDaemonProcessView();
      const dir = path.join(getTerminalsDir(), 'by-pid');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${child.pid}.json`), JSON.stringify({ pid: child.pid, agent: 'codex', sessionId: 'legacy-native', tmuxPane: '%41', startedAtMs: Date.now() }));
      expect(readLivePidSessionEntry(child.pid!)?.sessionId).toBe('legacy-native');
      expect(readLivePidSessionEntry(child.pid!)?.tmuxPane).toBe('%41');
      expect(pidSessionEntryMatchesLiveProcess(readLivePidSessionEntry(child.pid!)!)).toBe(true);
    } finally {
      child.kill();
      await new Promise<void>(resolve => child.once('exit', () => resolve()));
    }
  });

  it('requires kernel authority for a populated legacy registry without enrolling on observation', () => {
    if (process.platform !== 'linux') return;
    const claim = path.join(getTerminalsDir(), 'process-view.json');
    const original = fs.readFileSync(claim, 'utf8');
    fs.rmSync(claim, { force: true });
    const dir = path.join(getTerminalsDir(), 'by-pid');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'retained', startedAtMs: Date.now() }));
    const initialHost = fs.readlinkSync('/proc/self/ns/pid') === 'pid:[4026531836]';
    expect(!!hostProcessView()).toBe(initialHost);
    expect(fs.existsSync(claim)).toBe(false);
    if (initialHost) {
      expect(() => recordDaemonProcessView()).not.toThrow();
    } else {
      expect(() => recordDaemonProcessView()).toThrow('verified live canonical daemon');
      expect(fs.existsSync(claim)).toBe(false);
    }
    expect(JSON.parse(fs.readFileSync(path.join(dir, `${process.pid}.json`), 'utf8')).sessionId).toBe('retained');
    fs.writeFileSync(claim, original);
  });
  it('round-trips a written entry with its exact session id and join keys', () => {
    writePidSessionEntry({
      pid: FAKE_PID,
      agent: 'claude',
      sessionId: 'abc-123-uuid',
      cwd: '/home/x/repo',
      actor: 'ada@example.com',
      initiatedBy: 'human',
      launchId: 'launch-abc',
      terminalId: 'CL-1700000000000-1',
      tmuxPane: '%18',
      startedAtMs: 1_700_000_000_000,
    });
    const got = readPidSessionEntry(FAKE_PID);
    expect(got?.sessionId).toBe('abc-123-uuid');
    expect(got?.agent).toBe('claude');
    expect(got?.cwd).toBe('/home/x/repo');
    expect(got?.launchId).toBe('launch-abc');
    expect(got?.terminalId).toBe('CL-1700000000000-1');
    expect(got?.tmuxPane).toBe('%18');
    expect(got?.actor).toBe('ada@example.com');
    expect(got?.initiatedBy).toBe('human');
  });

  it('round-trips a custom-harness stamp so --active can show deepseek not claude (PHNX-2935)', () => {
    writePidSessionEntry({
      pid: FAKE_PID,
      agent: 'claude',
      harness: 'deepseek',
      sessionId: 'abc-123-uuid',
      startedAtMs: 1,
    });
    const got = readPidSessionEntry(FAKE_PID);
    expect(got?.agent).toBe('claude');
    expect(got?.harness).toBe('deepseek');
  });

  it('returns undefined for a pid with no entry', () => {
    expect(readPidSessionEntry(FAKE_PID + 7)).toBeUndefined();
  });

  it('ignores a pid < 1 (never writes a bogus file)', () => {
    writePidSessionEntry({ pid: 0, agent: 'claude', startedAtMs: 1 });
    expect(readPidSessionEntry(0)).toBeUndefined();
  });

  it('prune removes entries whose pid is dead, keeps live ones', () => {
    writePidSessionEntry({ pid: FAKE_PID, agent: 'claude', sessionId: 's', startedAtMs: 1 });
    expect(readPidSessionEntry(FAKE_PID)).toBeDefined();
    prunePidSessionRegistry(() => false);
    expect(readPidSessionEntry(FAKE_PID)).toBeUndefined();
  });

  it('stores an entry without a session id (non-Claude agents that take none)', () => {
    writePidSessionEntry({ pid: FAKE_PID, agent: 'grok', cwd: '/repo', startedAtMs: 2 });
    const got = readPidSessionEntry(FAKE_PID);
    expect(got?.agent).toBe('grok');
    expect(got?.sessionId).toBeUndefined();
  });

  it('listPidSessionEntries surfaces a written entry (the tmux source indexes these by pane)', () => {
    writePidSessionEntry({ pid: FAKE_PID, agent: 'gemini', cwd: '/repo', tmuxPane: '%42', launchId: 'lz', startedAtMs: 9 });
    const mine = listPidSessionEntries().filter(e => e.pid === FAKE_PID);
    expect(mine).toHaveLength(1);
    expect(mine[0].tmuxPane).toBe('%42');
    expect(mine[0].agent).toBe('gemini');
    expect(mine[0].launchId).toBe('lz');
  });

  it('retains a live process even when a caller reports false liveness', () => {
    writePidSessionEntry({ pid: process.pid, agent: 'codex', startedAtMs: 1 });
    if (process.platform !== 'linux') return;
    prunePidSessionRegistry(() => false);
    expect(readPidSessionEntry(process.pid)).toBeDefined();
    expect(pidSessionEntryMatchesLiveProcess(readPidSessionEntry(process.pid)!)).toBe(true);
  });

  it('retains legacy and corrupt Linux records whose namespace cannot be established', () => {
    if (process.platform !== 'linux') return;
    writePidSessionEntry({ pid: FAKE_PID, agent: 'codex', startedAtMs: 1 });
    const file = path.join(getTerminalsDir(), 'by-pid', `${FAKE_PID}.json`);
    const entry = readPidSessionEntry(FAKE_PID)!;
    delete entry.processIdentity;
    fs.rmSync(path.join(getTerminalsDir(), 'by-pid-ownership'), { recursive: true, force: true });
    fs.writeFileSync(file, JSON.stringify(entry));
    expect(pidSessionEntryMatchesLiveProcess(entry)).toBeUndefined();
    prunePidSessionRegistry(() => false);
    expect(readPidSessionEntry(FAKE_PID)).toBeDefined();
    fs.writeFileSync(file, '{');
    prunePidSessionRegistry(() => false);
    expect(fs.readFileSync(file, 'utf8')).toBe('{');
  });

  it('rejects a recycled PID using its kernel start ticks', () => {
    if (process.platform !== 'linux') return;
    writePidSessionEntry({ pid: process.pid, agent: 'codex', startedAtMs: Date.now() });
    const entry = readPidSessionEntry(process.pid)!;
    expect(entry.processIdentity?.startTicks).toMatch(/^\d+$/);
    entry.processIdentity!.startTicks = '0';
    expect(pidSessionEntryMatchesLiveProcess(entry)).toBe(false);
    fs.writeFileSync(path.join(getTerminalsDir(), 'by-pid', `${process.pid}.json`), JSON.stringify(entry));
    prunePidSessionRegistry();
    expect(readPidSessionEntry(process.pid)).toBeUndefined();
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it('prunes a real exited child in its owning namespace', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200)'], { stdio: 'ignore' });
    writePidSessionEntry({ pid: child.pid!, agent: 'codex', startedAtMs: Date.now() });
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
    prunePidSessionRegistry();
    expect(readPidSessionEntry(child.pid!)).toBeUndefined();
  });

  for (const mountProc of [true, false]) {
    const flags = ['--user', '--map-root-user', '--pid', '--fork', ...(mountProc ? ['--mount-proc'] : [])];
    const supported = process.platform === 'linux' ? spawnSync('unshare', [...flags, 'true'], { encoding: 'utf8' }) : undefined;
    it.skipIf(process.platform !== 'linux' || (supported?.status !== 0 && process.env.AGENTS_REQUIRE_PID_NAMESPACE_TEST !== '1'))(`retains the host launch in a real nested PID namespace (mount proc: ${mountProc})`, () => {
    if (supported?.status !== 0) throw new Error(supported?.stderr || String(supported?.error));
    writePidSessionEntry({ pid: process.pid, agent: 'codex', sessionId: 'host-session', startedAtMs: Date.now() });
    const sessions = [{ context: 'headless' as const, kind: 'codex', sessionId: 'host-session', status: 'running' as const }];
    writeActiveSessionsCache('local', sessions, { capturedAt: 1 });
    writeActiveSessionsCache('fleet', sessions, { capturedAt: 1, remoteDeviceCount: 2 });
    const fixture = fileURLToPath(new URL('./testdata/pid-registry-namespace.ts', import.meta.url));
    const nested = spawnSync('unshare', [...flags, 'bun', fixture, String(process.pid)], { encoding: 'utf8', env: process.env });
    expect(nested.stderr).toBe('');
    expect(nested.status).toBe(0);
    expect(nested.stdout.trim()).toBe('host pid: ESRCH; overwrite: refused; registry and snapshots: retained');
    expect(readPidSessionEntry(process.pid)?.sessionId).toBe('host-session');
    });
  }

  for (const name of ['tini', 'runit', 's6-svscan']) {
    const flags = ['--user', '--map-root-user', '--pid', '--fork', '--mount-proc'];
    const supported = process.platform === 'linux' ? spawnSync('unshare', [...flags, 'true'], { encoding: 'utf8' }) : undefined;
    it.skipIf(process.platform !== 'linux' || supported?.status !== 0)(`authorizes a real ${name} PID 1 with a private home`, () => {
      const home = fs.mkdtempSync(path.join(process.env.HOME!, 'private-namespace-'));
      try {
        const fixture = fileURLToPath(new URL('./testdata/process-view-private.ts', import.meta.url));
        const child = spawnSync('unshare', [...flags, 'bun', fixture, name], { encoding: 'utf8', env: { ...process.env, HOME: home, AGENTS_REAL_HOME: home } });
        expect(child.status, child.stderr).toBe(0);
        expect(child.stdout.trim()).toBe('private home: registry and snapshot published');
      } finally { fs.rmSync(home, { recursive: true, force: true }); }
    });
  }
});

describe('extractSessionIdArg', () => {
  const UUID = 'e6666574-191b-4afd-ad21-e7a09fd7b026';

  it('finds --session-id <uuid> and --session-id=<uuid>', () => {
    expect(extractSessionIdArg(['--permission-mode', 'x', '--session-id', UUID])).toBe(UUID);
    expect(extractSessionIdArg([`--session-id=${UUID}`])).toBe(UUID);
  });

  it('rejects non-uuid values so a flag typo never fabricates an identity', () => {
    expect(extractSessionIdArg(['--session-id', 'not-a-uuid'])).toBeUndefined();
    expect(extractSessionIdArg(['--session-id'])).toBeUndefined();
    expect(extractSessionIdArg([])).toBeUndefined();
  });

  it('does not match the flag as a prompt substring (only whole args)', () => {
    expect(extractSessionIdArg(['-p', `run with --session-id ${UUID} please`])).toBeUndefined();
  });

  it('isSessionIdShape accepts only UUID forms', () => {
    expect(isSessionIdShape(UUID)).toBe(true);
    expect(isSessionIdShape('not-a-uuid')).toBe(false);
    expect(isSessionIdShape('e6666574')).toBe(false);
  });
});

describe('sessionIdFromLivePid (RUSH-2384)', () => {
  const UUID = 'f0f6cb6b-3887-4f96-927e-8a929f3da418';
  const posixOnly = process.platform === 'win32' ? it.skip : it;

  posixOnly('reads --session-id from a live process argv with an empty by-pid registry', async () => {
    let child: ChildProcess | undefined;
    try {
      child = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 60_000)', '--', '--session-id', UUID],
        { stdio: 'ignore', detached: false },
      );
      const pid = child.pid;
      expect(pid).toBeTruthy();
      await new Promise((r) => setTimeout(r, 50));
      expect(readProcessArgv(pid!)).toEqual(
        expect.arrayContaining(['--session-id', UUID]),
      );
      expect(sessionIdFromLivePid(pid!)).toBe(UUID);
      expect(readPidSessionEntry(pid!)).toBeUndefined();
    } finally {
      if (child?.pid) {
        try { process.kill(child.pid, 'SIGKILL'); } catch {  }
      }
    }
  });

  it('returns undefined for a dead pid', () => {
    expect(sessionIdFromLivePid(2_000_000_000)).toBeUndefined();
    expect(readProcessArgv(2_000_000_000)).toBeUndefined();
  });
});

it('replaces a legacy PID slot on a new host launch and excludes unverified live bindings', async () => {
  const { readLivePidSessionEntry } = await import('./pid-registry.js');
  const dir = path.join(getTerminalsDir(), 'by-pid');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, agent: 'codex', sessionId: 'old-boot-session', startedAtMs: 1 }));
  if (process.platform !== 'win32') expect(readLivePidSessionEntry(process.pid)).toBeUndefined();
  writePidSessionEntry({ pid: process.pid, agent: 'codex', sessionId: 'new-host-session', startedAtMs: Date.now() });
  expect(readLivePidSessionEntry(process.pid)?.sessionId).toBe('new-host-session');
});
