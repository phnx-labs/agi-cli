/**
 * RUSH-2682: the id resolver behind `preview` / `resume` / `focus` MUST resolve a
 * session the live registry already knows about, even with no transcript row yet.
 * Indexing is lazy (only `discoverSessions` writes the index), so a session THIS
 * box just started is "running" in `agents sessions --active` minutes before it
 * is indexed — during which `preview`/`resume` said "No session matching". The
 * resolver now unions the indexed rows with the live registry on a cold id miss.
 *
 * HOME is pinned to a temp dir BEFORE importing db.js/discover.js/sessions.js so
 * the real (empty) SQLite index and any filesystem scan stay under the fixture.
 * Only the live-registry loader is injected — the DB path runs for real.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-live-resolve-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.AGENTS_SYNC_MACHINE_ID = 'this-box';

const dbModule = await import('../lib/session/db.js');
const { upsertSession, closeDB } = dbModule;
const { computeLocalMetadataMatches, liveMetadataMatches } = await import('./sessions.js');
type ActiveSession = import('../lib/session/active.js').ActiveSession;
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;
type LoadActive = typeof import('../lib/session/session-cache.js').loadLocalActiveSessions;

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  delete process.env.AGENTS_SYNC_MACHINE_ID;
});

const RUNNING_ID = 'b947a623-1111-2222-3333-444444444444';

function transcript(id: string): string {
  const file = path.join(TEST_HOME, '.claude', 'projects', 'p', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n');
  return file;
}

function activeRow(id: string, extra: Partial<ActiveSession> = {}): ActiveSession {
  return {
    context: 'headless',
    kind: 'claude',
    status: 'running',
    sessionId: id,
    cwd: '/home/me/repo',
    startedAtMs: Date.now(),
    sessionFile: transcript(id),
    ...extra,
  } as ActiveSession;
}

function loader(sessions: ActiveSession[]): LoadActive {
  return (async () => ({ sessions, servedFromCache: false, capturedAt: Date.now() })) as unknown as LoadActive;
}

describe('computeLocalMetadataMatches — live-registry cold-miss (RUSH-2682)', () => {
  it('resolves a running session from the live registry when the index is cold', async () => {
    const load = vi.fn(loader([activeRow(RUNNING_ID)]));
    const matches = await computeLocalMetadataMatches(RUNNING_ID, {}, { loadActive: load as unknown as LoadActive });
    expect(matches.map((m: SessionMeta) => m.id)).toEqual([RUNNING_ID]);
    expect(matches[0].machine).toBe('this-box');
    expect(load).toHaveBeenCalled();
  });

  it('forces one fresh gather when the warm snapshot missed the just-started session', async () => {
    // First call (cache) has no rows; the forced refresh surfaces the session.
    const calls: Array<{ forceRefresh?: boolean }> = [];
    const load = (async (opts?: { forceRefresh?: boolean }) => {
      calls.push(opts ?? {});
      return {
        sessions: opts?.forceRefresh ? [activeRow(RUNNING_ID)] : [],
        servedFromCache: !opts?.forceRefresh,
        capturedAt: Date.now(),
      };
    }) as unknown as LoadActive;
    const matches = await computeLocalMetadataMatches(RUNNING_ID, {}, { loadActive: load });
    expect(matches.map((m: SessionMeta) => m.id)).toEqual([RUNNING_ID]);
    expect(calls.some(c => c.forceRefresh)).toBe(true);
  });

  it('prefers the indexed row and never consults the live registry when the index hits', async () => {
    const indexedId = 'cccc0000-1111-2222-3333-444444444444';
    upsertSession(
      { id: indexedId, shortId: 'cccc0000', agent: 'claude', timestamp: new Date().toISOString(), filePath: transcript(indexedId), machine: 'this-box' },
      '{}\n',
    );
    const load = vi.fn(loader([activeRow(indexedId)]));
    const matches = await computeLocalMetadataMatches(indexedId, {}, { loadActive: load as unknown as LoadActive });
    expect(matches.map((m: SessionMeta) => m.id)).toEqual([indexedId]);
    expect(load).not.toHaveBeenCalled();
  });

  it('does not enter the live path for a keyword selector (id-shaped only)', async () => {
    const load = vi.fn(loader([activeRow('dddd0000-1111-2222-3333-444444444444')]));
    const matches = await computeLocalMetadataMatches('some keyword', {}, { loadActive: load as unknown as LoadActive });
    expect(matches).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it('returns [] on a genuine miss — no live row for the id', async () => {
    const load = loader([activeRow('eeee0000-1111-2222-3333-444444444444')]);
    const matches = await computeLocalMetadataMatches('ffffffff-dead-dead-dead-deaddeaddead', {}, { loadActive: load });
    expect(matches).toEqual([]);
  });

  it('yields no candidates (never throws) when the registry read fails', async () => {
    const load = (async () => { throw new Error('registry down'); }) as unknown as LoadActive;
    const matches = await liveMetadataMatches(RUNNING_ID, {}, 'this-box', { loadActive: load });
    expect(matches).toEqual([]);
  });
});
