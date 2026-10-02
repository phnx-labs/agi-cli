/**
 * RUSH-2682: the live-registry → SessionMeta bridge. A running session the live
 * registry already knows about must become a resolvable SessionMeta candidate so
 * `preview` / `resume` / `focus` render it instead of "No session matching",
 * even before its transcript reaches the lazy index. Pure — deterministic given
 * `self` + `nowMs`, so it needs no DB or process table.
 */
import { describe, it, expect } from 'vitest';
import {
  activeSessionToSessionMeta,
  fleetExecutionMachineById,
  liveSessionMetas,
  reconcileLiveMetaMachine,
} from './live-metadata.js';
import type { ActiveSession } from './active.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';

function active(partial: Partial<ActiveSession>): ActiveSession {
  return {
    context: 'headless',
    kind: 'claude',
    status: 'running',
    ...partial,
  } as ActiveSession;
}

describe('activeSessionToSessionMeta', () => {
  const self = 'this-box';
  const now = 1_700_000_000_000;

  it('reshapes a running session into a resolvable SessionMeta', () => {
    const meta = activeSessionToSessionMeta(
      active({
        sessionId: 'b947a623-1111-2222-3333-444444444444',
        kind: 'claude',
        cwd: '/home/me/repo',
        project: 'repo',
        label: 'do the thing',
        topic: 'a topic',
        version: '2.1.226',
        sessionFile: '/home/me/.claude/projects/p/b947a623.jsonl',
        startedAtMs: now - 5_000,
        lastActivityMs: now - 1_000,
        ticket: { id: 'RUSH-2682' },
        pr: { url: 'https://github.com/o/r/pull/9', number: 9 },
        worktree: { path: '/w', slug: 'wt', branch: 'feat' },
      }),
      self,
      now,
    );
    expect(meta).not.toBeNull();
    expect(meta!.id).toBe('b947a623-1111-2222-3333-444444444444');
    expect(meta!.shortId).toBe('b947a623');
    expect(meta!.agent).toBe('claude');
    expect(meta!.harness).toBeUndefined();
    // The transcript path rides across, so buildPreview parses the real digest
    // when the file is on disk.
    expect(meta!.filePath).toBe('/home/me/.claude/projects/p/b947a623.jsonl');
    expect(meta!.cwd).toBe('/home/me/repo');
    expect(meta!.project).toBe('repo');
    expect(meta!.label).toBe('do the thing');
    expect(meta!.version).toBe('2.1.226');
    expect(meta!.firstUserMessage).toBeUndefined();
    expect(meta!.machine).toBe(self);
    expect(meta!._remote).toBe(false);
    expect(meta!.ticketId).toBe('RUSH-2682');
    expect(meta!.prUrl).toBe('https://github.com/o/r/pull/9');
    expect(meta!.prNumber).toBe(9);
    expect(meta!.worktreeSlug).toBe('wt');
    expect(meta!.gitBranch).toBe('feat');
    expect(meta!.timestamp).toBe(new Date(now - 5_000).toISOString());
    expect(meta!.lastActivity).toBe(new Date(now - 1_000).toISOString());
  });

  it('copies firstUserMessage from the live row (PHNX-3621 leftover)', () => {
    const meta = activeSessionToSessionMeta(
      active({
        sessionId: 'b947a623-1111-2222-3333-444444444444',
        firstUserMessage: 'the full originating request',
      }),
      self,
      now,
    );
    expect(meta!.firstUserMessage).toBe('the full originating request');
  });

  it('carries the custom-harness stamp so preview of a live deepseek run is not claude (PHNX-2935)', () => {
    const meta = activeSessionToSessionMeta(
      active({
        sessionId: 'b947a623-1111-2222-3333-444444444444',
        kind: 'claude',
        harness: 'deepseek',
      }),
      self,
      now,
    );
    expect(meta!.agent).toBe('claude');
    expect(meta!.harness).toBe('deepseek');
  });

  it('leaves filePath empty when the transcript has no path yet (renders header + live note)', () => {
    const meta = activeSessionToSessionMeta(
      active({ sessionId: 'aaaa1111-0000-0000-0000-000000000000', sessionFile: undefined }),
      self,
      now,
    );
    expect(meta!.filePath).toBe('');
  });

  it('honors an execution machine already stamped on the row', () => {
    const meta = activeSessionToSessionMeta(
      active({ sessionId: 'aaaa2222-0000-0000-0000-000000000000', machine: 'peer-box' }),
      self,
      now,
    );
    expect(meta!.machine).toBe('peer-box');
    expect(meta!._remote).toBe(true);
  });

  it('drops a row with no session id — nothing durable to resolve', () => {
    expect(activeSessionToSessionMeta(active({ sessionId: undefined }), self, now)).toBeNull();
  });

  it('drops a row whose kind is not a session-tracked harness (cloud/team rows)', () => {
    expect(
      activeSessionToSessionMeta(
        active({ sessionId: 'aaaa3333-0000-0000-0000-000000000000', kind: 'cloud' }),
        self,
        now,
      ),
    ).toBeNull();
  });

  it('falls back to nowMs when the row carries no start time', () => {
    const meta = activeSessionToSessionMeta(
      active({ sessionId: 'aaaa4444-0000-0000-0000-000000000000', startedAtMs: undefined }),
      self,
      now,
    );
    expect(meta!.timestamp).toBe(new Date(now).toISOString());
  });
});

describe('liveSessionMetas', () => {
  it('maps the eligible rows and drops the rest', () => {
    const self = 'this-box';
    const now = 1_700_000_000_000;
    const rows = liveSessionMetas(
      [
        active({ sessionId: 'aaaa0001-0000-0000-0000-000000000000', kind: 'claude' }),
        active({ sessionId: undefined }),                       // dropped: no id
        active({ sessionId: 'aaaa0002-0000-0000-0000-000000000000', kind: 'cloud' }), // dropped: not an agent
        active({ sessionId: 'aaaa0003-0000-0000-0000-000000000000', kind: 'codex' }),
      ],
      self,
      now,
    );
    expect(rows.map(r => r.id)).toEqual([
      'aaaa0001-0000-0000-0000-000000000000',
      'aaaa0003-0000-0000-0000-000000000000',
    ]);
  });
});

/**
 * PHNX-3890: a dispatcher's launcher-shim row (no transcript, `machine`
 * self-defaulted) must be re-attributed to the box the AGENT runs on, so a read
 * follows the transcript owner instead of dead-ending here. These cover the
 * pure branch matrix directly; the resolver-level behavior is driven end to end
 * in `commands/sessions.remote-preview-attribution.test.ts`.
 */
describe('fleetExecutionMachineById', () => {
  it('keys the agent machine by lowercased id', () => {
    const map = fleetExecutionMachineById([
      active({ sessionId: 'AAAA0001-0000-0000-0000-000000000000', machine: 'peer-box' }),
    ]);
    expect(map.get('aaaa0001-0000-0000-0000-000000000000')).toBe('peer-box');
  });

  it('reads `machine` (the agent) and never `offloadedFrom` (the launcher)', () => {
    const map = fleetExecutionMachineById([
      active({
        sessionId: 'aaaa0002-0000-0000-0000-000000000000',
        machine: 'peer-box',
        offloadedFrom: 'this-box',
      } as Partial<ActiveSession>),
    ]);
    expect(map.get('aaaa0002-0000-0000-0000-000000000000')).toBe('peer-box');
  });

  it('skips rows with no id or no machine', () => {
    const map = fleetExecutionMachineById([
      active({ sessionId: undefined, machine: 'peer-box' }),
      active({ sessionId: 'aaaa0003-0000-0000-0000-000000000000', machine: undefined }),
    ]);
    expect(map.size).toBe(0);
  });
});

describe('reconcileLiveMetaMachine', () => {
  const self = 'this-box';
  const id = 'bbbb0001-0000-0000-0000-000000000000';
  const meta = (over: Partial<SessionMeta> = {}): SessionMeta =>
    ({ id, shortId: 'bbbb0001', agent: 'claude', timestamp: '', filePath: '', machine: self, ...over }) as SessionMeta;

  it('re-attributes a self-defaulted transcript-less row to the fleet-named peer', () => {
    const [row] = reconcileLiveMetaMachine([meta()], new Map([[id, 'peer-box']]), self);
    expect(row.machine).toBe('peer-box');
    expect(row._remote).toBe(true);
  });

  it('does NOT treat a snapshot entry naming THIS box as confirmation', () => {
    // The snapshot is a merge that includes this box's own rows, so for the very
    // shape being corrected here a `self` entry may just echo the self-default —
    // recorded while the owning peer had not reported yet. Trusting it would skip
    // the fan-out and dead-end on the local stub (the PHNX-3890 bug itself).
    const [row] = reconcileLiveMetaMachine([meta()], new Map([[id, self]]), self);
    expect(row.machine).toBe(self);
    expect(row._remote).toBeFalsy();
  });

  it('leaves a row the fleet does not know about alone', () => {
    const [row] = reconcileLiveMetaMachine([meta()], new Map(), self);
    expect(row.machine).toBe(self);
  });

  it('never touches a row carrying a transcript on this disk', () => {
    const [row] = reconcileLiveMetaMachine(
      [meta({ filePath: '/t.jsonl' })],
      new Map([[id, 'peer-box']]),
      self,
    );
    expect(row.machine).toBe(self);
  });

  it('never touches a row already attributed to another box', () => {
    const [row] = reconcileLiveMetaMachine(
      [meta({ machine: 'other-box' })],
      new Map([[id, 'peer-box']]),
      self,
    );
    expect(row.machine).toBe('other-box');
  });

  it('matches case-insensitively on the id', () => {
    const [row] = reconcileLiveMetaMachine(
      [meta({ id: id.toUpperCase() })],
      new Map([[id, 'peer-box']]),
      self,
    );
    expect(row.machine).toBe('peer-box');
  });
});
