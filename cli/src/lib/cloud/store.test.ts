import { afterAll, describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CloudTask } from './types.js';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-cloudstore-'));
process.env.HOME = TEST_HOME;

const { getCloudDir } = await import('../state.js');
const realHome = os.userInfo().homedir;
if (path.resolve(getCloudDir()).startsWith(path.resolve(realHome) + path.sep)) {
  throw new Error(`cloud store resolves to the real home (${getCloudDir()}); run the suite through vitest (bun run test), whose setup sandboxes HOME`);
}

const { insertTask, updateTaskStatus, getTaskById, closeStore, listActiveTasks, CLOUD_TASK_STALE_MS } = await import('./store.js');
const { registerCloudSession } = await import('./session-index.js');
const { findSessionsById, closeDB } = await import('../session/db.js');

afterAll(() => {
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
    expect(byId[0].filePath).toBe('');
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
    expect(getTaskById('019fb-exec-codex-2')!.prUrl).toBe('https://github.com/o/r/pull/9');
  });
});

describe('registerCloudSession guards', () => {
  it('skips a provider whose agent is not session-tracked (nothing to resolve by id)', () => {
    registerCloudSession({ ...cloudTask({ id: 'factory-run-1' }), provider: 'factory', agent: 'factory' });
    expect(findSessionsById('factory-run-1')).toHaveLength(0);
  });

  it('never seeds a row for a fabricated codex-<ts> id', () => {
    registerCloudSession(cloudTask({ id: 'codex-1720000000000 not valid' }));
    expect(findSessionsById('codex-1720000000000 not valid')).toHaveLength(0);
  });
});

describe('listActiveTasks only reports working tasks something has confirmed recently (PHNX-4326)', () => {
  const now = Date.parse('2026-10-11T12:00:00.000Z');
  const at = (ms: number) => new Date(ms).toISOString();

  it('drops a queued/running row whose last update is older than the bound, keeps fresh and idle rows', () => {
    insertTask(cloudTask({ id: 'stale-queued', status: 'queued', updatedAt: at(now - 99 * 86_400_000) }));
    insertTask(cloudTask({ id: 'stale-running', status: 'running', updatedAt: at(now - CLOUD_TASK_STALE_MS - 1_000) }));
    insertTask(cloudTask({ id: 'fresh-running', status: 'running', updatedAt: at(now - 60_000) }));
    insertTask(cloudTask({ id: 'stale-input', status: 'input_required', updatedAt: at(now - 30 * 86_400_000) }));
    insertTask(cloudTask({ id: 'done', status: 'completed', updatedAt: at(now - 60_000) }));

    const ids = (opts?: Parameters<typeof listActiveTasks>[0]) => listActiveTasks(opts).map(t => t.id).filter(id => !id.startsWith('019fb'));
    expect(ids({ nowMs: now }).sort()).toEqual(['fresh-running', 'stale-input']);
    expect(ids({ includeStale: true, nowMs: now }).sort()).toEqual(['fresh-running', 'stale-input', 'stale-queued', 'stale-running']);
  });
});
