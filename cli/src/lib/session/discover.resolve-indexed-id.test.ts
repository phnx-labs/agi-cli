
import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-resolve-idx-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.AGENTS_SYNC_MACHINE_ID = 'this-box';

const dbModule = await import('./db.js');
const { upsertSession, closeDB } = dbModule;
const { resolveIndexedSessionById } = await import('./discover.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  delete process.env.AGENTS_SYNC_MACHINE_ID;
});

function transcriptPath(id: string): string {
  return path.join(TEST_HOME, '.claude', 'projects', 'p', `${id}.jsonl`);
}

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: new Date().toISOString(),
    filePath: transcriptPath(id),
    machine: 'this-box',
    ...extra,
  };
}

function seed(id: string): void {
  const file = transcriptPath(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n');
  upsertSession(meta(id), '{}\n');
}

const IDS = Array.from({ length: 24 }, (_, i) =>
  `${String(i).padStart(8, '0')}-1111-2222-3333-444444444444`,
);

describe('resolveIndexedSessionById', () => {
  it('resolves an exact full id from the index', async () => {
    seed(IDS[0]);
    const rows = await resolveIndexedSessionById(IDS[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(IDS[0]);
  });

  it('resolves an id prefix, and prefers exact over prefix siblings', async () => {
    const a = 'abcd1234-0000-0000-0000-000000000001';
    const b = 'abcd1234-0000-0000-0000-000000000002';
    seed(a);
    seed(b);
    const exact = await resolveIndexedSessionById(a);
    expect(exact.map((r) => r.id)).toEqual([a]);
    const prefix = await resolveIndexedSessionById('abcd1234');
    expect(prefix.map((r) => r.id).sort()).toEqual([a, b].sort());
  });

  it('returns [] on a genuine miss (caller falls back to the fleet resolver)', async () => {
    expect(await resolveIndexedSessionById('ffffffff-dead-dead-dead-deaddeaddead')).toEqual([]);
    expect(await resolveIndexedSessionById('   ')).toEqual([]);
  });

  it('rejects a contentless phantom row exactly as the fleet resolver would', async () => {
    const phantom = 'aaaaffff-1111-2222-3333-444455556666';
    upsertSession(meta(phantom), '');
    expect(await resolveIndexedSessionById(phantom)).toEqual([]);
  });

  it('keeps a file-gone but content-bearing (archived) session resolvable', async () => {
    const archived = 'bbbbcccc-1111-2222-3333-444455556666';
    upsertSession(meta(archived), 'user: do the thing\nassistant: done\n');
    const rows = await resolveIndexedSessionById(archived);
    expect(rows.map((r) => r.id)).toEqual([archived]);
  });

  it('takes no scan claim — a resolve leaves the scan slot free for the real scanner', async () => {
    seed(IDS[1]);
    await resolveIndexedSessionById(IDS[1]);
    await resolveIndexedSessionById('nope-not-here');
    expect(dbModule.tryClaimScan(process.pid)).toBe(true);
    dbModule.releaseScan(process.pid);
  });

  it('resolves >= 20 present-transcript ids concurrently with zero SQLITE_BUSY / database-is-locked', async () => {
    for (const id of IDS) seed(id);
    const results = await Promise.allSettled(IDS.map((id) => resolveIndexedSessionById(id)));
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toEqual([]);
    for (let i = 0; i < IDS.length; i++) {
      const r = results[i];
      expect(r.status).toBe('fulfilled');
      if (r.status === 'fulfilled') expect(r.value.map((s) => s.id)).toEqual([IDS[i]]);
    }
  });

  it('never dials the fleet — zero SSH fan-out on an indexed resolve', async () => {
    const remote = await import('./remote-list.js');
    const fanOut = vi.spyOn(remote, 'gatherRemoteList');
    const peerHop = vi.spyOn(remote, 'runOnPeer');
    seed(IDS[2]);
    await resolveIndexedSessionById(IDS[2]);
    await resolveIndexedSessionById('ffffffff-0000-0000-0000-000000000000');
    expect(fanOut).not.toHaveBeenCalled();
    expect(peerHop).not.toHaveBeenCalled();
    fanOut.mockRestore();
    peerHop.mockRestore();
  });
});
