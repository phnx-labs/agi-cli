import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-toolsess-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getSessionsDir } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const {
  recordBrowserSession,
  listBrowserSessionRecords,
  getBrowserSessionRecord,
  recordComputerSession,
  listComputerSessionRecords,
  upsertSession,
  getSessionById,
} = await import('./db.js');

const { groupIntoRows } = await import('../browser/sessions-list.js');
const { loadDurableTaskIdentities } = await import('../browser/sessions-list.js');
const { getProfileRuntimeDir } = await import('../browser/paths.js');

type SessionMetaLike = Parameters<typeof upsertSession>[0];

function indexSession(id: string): void {
  const meta = {
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: '2026-08-10T00:00:00.000Z',
    filePath: path.join(TEST_HOME, `${id}.jsonl`),
    topic: 'drove a browser task',
  } as unknown as SessionMetaLike;
  fs.writeFileSync(path.join(TEST_HOME, `${id}.jsonl`), '');
  upsertSession(meta, 'drove a browser task');
}

describe('browser task identity survives the task (RUSH-2549)', () => {
  it('still resolves its agent session after the task stopped and tasks.json was emptied', () => {
    const profile = 'reg-profile@endpoint-0';
    const task = 'swift-phoenix-aurora';
    const sessionId = 'd34becfb-99c5-4b56-b3f6-a32e0d3f6747';
    indexSession(sessionId);

    const captureDir = path.join(getProfileRuntimeDir(profile), 'sessions', task);
    fs.mkdirSync(captureDir, { recursive: true });
    fs.writeFileSync(path.join(captureDir, 'shot.png'), 'fake-png');
    recordBrowserSession({ task, profile, sessionId, actor: 'UNRESOLVED@zion', captureDir });

    fs.writeFileSync(path.join(getProfileRuntimeDir(profile), 'tasks.json'), JSON.stringify({}));

    const identities = loadDurableTaskIdentities(profile);
    expect(identities.get(task)?.sessionId).toBe(sessionId);

    const rows = groupIntoRows(
      [{
        profile,
        artifacts: [{
          kind: 'screenshot', task, name: 'shot.png',
          path: path.join(captureDir, 'shot.png'), bytes: 8, mtimeMs: 1000,
        }],
      }],
      new Map([[profile, identities]]),
      () => null,
      (id) => getSessionById(id),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].linkStatus).toBe('linked');
    expect(rows[0].linkedSession?.id).toBe(sessionId);
  });

  it('never blanks a recorded session id when a later write carries none', () => {
    const profile = 'widen-profile@endpoint-0';
    const task = 'lucky-lynx-cedar';
    recordBrowserSession({ task, profile, sessionId: 'sess-keep-me', actor: 'someone@zion' });

    recordBrowserSession({ task, profile, counts: { screenshot: 4 } });

    const row = getBrowserSessionRecord(profile, task);
    expect(row?.sessionId).toBe('sess-keep-me');
    expect(row?.actor).toBe('someone@zion');
    expect(row?.counts.screenshot).toBe(4);
  });

  it('reports an unresolved link, not a fabricated one, when the session is not indexed', () => {
    const profile = 'unres-profile@endpoint-0';
    const task = 'bright-canyon-falcon';
    recordBrowserSession({ task, profile, sessionId: 'never-indexed-session' });

    const rows = groupIntoRows(
      [{
        profile,
        artifacts: [{
          kind: 'screenshot', task, name: 'a.png', path: '/x/a.png', bytes: 1, mtimeMs: 1,
        }],
      }],
      new Map([[profile, loadDurableTaskIdentities(profile)]]),
      () => null,
      (id) => getSessionById(id),
    );

    expect(rows[0].linkStatus).toBe('unresolved');
    expect(rows[0].linkedSession).toBeUndefined();
  });

  it('scopes listing to one profile', () => {
    recordBrowserSession({ task: 't1', profile: 'p-one@endpoint-0' });
    recordBrowserSession({ task: 't2', profile: 'p-two@endpoint-0' });
    expect(listBrowserSessionRecords('p-one@endpoint-0').map((r) => r.task)).toEqual(['t1']);
  });
});

describe('recovering runs past the read limit (RUSH-2549 review follow-up)', () => {
  it('returns the OLD complement, not the newest N the caller already has', () => {
    const base = 1_700_000_000_000;
    for (let i = 0; i < 10; i++) {
      recordComputerSession({ invocationId: `bounded-${i}`, startedAt: base + i * 1000 });
    }
    const ledgerOldest = base + 7 * 1000;

    const mine = (ids: string[]) => ids.filter((id) => id.startsWith('bounded-'));
    const newestOnly = mine(listComputerSessionRecords({ limit: 3 }).map((r) => r.invocationId!));
    const complement = mine(
      listComputerSessionRecords({ limit: 3, startedBeforeMs: ledgerOldest }).map((r) => r.invocationId!),
    );

    expect(newestOnly).toEqual(['bounded-9', 'bounded-8', 'bounded-7']);
    expect(complement).toEqual(['bounded-6', 'bounded-5', 'bounded-4']);
    for (const id of complement) expect(newestOnly).not.toContain(id);
  });
});

describe('computer-use invocation metadata outlives the event ledger (RUSH-2549)', () => {
  it('accumulates action_count across the many calls one invocation makes', () => {
    const invocationId = 'inv-abc-123';
    recordComputerSession({ invocationId, sessionId: 'sess-computer', taskPreview: 'open the dashboard' });
    recordComputerSession({ invocationId });
    recordComputerSession({ invocationId });

    const row = listComputerSessionRecords().find((r) => r.invocationId === invocationId);
    expect(row?.actionCount).toBe(3);
    expect(row?.sessionId).toBe('sess-computer');
    expect(row?.taskPreview).toBe('open the dashboard');
  });
});
