import { afterAll, describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CloudTask } from './types.js';

// Isolate both stores under a temp HOME: state.js/db.js freeze their base dir from HOME at import
// time, and static imports are hoisted above the assignment. So set HOME first, then load the
// stores via top-level `await import`.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-cloudstore-'));
process.env.HOME = TEST_HOME;

const { insertTask, updateTaskStatus, getTaskById, closeStore } = await import('./store.js');
const { registerCloudSession } = await import('./session-index.js');
const { findSessionsById, closeDB } = await import('../session/db.js');

afterAll(() => {
  // Two databases live under TEST_HOME: sessions.db and cloud/tasks.db. Both
  // must be closed or Windows refuses to unlink the still-open one.
  closeDB();
  closeStore();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

function cloudTask(overrides: Partial<CloudTask> = {}): CloudTask {
  return {
    id: '019fb-exec-codex-1',
    provider: 'codex',
    status: 'queued',
    agent: 'codex',
    prompt: 'refactor the parser\nsecond line',
    repo: 'phnx-labs/agents-cli',
    branch: 'feat/x',
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

describe('insertTask reconciles the cloud store into the session index', () => {
  it('registers a session row keyed by the real execution id at dispatch', () => {
    insertTask(cloudTask());

    const byId = findSessionsById('019fb-exec-codex-1');
    expect(byId).toHaveLength(1);
    expect(byId[0].agent).toBe('codex');
    expect(byId[0].label).toBe('[cloud/queued] feat/x');
    expect(byId[0].filePath).toBe(''); // remote transcript sentinel
    expect(byId[0].topic).toBe('refactor the parser');
  });

  it('refreshes the [cloud/<status>] label on a status poll', () => {
    insertTask(cloudTask({ id: '019fb-exec-codex-2', status: 'queued' }));
    updateTaskStatus('019fb-exec-codex-2', 'running');
    expect(findSessionsById('019fb-exec-codex-2')[0].label).toBe('[cloud/running] feat/x');

    updateTaskStatus('019fb-exec-codex-2', 'completed', { prUrl: 'https://github.com/o/r/pull/9' });
    const done = findSessionsById('019fb-exec-codex-2')[0];
    expect(done.label).toBe('[cloud/completed] feat/x');
    expect(done.prUrl).toBe('https://github.com/o/r/pull/9');
    // The store row itself carries the PR url the poll wrote.
    expect(getTaskById('019fb-exec-codex-2')!.prUrl).toBe('https://github.com/o/r/pull/9');
  });
});

describe('registerCloudSession guards', () => {
  it('skips a provider whose agent is not session-tracked (nothing to resolve by id)', () => {
    registerCloudSession({ ...cloudTask({ id: 'factory-run-1' }), provider: 'factory', agent: 'factory' });
    expect(findSessionsById('factory-run-1')).toHaveLength(0);
  });

  it('never seeds a row for a fabricated codex-<ts> id', () => {
    // Belt-and-suspenders: codex.ts fails loud instead of minting one, but the
    // charset guard here also rejects an id that isn't a usable execution id.
    registerCloudSession(cloudTask({ id: 'codex-1720000000000 not valid' }));
    expect(findSessionsById('codex-1720000000000 not valid')).toHaveLength(0);
  });
});
