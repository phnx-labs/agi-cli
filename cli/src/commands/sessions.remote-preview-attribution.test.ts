/**
 * PHNX-3890: `agents sessions preview <full-uuid>` of a session running on a PEER
 * must render that peer's digest, not the local "not indexed here" stub.
 *
 * The failure was a locality conflation on the DISPATCHER box. A box that
 * launched a session executing elsewhere holds a live launcher-shim row for it:
 * no transcript on disk, and a `machine` that defaulted to itself
 * (`active.machine ?? self`). The full-UUID resolver treated any local hit as
 * definitive and returned with zero fan-out, so the read was routed back to a box
 * with no transcript. A passive peer, holding no local row at all, fanned out and
 * rendered the same session fine — the tell that the local row was the problem.
 *
 * Reproduced here at the real seam: `resolveSessionMetadataValue` against the
 * real SQLite index and the real live-registry bridge, with only the two I/O
 * edges injected (the live/fleet snapshot readers and the SSH fan-out). HOME is
 * pinned before importing db.js/sessions.js so the index stays under the fixture.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stripVTControlCharacters } from 'node:util';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-remote-attrib-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.AGENTS_SYNC_MACHINE_ID = 'this-box';

const dbModule = await import('../lib/session/db.js');
const { upsertSession, closeDB } = dbModule;
const {
  computeLocalMetadataMatches,
  resolveSessionMetadataValue,
  isLocallyDefinitiveMatch,
  preferOwnerAttribution,
} = await import('./sessions.js');
type ActiveSession = import('../lib/session/active.js').ActiveSession;
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;
type LoadActive = typeof import('../lib/session/session-cache.js').loadLocalActiveSessions;
type GatherRemoteList = typeof import('../lib/session/remote/remote-list.js').gatherRemoteList;

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  delete process.env.AGENTS_SYNC_MACHINE_ID;
});

const SELF = 'this-box';
const PEER = 'peer-box';
/** The session whose agent + transcript live on PEER, launched from SELF. */
const DISPATCHED_ID = 'a1b2c3d4-1111-2222-3333-444444444444';

function transcript(id: string): string {
  const file = path.join(TEST_HOME, '.claude', 'projects', 'p', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n');
  return file;
}

/**
 * The launcher-shim row a dispatcher holds: the launch process is here, so the
 * registry lists it, but there is no transcript on this disk and no machine to
 * attribute it to — `activeSessionToSessionMeta` defaults that to `self`.
 */
function launcherShimRow(id: string): ActiveSession {
  return {
    context: 'interactive',
    kind: 'claude',
    status: 'running',
    sessionId: id,
    cwd: '/home/me/repo',
    startedAtMs: Date.now(),
    sessionFile: undefined,
    machine: undefined,
    host: 'codium',
  } as unknown as ActiveSession;
}

/** How the fleet-wide `agents sessions --active` merge reports the same session:
 * attributed to the box the AGENT runs on. */
function fleetActiveRow(id: string, machine: string): ActiveSession {
  return { ...launcherShimRow(id), machine } as ActiveSession;
}

function loader(sessions: ActiveSession[]): LoadActive {
  return (async () => ({ sessions, servedFromCache: false, capturedAt: Date.now() })) as unknown as LoadActive;
}

/** A peer answering the `--resolve-safe-v1` sweep. The real fan-out stamps
 * `machine` + `_remote` on every row it brings back (remote-list.ts:128,164). */
function peerAnswer(id: string, machine = PEER): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: new Date().toISOString(),
    filePath: `/home/me/.claude/projects/p/${id}.jsonl`,
    machine,
    _remote: true,
  } as SessionMeta;
}

function fanOut(sessions: SessionMeta[], unreachable: string[] = []): GatherRemoteList {
  return (async () => ({ sessions, unreachable })) as unknown as GatherRemoteList;
}

describe('remote-session preview attribution (PHNX-3890)', () => {
  it('attributes a transcript-less launcher shim to the peer the fleet says runs it', async () => {
    // The fleet-active snapshot is the only local source that knows the truth
    // when no index row has synced yet.
    const matches = await computeLocalMetadataMatches(DISPATCHED_ID, {}, {
      loadActive: loader([launcherShimRow(DISPATCHED_ID)]),
      loadFleetActive: () => [fleetActiveRow(DISPATCHED_ID, PEER)],
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].machine).toBe(PEER);
    expect(matches[0]._remote).toBe(true);
  });

  it('leaves a genuinely local just-started session attributed here (RUSH-2682 intact)', async () => {
    const localId = 'bbbbbbbb-1111-2222-3333-444444444444';
    const row = { ...launcherShimRow(localId), sessionFile: transcript(localId) } as ActiveSession;
    const matches = await computeLocalMetadataMatches(localId, {}, {
      loadActive: loader([row]),
      loadFleetActive: () => [fleetActiveRow(localId, SELF)],
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].machine).toBe(SELF);
    expect(matches[0]._remote).toBeFalsy();
  });

  it('consults the fleet for a full UUID whose only local match is a launcher shim', async () => {
    // The zion case: fleet-active snapshot cold, so the shim still reads as
    // local. The short-circuit must NOT fire, and the peer's row must win.
    const gather = vi.fn(fanOut([peerAnswer(DISPATCHED_ID)]));
    const outcome = await resolveSessionMetadataValue(DISPATCHED_ID, {}, {
      gatherRemoteList: gather as unknown as GatherRemoteList,
      loadActive: loader([launcherShimRow(DISPATCHED_ID)]),
      loadFleetActive: () => [],
    });
    expect(gather).toHaveBeenCalled();
    expect(outcome.kind).toBe('resolved');
    const resolved = (outcome as { kind: 'resolved'; session: SessionMeta }).session;
    expect(resolved.machine).toBe(PEER);
    expect(resolved._remote).toBe(true);
    expect(resolved.filePath).toBeTruthy();
  });

  it('resolves a locally readable transcript with zero fan-out (no needless SSH hop)', async () => {
    const indexedId = 'cccccccc-1111-2222-3333-444444444444';
    upsertSession(
      {
        id: indexedId,
        shortId: 'cccccccc',
        agent: 'claude',
        timestamp: new Date().toISOString(),
        filePath: transcript(indexedId),
        machine: SELF,
      },
      '{}\n',
    );
    const gather = vi.fn(fanOut([]));
    const outcome = await resolveSessionMetadataValue(indexedId, {}, {
      gatherRemoteList: gather as unknown as GatherRemoteList,
    });
    expect(outcome.kind).toBe('resolved');
    expect(gather).not.toHaveBeenCalled();
  });

  it('resolves a synced mirror locally even though it is owned by a peer', async () => {
    // A mirror has a real filePath on THIS disk, so it renders here without an
    // SSH hop even though `machine` names its owner.
    const mirrorId = 'dddddddd-1111-2222-3333-444444444444';
    upsertSession(
      {
        id: mirrorId,
        shortId: 'dddddddd',
        agent: 'claude',
        timestamp: new Date().toISOString(),
        filePath: transcript(mirrorId),
        machine: PEER,
      },
      '{}\n',
    );
    const gather = vi.fn(fanOut([]));
    const outcome = await resolveSessionMetadataValue(mirrorId, {}, {
      gatherRemoteList: gather as unknown as GatherRemoteList,
    });
    expect(outcome.kind).toBe('resolved');
    expect(gather).not.toHaveBeenCalled();
  });

  it('does NOT skip the sweep because the snapshot names THIS box', async () => {
    // The fleet snapshot is a merge that INCLUDES this box's own rows, so for a
    // transcript-less row with no index row to fold from, a `self` entry may be
    // an echo of the self-default rather than proof. Trusting it would resurrect
    // the PHNX-3890 dead end whenever the owning peer had not reported yet.
    const echoedId = '11111111-aaaa-bbbb-cccc-222222222222';
    const gather = vi.fn(fanOut([peerAnswer(echoedId)]));
    const outcome = await resolveSessionMetadataValue(echoedId, {}, {
      gatherRemoteList: gather as unknown as GatherRemoteList,
      loadActive: loader([launcherShimRow(echoedId)]),
      loadFleetActive: () => [fleetActiveRow(echoedId, SELF)],
    });
    expect(gather).toHaveBeenCalled();
    expect((outcome as { kind: 'resolved'; session: SessionMeta }).session.machine).toBe(PEER);
  });

  it('keeps the local shim when no peer answers for it', async () => {
    // With no fleet evidence at all, a transcript-less self-attributed row is
    // indistinguishable from a session this box just started — so it must still
    // resolve here rather than becoming a not-found.
    const gather = vi.fn(fanOut([]));
    const outcome = await resolveSessionMetadataValue(DISPATCHED_ID, {}, {
      gatherRemoteList: gather as unknown as GatherRemoteList,
      loadActive: loader([launcherShimRow(DISPATCHED_ID)]),
      loadFleetActive: () => [],
    });
    expect(gather).toHaveBeenCalled();
    expect(outcome.kind).toBe('resolved');
    expect((outcome as { kind: 'resolved'; session: SessionMeta }).session.machine).toBe(SELF);
  });

  it('reports an unreachable fleet as partial rather than a silent local stub', async () => {
    const gather = vi.fn(fanOut([], [PEER]));
    const outcome = await resolveSessionMetadataValue('eeeeeeee-1111-2222-3333-444444444444', {}, {
      gatherRemoteList: gather as unknown as GatherRemoteList,
      loadActive: loader([]),
      loadFleetActive: () => [],
    });
    expect(outcome.kind).toBe('partial');
  });
});

describe('the corrected row renders the peer digest, not the local stub (PHNX-3890)', () => {
  it('routes a fleet-attributed launcher shim into the async peer-digest fetch', async () => {
    const picker = await import('./sessions-picker.js');
    // Resolve the shim exactly as `preview <id>` does, then render it.
    const [resolved] = await computeLocalMetadataMatches(DISPATCHED_ID, {}, {
      loadActive: loader([launcherShimRow(DISPATCHED_ID)]),
      loadFleetActive: () => [fleetActiveRow(DISPATCHED_ID, PEER)],
    });
    expect(picker.transcriptOnPeerOf(resolved)).toBe(PEER);

    let asked: string | undefined;
    picker.setPeerDigestFetcherForTest(async (_id: string, machine: string) => {
      asked = machine;
      return undefined;
    });
    try {
      const preview = stripVTControlCharacters(picker.buildPreview(resolved));
      // The acceptance criterion: the peer is named and the fetch is under way,
      // instead of the dead-end stub this box used to print for the session.
      expect(preview).toContain(PEER);
      expect(preview).toContain('fetching preview from');
      expect(preview).not.toContain('full transcript not indexed here');
      expect(asked).toBe(PEER);
    } finally {
      picker.setPeerDigestFetcherForTest(undefined);
      picker.clearRemoteDigestCacheForTest();
      picker.clearPreviewMemoryCacheForTest();
    }
  });
});

describe('isLocallyDefinitiveMatch (PHNX-3890)', () => {
  const base = { id: DISPATCHED_ID, shortId: 'a1b2c3d4', agent: 'claude', timestamp: '' } as SessionMeta;

  it('accepts a row with a real transcript on this disk', () => {
    expect(isLocallyDefinitiveMatch({ ...base, filePath: '/t.jsonl', machine: SELF }, SELF)).toBe(true);
  });

  it('accepts a row genuinely attributed to a peer', () => {
    expect(isLocallyDefinitiveMatch({ ...base, filePath: '', machine: PEER }, SELF)).toBe(true);
  });

  it('rejects the transcript-less self-defaulted launcher shim', () => {
    expect(isLocallyDefinitiveMatch({ ...base, filePath: '', machine: SELF }, SELF)).toBe(false);
  });
});

describe('preferOwnerAttribution (PHNX-3890)', () => {
  const shim = { id: DISPATCHED_ID, shortId: 'a1b2c3d4', agent: 'claude', timestamp: '', filePath: '', machine: SELF } as SessionMeta;

  it('drops a shim the owning peer has answered for', () => {
    expect(preferOwnerAttribution([shim], [peerAnswer(DISPATCHED_ID)], SELF)).toEqual([]);
  });

  it('keeps the shim when the peer answered about a different session', () => {
    const other = peerAnswer('ffffffff-1111-2222-3333-444444444444');
    expect(preferOwnerAttribution([shim], [other], SELF)).toEqual([shim]);
  });

  it('keeps a locally readable row even when a peer also answered', () => {
    const readable = { ...shim, filePath: '/t.jsonl' } as SessionMeta;
    expect(preferOwnerAttribution([readable], [peerAnswer(DISPATCHED_ID)], SELF)).toEqual([readable]);
  });

  it('is a no-op when the fan-out returned nothing', () => {
    expect(preferOwnerAttribution([shim], [], SELF)).toEqual([shim]);
  });
});
