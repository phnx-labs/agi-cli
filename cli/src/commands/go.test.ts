import { describe, it, expect } from 'vitest';
import {
  describeWhere,
  filterLivePool,
  remoteAttachEndedNotice,
  localLiveSelectorMatches,
  shouldSkipRemoteSweep,
  isDefinitiveLiveMatch,
  type Where,
} from './go.js';
import { SSH_CONN_FAILURE_CODE } from '../lib/ssh-exec.js';
import type { ActiveSession } from '../lib/session/active.js';

function s(over: Partial<ActiveSession>): ActiveSession {
  return { context: 'terminal', kind: 'claude', status: 'running', ...over } as ActiveSession;
}

describe('describeWhere — which jump path a live session takes', () => {
  const self = 'zion';

  it('local tmux → attach its tmux, label carries the pane', () => {
    const w = describeWhere(s({ machine: self, provenance: { mux: { kind: 'tmux', pane: '%3' } } as never }), self);
    expect(w.label).toContain('%3');
    expect(w.action).toBe('attach its tmux');
  });

  it('remote tmux → ssh + attach on the host', () => {
    const w = describeWhere(s({ machine: 'yosemite-s0', provenance: { mux: { kind: 'tmux', pane: '%117' } } as never }), self);
    expect(w.label).toContain('yosemite-s0');
    expect(w.action).toContain('ssh');
    expect(w.action).toContain('yosemite-s0');
  });

  it('local Ghostty (no mux) → focus its tab', () => {
    const w = describeWhere(s({ machine: self, host: 'ghostty' }), self);
    expect(w.action).toBe('focus its Ghostty tab');
  });

  it('remote non-tmux → open a shell on the host', () => {
    const w = describeWhere(s({ machine: 'yosemite-s1', host: 'bash' }), self);
    expect(w.action).toContain('shell');
    expect(w.action).toContain('yosemite-s1');
  });

  it('local, no attach rail → refuse (resume)', () => {
    const w: Where = describeWhere(s({ machine: self, host: 'terminal' }), self);
    expect(w.action).toContain('resume');
  });

  it('remote tmux beats the host check (a remote ghostty-hosted session still ssh-attaches)', () => {
    const w = describeWhere(s({ machine: 'box', host: 'ghostty', provenance: { mux: { kind: 'tmux', pane: '%9' } } as never }), self);
    expect(w.action).toContain('ssh');
  });
});

describe('PHNX-3298 — skip fleet when local already answered a live selector', () => {
  const uuid = 'c1a0de70-3298-4000-8000-000000003298';
  const other = 'c1a0de70-3298-4000-8000-00000000aaaa';
  const unrelated = 'dddddddd-0000-4000-8000-000000000000';

  it('a unique local full UUID is a skip (zero SSH)', () => {
    const local = [s({ sessionId: uuid })];
    expect(localLiveSelectorMatches(local, uuid)).toHaveLength(1);
    expect(shouldSkipRemoteSweep(localLiveSelectorMatches(local, uuid), uuid)).toBe(true);
    expect(shouldSkipRemoteSweep(localLiveSelectorMatches(local, uuid.toUpperCase()), uuid.toUpperCase())).toBe(true);
  });

  it('a unique-enough 8-hex with exactly one local live match skips the fleet', () => {
    const local = [s({ sessionId: uuid }), s({ sessionId: unrelated })];
    const matches = localLiveSelectorMatches(local, 'c1a0de70');
    expect(matches).toHaveLength(1);
    expect(shouldSkipRemoteSweep(matches, 'c1a0de70')).toBe(true);
  });

  it('a unique 4-hex local hit still races the fleet (remote may collide)', () => {
    const local = [s({ sessionId: uuid })];
    const matches = localLiveSelectorMatches(local, 'c1a0');
    expect(matches).toHaveLength(1);
    expect(shouldSkipRemoteSweep(matches, 'c1a0')).toBe(false);
  });

  it('two local matches fail closed without waiting for unanswered peers', () => {
    const local = [s({ sessionId: uuid }), s({ sessionId: other })];
    const matches = localLiveSelectorMatches(local, 'c1a0de70');
    expect(matches).toHaveLength(2);
    expect(shouldSkipRemoteSweep(matches, 'c1a0de70')).toBe(true);
  });

  it('two local 4-hex collisions fail closed without racing the fleet', () => {
    const local = [s({ sessionId: uuid }), s({ sessionId: other })];
    const matches = localLiveSelectorMatches(local, 'c1a0');
    expect(matches).toHaveLength(2);
    expect(shouldSkipRemoteSweep(matches, 'c1a0')).toBe(true);
  });

  it('a genuine miss still races the fleet', () => {
    const local = [s({ sessionId: unrelated })];
    expect(shouldSkipRemoteSweep(localLiveSelectorMatches(local, uuid), uuid)).toBe(false);
    expect(shouldSkipRemoteSweep(localLiveSelectorMatches([], 'c1a0de70'), 'c1a0de70')).toBe(false);
  });

  it('a full UUID is definitive on exact id only', () => {
    expect(isDefinitiveLiveMatch(s({ sessionId: uuid }), uuid)).toBe(true);
    expect(isDefinitiveLiveMatch(s({ sessionId: other }), uuid)).toBe(false);
    expect(isDefinitiveLiveMatch(s({ sessionId: uuid }), 'c1a0de70')).toBe(true);
    expect(isDefinitiveLiveMatch(s({ sessionId: uuid }), 'c1a0')).toBe(false);
  });
});

describe('filterLivePool — focus device + live-state scoping', () => {
  const pool = [
    s({ sessionId: 'a', machine: 'zion', status: 'orphaned' }),
    s({ sessionId: 'b', machine: 'yosemite-s0', status: 'orphaned' }),
    s({ sessionId: 'c', machine: 'yosemite-s0', status: 'running' }),
    s({ sessionId: 'd', machine: 'yosemite-s0', status: 'idle' }),
    s({ sessionId: 'e', machine: 'zion', status: 'crashed' }),
  ];
  const ids = (out: ActiveSession[]) => out.map((x) => x.sessionId);

  it('--device scopes the pool to s.machine === host', () => {
    expect(ids(filterLivePool(pool, { hosts: ['yosemite-s0'] }))).toEqual(['b', 'c', 'd']);
  });

  it('each status filter narrows to matching s.status', () => {
    expect(ids(filterLivePool(pool, { statuses: ['orphaned'] }))).toEqual(['a', 'b']);
    expect(ids(filterLivePool(pool, { statuses: ['crashed'] }))).toEqual(['e']);
    expect(ids(filterLivePool(pool, { statuses: ['idle'] }))).toEqual(['d']);
    expect(ids(filterLivePool(pool, { statuses: ['working'] }))).toEqual(['c']);
  });

  it('several status filters compose as a union', () => {
    expect(ids(filterLivePool(pool, { statuses: ['orphaned', 'crashed'] }))).toEqual(['a', 'b', 'e']);
  });

  it('device + status compose (only that host, only that status)', () => {
    expect(ids(filterLivePool(pool, { hosts: ['yosemite-s0'], statuses: ['orphaned'] }))).toEqual(['b']);
  });

  it('no filters returns the pool untouched (bare focus / focus --local unchanged)', () => {
    expect(filterLivePool(pool, {})).toBe(pool);
    expect(ids(filterLivePool(pool, {}))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('remoteAttachEndedNotice — ControlMaster close leaves the session id (RUSH-3227)', () => {
  const SID = '26d69286-a323-45a0-9a63-d75b90a66730';

  it('a clean detach prints closed + the full id + resume', () => {
    const s = remoteAttachEndedNotice(SID, 'yosemite-m2', 0);
    expect(s).toContain('Connection to yosemite-m2 closed.');
    expect(s).toContain(`Session ${SID}`);
    expect(s).toContain(`agents sessions resume ${SID}`);
  });

  it('a 255 drop prints dropped, not closed', () => {
    const s = remoteAttachEndedNotice(SID, 'yosemite-m2', SSH_CONN_FAILURE_CODE);
    expect(s).toContain('Connection to yosemite-m2 dropped.');
    expect(s).toContain(`Session ${SID}`);
  });

  it('no session id prints nothing (nothing copyable to hand back)', () => {
    expect(remoteAttachEndedNotice(undefined, 'yosemite-m2', 0)).toBeUndefined();
    expect(remoteAttachEndedNotice('', 'yosemite-m2', 0)).toBeUndefined();
  });
});
