import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Real path: recordBrowserAction upserts the durable browser_sessions row that
// `agents browser sessions` reads. Drives a real sqlite DB under a temp HOME, no
// mocks (per the repo-wide real-services rule). `vi.resetModules()` re-imports
// the db module per test so its cached connection re-opens under this test's HOME.

let testHome = '';

async function fresh() {
  vi.resetModules();
  const record = await import('./record.js');
  const db = await import('../session/db.js');
  return { ...record, ...db };
}

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-record-'));
  process.env.HOME = testHome;
  process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
});

afterEach(() => {
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('recordBrowserAction', () => {
  it('upserts a durable browser_sessions row from a task+profile action event', async () => {
    const { recordBrowserAction, listBrowserSessionRecords } = await fresh();
    recordBrowserAction({
      event: 'browser.action',
      command: 'navigate',
      invocationId: 'run-1',
      task: 'swift-crab-a1b2',
      profile: 'work',
      url: 'https://example.com',
      sessionId: 'sess-1',
      launchId: 'launch-1',
      actor: 'claude',
    });
    const rows = listBrowserSessionRecords('work');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      task: 'swift-crab-a1b2',
      profile: 'work',
      sessionId: 'sess-1',
      actor: 'claude',
    });
  });

  it('records the driven host from a --device event so a remote task is attributed', async () => {
    const { recordBrowserAction, listBrowserSessionRecords } = await fresh();
    recordBrowserAction(
      { event: 'browser.action', command: 'screenshot', task: 't', profile: 'work', host: 'zion' },
      { device: 'zion' },
    );
    expect(listBrowserSessionRecords('work')[0].machine).toBe('zion');
  });

  it('skips an event with no task/profile — a lifecycle verb is not a task row', async () => {
    const { recordBrowserAction, listBrowserSessionRecords } = await fresh();
    recordBrowserAction({ event: 'browser.action', command: 'status' });
    recordBrowserAction({ event: 'browser.action', command: 'profiles', profile: 'work' });
    expect(listBrowserSessionRecords()).toHaveLength(0);
  });

  it('never throws — a bookkeeping failure must not fail a completed action', async () => {
    const { recordBrowserAction } = await fresh();
    expect(() => recordBrowserAction({ command: 'navigate' } as never)).not.toThrow();
  });
});
