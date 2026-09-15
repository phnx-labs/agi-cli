import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate a fresh HOME BEFORE importing state/db. db.ts captures DB_PATH at module
// load (db.ts:30), so redirecting it after the import silently opens the wrong
// database — the same pattern every migration test in this directory uses.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-toolsess-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

/**
 * Durable tool-session metadata (RUSH-2549).
 *
 * The bug these tests pin: browser task identity lived only in the daemon's
 * `tasks.json`, which `saveTaskState` rewrites from the LIVE task map — so
 * stopping a task erased the link to the agent session that drove it, and every
 * finished task in `agents sessions --browser` read "unlinked". Computer-use had
 * the identity right but wrote it to the event ledger, which prunes at 7 days.
 *
 * A real SQLite database on disk, no mocking (repo policy): these exercise the
 * actual write/read path the daemon and the CLI use.
 */
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

    // What the daemon does at task START.
    const captureDir = path.join(getProfileRuntimeDir(profile), 'sessions', task);
    fs.mkdirSync(captureDir, { recursive: true });
    fs.writeFileSync(path.join(captureDir, 'shot.png'), 'fake-png');
    recordBrowserSession({ task, profile, sessionId, actor: 'UNRESOLVED@zion', captureDir });

    // What `agents browser stop` does: the task leaves the live map, so the
    // rewritten tasks.json no longer mentions it. THIS is what used to destroy
    // the link. The captures on disk are untouched.
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
      () => null,                       // no launchId join available
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

    // A capture-count refresh knows the counts but not the identity.
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
    // The recovery caller already holds every recent invocation from the event
    // ledger and discards anything it has seen. A newest-N read therefore hands
    // it only rows it will throw away, and returns nothing usable once the table
    // exceeds the limit — silently restoring the day-8 disappearance this whole
    // feature removes. Bounding by "older than the ledger reaches" is what makes
    // recovery work on exactly the busy boxes that need it.
    const base = 1_700_000_000_000;
    for (let i = 0; i < 10; i++) {
      recordComputerSession({ invocationId: `bounded-${i}`, startedAt: base + i * 1000 });
    }
    const ledgerOldest = base + 7 * 1000; // the ledger still holds the newest three

    // Filter to this test's own rows: both reads are global over a DB shared
    // with the rest of the file, so a row inserted by another describe (which
    // defaults startedAt to Date.now(), far above `base`) would otherwise break
    // this with an unrelated-looking failure.
    const mine = (ids: string[]) => ids.filter((id) => id.startsWith('bounded-'));
    const newestOnly = mine(listComputerSessionRecords({ limit: 3 }).map((r) => r.invocationId!));
    const complement = mine(
      listComputerSessionRecords({ limit: 3, startedBeforeMs: ledgerOldest }).map((r) => r.invocationId!),
    );

    // A bare newest-N read hands back exactly what the ledger already covers.
    expect(newestOnly).toEqual(['bounded-9', 'bounded-8', 'bounded-7']);
    // The complement read hands back what the ledger CANNOT: the older tail.
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
    // Identity from the first call is kept, not overwritten by the bare ones.
    expect(row?.sessionId).toBe('sess-computer');
    expect(row?.taskPreview).toBe('open the dashboard');
  });
});
