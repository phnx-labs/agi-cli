import { afterAll, describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HostTask } from './tasks.js';

// Isolate the sessions DB under a temp HOME. state.js and db.js bind their paths at import time,
// and static imports are hoisted above the HOME assignment, breaking isolation under CI sharding;
// so set HOME first, then top-level `await import` (same pattern as session/__tests__/db.test.ts).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-hostsession-'));
process.env.HOME = TEST_HOME;

const { hostSessionMeta, registerHostSession, registerInteractiveHostSession, captureRemoteSessionId } =
  await import('./session-index.js');
const { findSessionsById, querySessions, closeDB } = await import('../session/db.js');
const { saveTask, loadTask, localLogPath, hostsCacheDir } = await import('./tasks.js');
const { sessionIdMarkerLine } = await import('./session-marker.js');

// Close the DB singleton and tear down the temp HOME exactly once, at the end —
// not scattered mid-file inside individual `it` blocks, which order-couples the
// tests. Matches the single-teardown shape of db.test.ts:100-102.
afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

function task(overrides: Partial<HostTask> = {}): HostTask {
  return {
    id: 'deadbeef',
    host: 'box',
    target: 'user@box',
    agent: 'claude',
    prompt: 'first line\nsecond line',
    sessionId: '11111111-2222-3333-4444-555555555555',
    remoteLog: '/r/deadbeef.log',
    remoteExit: '/r/deadbeef.exit',
    status: 'running',
    createdAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

describe('hostSessionMeta', () => {
  it('builds a session row with an empty file_path (remote transcript) and a host label', () => {
    const meta = hostSessionMeta(task(), { cwd: '/home/me/proj', prompt: 'first line\nsecond line' });
    expect(meta).not.toBeNull();
    expect(meta!.id).toBe('11111111-2222-3333-4444-555555555555');
    expect(meta!.shortId).toBe('11111111');
    expect(meta!.agent).toBe('claude');
    expect(meta!.cwd).toBe('/home/me/proj');
    expect(meta!.filePath).toBe(''); // sentinel: remote-only, survives the stale-file filter
    expect(meta!.machine).toBe('box');
    expect(meta!.label).toBe('[host/box]');
    expect(meta!.topic).toBe('first line');
  });

  it('seeds the label with the run --name when present (falls back to the host tag)', () => {
    const meta = hostSessionMeta(task({ name: 'remote-audit' }), { cwd: '/x', prompt: 'p' });
    expect(meta!.label).toBe('remote-audit');
  });

  it('normalizes the dispatch host as the origin machine', () => {
    const meta = hostSessionMeta(task({ host: 'BOX.tail.ts.net' }), { cwd: '/x', prompt: 'p' });
    expect(meta!.machine).toBe('box');
  });

  it('returns null when the run captured no session id (nothing to key on)', () => {
    expect(hostSessionMeta(task({ sessionId: undefined }), { cwd: '/x', prompt: 'p' })).toBeNull();
  });

  it('returns null for an agent that is not a known session agent', () => {
    expect(hostSessionMeta(task({ agent: 'nonsense' }), { cwd: '/x', prompt: 'p' })).toBeNull();
  });
});

describe('registerInteractiveHostSession', () => {
  it('registers an interactive host run so it is resolvable by id', () => {
    registerInteractiveHostSession({
      cwd: '/home/me/proj',
      host: 'yosemite-s0',
      agent: 'claude',
      sessionId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
      name: 'remote-claude',
    });

    const byId = findSessionsById('bbbbbbbb-cccc-dddd-eeee-ffffffffffff');
    expect(byId).toHaveLength(1);
    expect(byId[0].agent).toBe('claude');
    expect(byId[0].label).toBe('remote-claude');
    expect(byId[0].filePath).toBe('');
    expect(byId[0].machine).toBe('yosemite-s0');
  });

  it('is a no-op for agents that are not session-tracked', () => {
    registerInteractiveHostSession({
      cwd: '/x',
      host: 'box',
      agent: 'nonsense',
      sessionId: 'cccccccc-dddd-eeee-ffff-000000000000',
    });

    expect(findSessionsById('cccccccc-dddd-eeee-ffff-000000000000')).toHaveLength(0);
  });
});

describe('registerHostSession', () => {
  it('registers a host run that is then resolvable by id despite having no local transcript', () => {
    const t = task({ id: 'cafe0001', sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    registerHostSession(t, { cwd: '/home/me/proj', prompt: 'do the work' });

    const byId = findSessionsById('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(byId).toHaveLength(1);
    expect(byId[0].label).toBe('[host/box]');
    expect(byId[0].filePath).toBe('');
    expect(byId[0].machine).toBe('box');

    // The empty-file_path row survives the querySessions stale-file filter — a
    // real local session with a missing file would be dropped here.
    const all = querySessions({ idPrefix: 'aaaaaaaa' });
    expect(all).toHaveLength(1);
  });
});

describe('captureRemoteSessionId', () => {
  // The full non-Claude host path: a run that took no forced --session-id, whose
  // remote coined its own id and printed it via --emit-session-id into the log.
  function writeLog(id: string, marker: string): void {
    fs.mkdirSync(hostsCacheDir(), { recursive: true });
    fs.writeFileSync(localLogPath(id), `booting codex...\ndid the work\n${marker}exited 0\n`);
  }

  it('captures the remote-coined id from the followed log and stamps it on the task', () => {
    const t = task({ id: 'feed0001', agent: 'codex', sessionId: undefined });
    saveTask(t);
    writeLog('feed0001', sessionIdMarkerLine('codex-real-9f3a'));

    const updated = captureRemoteSessionId(t);
    expect(updated).not.toBeNull();
    expect(updated!.sessionId).toBe('codex-real-9f3a');
    // Persisted, not just returned — so findTaskBySessionId works after this.
    expect(loadTask('feed0001')!.sessionId).toBe('codex-real-9f3a');

    // And the captured id makes the run registerable + resolvable by id.
    registerHostSession(updated!, { cwd: '/home/me/proj', prompt: 'do it' });
    expect(findSessionsById('codex-real-9f3a')).toHaveLength(1);
  });

  it('is a no-op when the task already carries a forced id (never overwrites Claude/resume)', () => {
    const t = task({ id: 'feed0002', agent: 'claude', sessionId: 'forced-claude-id' });
    saveTask(t);
    // Even if a stray marker sat in the log, the authoritative forced id wins.
    writeLog('feed0002', sessionIdMarkerLine('should-be-ignored'));
    expect(captureRemoteSessionId(t)).toBeNull();
    expect(loadTask('feed0002')!.sessionId).toBe('forced-claude-id');
  });

  it('returns null when the log carries no marker (hookless remote agent)', () => {
    const t = task({ id: 'feed0003', agent: 'codex', sessionId: undefined });
    saveTask(t);
    fs.mkdirSync(hostsCacheDir(), { recursive: true });
    fs.writeFileSync(localLogPath('feed0003'), 'ran, but printed no session marker\n');
    expect(captureRemoteSessionId(t)).toBeNull();
    expect(loadTask('feed0003')!.sessionId).toBeUndefined();
  });
});
