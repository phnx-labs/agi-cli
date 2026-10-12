import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gatherActiveSessions } from '../lib/session/active.js';
import { NO_FANOUT_ENV } from '../lib/session/remote-active.js';
import {
  clearActiveSnapshotMemoryForTest,
  setActiveSessionsSnapshotPathForTest,
  writeActiveSessionsCache,
} from '../lib/session/session-cache.js';

describe('a peer answering a fleet sweep scans fresh', () => {
  let dir: string;
  let prevSnap: string | null;
  const prevEnv = process.env[NO_FANOUT_ENV];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-answer-'));
    prevSnap = setActiveSessionsSnapshotPathForTest(path.join(dir, 'snap.json'));
    writeActiveSessionsCache('local', [
      { context: 'headless', kind: 'claude', status: 'idle', sessionId: 'cached-only-row', pid: 999_999_001 },
    ]);
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env[NO_FANOUT_ENV];
    else process.env[NO_FANOUT_ENV] = prevEnv;
    setActiveSessionsSnapshotPathForTest(prevSnap);
    clearActiveSnapshotMemoryForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a local reader may serve the fresh snapshot', async () => {
    delete process.env[NO_FANOUT_ENV];
    const { sessions } = await gatherActiveSessions({ local: true });
    expect(sessions.map((s) => s.sessionId)).toContain('cached-only-row');
  });

  it('the sweep answer never comes from the snapshot, so the dispatcher can trust an absence', async () => {
    process.env[NO_FANOUT_ENV] = '1';
    const { sessions } = await gatherActiveSessions({ local: true });
    expect(sessions.map((s) => s.sessionId)).not.toContain('cached-only-row');
  });
});
