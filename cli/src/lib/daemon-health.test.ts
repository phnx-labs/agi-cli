import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  recordSubsystemOk,
  recordSubsystemError,
  recordSubsystemErrorReason,
  readSubsystemHealth,
  readAllSubsystemHealth,
} from './daemon-health.js';

// getDaemonDir() (state.ts) reads AGENTS_DAEMON_DIR fresh on every call, so no
// module reset is needed between tests — only the env var + a clean tmp dir.
describe('daemon-health', () => {
  let dir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-daemon-health-'));
    originalEnv = process.env.AGENTS_DAEMON_DIR;
    process.env.AGENTS_DAEMON_DIR = dir;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AGENTS_DAEMON_DIR;
    else process.env.AGENTS_DAEMON_DIR = originalEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // RUSH-2418: a daemon start is COUNTED when it is issued, before its outcome
  // is known, then refined if it fails outright. That refinement must not count
  // the same start twice — the whole circuit breaker is a comparison against a
  // threshold, so a double-count halves the limit it enforces.
  describe('recordSubsystemErrorReason', () => {
    it('replaces the reason without bumping the streak', () => {
      recordSubsystemError('daemon-start', 'start issued', '2026-01-01T00:00:00.000Z');
      recordSubsystemErrorReason('daemon-start', 'start failed: no PID', '2026-01-01T00:00:01.000Z');

      const rec = readSubsystemHealth('daemon-start');
      expect(rec?.consecutiveFailures).toBe(1); // one start, one failure
      expect(rec?.lastError).toBe('start failed: no PID');
      expect(rec?.lastErrorAt).toBe('2026-01-01T00:00:01.000Z');
    });

    it('leaves a subsystem that never reported untouched', () => {
      // Writing here would mint a record with a lastError and a zero streak —
      // a failure described but never counted.
      recordSubsystemErrorReason('daemon-start', 'orphan reason');
      expect(readSubsystemHealth('daemon-start')).toBeNull();
    });

    it('does not clear a success', () => {
      recordSubsystemOk('daemon-start', '2026-01-01T00:00:00.000Z');
      recordSubsystemErrorReason('daemon-start', 'late detail', '2026-01-01T00:00:02.000Z');
      const rec = readSubsystemHealth('daemon-start');
      expect(rec?.consecutiveFailures).toBe(0);
      expect(rec?.lastOkAt).toBe('2026-01-01T00:00:00.000Z');
    });
  });

  it('reports no record for a subsystem that has never checked in', () => {
    expect(readSubsystemHealth('monitors')).toBeNull();
    expect(readAllSubsystemHealth()).toEqual([]);
  });

  it('records a success with no prior failures', () => {
    recordSubsystemOk('browser-ipc', '2026-01-01T00:00:00.000Z');
    expect(readSubsystemHealth('browser-ipc')).toEqual({
      subsystem: 'browser-ipc',
      lastError: null,
      lastErrorAt: null,
      consecutiveFailures: 0,
      lastOkAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('accumulates consecutive failures and keeps the most recent error', () => {
    recordSubsystemError('monitors', 'ENOENT: socket missing', '2026-01-01T00:00:00.000Z');
    recordSubsystemError('monitors', 'ECONNREFUSED', '2026-01-01T00:01:00.000Z');
    const record = readSubsystemHealth('monitors');
    expect(record?.consecutiveFailures).toBe(2);
    expect(record?.lastError).toBe('ECONNREFUSED');
    expect(record?.lastErrorAt).toBe('2026-01-01T00:01:00.000Z');
  });

  it('a success after failures clears the streak but keeps the failure history in lastError', () => {
    recordSubsystemError('monitors', 'boom', '2026-01-01T00:00:00.000Z');
    recordSubsystemError('monitors', 'boom again', '2026-01-01T00:01:00.000Z');
    recordSubsystemOk('monitors', '2026-01-01T00:02:00.000Z');
    const record = readSubsystemHealth('monitors');
    expect(record?.consecutiveFailures).toBe(0);
    expect(record?.lastOkAt).toBe('2026-01-01T00:02:00.000Z');
    // lastError is a record of what LAST happened, not cleared on recovery —
    // status/doctor distinguish "healthy now" via consecutiveFailures === 0.
    expect(record?.lastError).toBe('boom again');
  });

  it('tracks multiple subsystems independently and returns them sorted by name', () => {
    recordSubsystemOk('browser-ipc');
    recordSubsystemError('monitors', 'unreachable');
    const all = readAllSubsystemHealth();
    expect(all.map((r) => r.subsystem)).toEqual(['browser-ipc', 'monitors']);
    expect(all.find((r) => r.subsystem === 'monitors')?.consecutiveFailures).toBe(1);
  });

  it('persists on disk under the daemon dir — a separate reader process sees the same record', () => {
    recordSubsystemError('browser-ipc', 'first failure');
    const healthPath = path.join(dir, 'health.json');
    expect(fs.existsSync(healthPath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(healthPath, 'utf-8'));
    expect(onDisk['browser-ipc'].lastError).toBe('first failure');
  });

  it('preserves every failure when separate processes update health concurrently', async () => {
    const writers = 6;
    const failuresPerWriter = 12;
    const worker = path.join(import.meta.dirname, 'testdata', 'daemon-health-writer.ts');

    await Promise.all(Array.from({ length: writers }, () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', worker, 'daemon-start', String(failuresPerWriter)], {
        env: { ...process.env, AGENTS_DAEMON_DIR: dir },
        stdio: 'pipe',
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || `health writer exited ${code}`)));
    })));

    expect(readSubsystemHealth('daemon-start')?.consecutiveFailures).toBe(writers * failuresPerWriter);
    expect(() => JSON.parse(fs.readFileSync(path.join(dir, 'health.json'), 'utf-8'))).not.toThrow();
  }, 30_000);

  it('a malformed health.json is treated as empty rather than throwing', () => {
    fs.writeFileSync(path.join(dir, 'health.json'), 'not json');
    expect(readAllSubsystemHealth()).toEqual([]);
    // And writing still recovers cleanly afterward.
    recordSubsystemOk('monitors');
    expect(readSubsystemHealth('monitors')?.consecutiveFailures).toBe(0);
  });

  // Review finding on PR #3037 (RUSH-3193 P1): recordSubsystemOk/Error are
  // called from inside ServiceSupervisor.runTick's own catch block (and from
  // recordFailure, its catch-of-a-catch). If the write here threw, that throw
  // would escape as an unhandled rejection past every enclosing try/catch,
  // hit the process-wide handler, and process.exit the WHOLE daemon —
  // exactly the failure mode the supervisor exists to prevent. A disk-full,
  // permission-denied, or (per this daemon's own state-dir self-check) a
  // removed state directory must all degrade to a silently dropped health
  // update instead.
  it('recordSubsystemOk/Error never throw even when the health file cannot be written', () => {
    // health.json's parent dir is itself a FILE, so mkdirSync/writeFileSync
    // both fail — this simulates disk-full/permission-denied without needing
    // real filesystem quota tricks.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'not a directory', 'utf-8');

    expect(() => recordSubsystemOk('session-index')).not.toThrow();
    expect(() => recordSubsystemError('session-index', 'tick exceeded deadline')).not.toThrow();
    expect(() => recordSubsystemErrorReason('session-index', 'refined reason')).not.toThrow();

    fs.rmSync(dir, { force: true });
  });
});
