import { describe, it, expect } from 'vitest';
import { resolveMessageTarget, mailboxIdForActiveSession, decideHostTaskRoute } from './mailbox-target.js';
import type { ActiveSession } from './session/active.js';
import type { HostTask } from './hosts/tasks.js';

function mk(over: Partial<ActiveSession>): ActiveSession {
  return { context: 'headless', kind: 'claude', status: 'running', ...over };
}

const noCloud = () => false;

function mkTask(over: Partial<HostTask>): HostTask {
  return {
    id: 'task-1',
    host: 'yosemite-s0',
    target: 'yosemite-s0.tail1a85a1.ts.net',
    agent: 'claude',
    prompt: 'do a thing',
    remoteLog: '$HOME/.agents/.cache/hosts/aaaa.log',
    remoteExit: '$HOME/.agents/.cache/hosts/aaaa.exit',
    status: 'running',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe('resolveMessageTarget', () => {
  it('routes a cloud task id to the cloud path (checked first)', () => {
    const res = resolveMessageTarget('task-123', [], (id) => id === 'task-123');
    expect(res).toEqual({ kind: 'cloud', id: 'task-123' });
  });

  it('resolves an exact sessionId to that one local box', () => {
    const sessions = [mk({ sessionId: 'aaaa-1111' }), mk({ sessionId: 'bbbb-2222' })];
    expect(resolveMessageTarget('aaaa-1111', sessions, noCloud)).toEqual({ kind: 'local', id: 'aaaa-1111' });
  });

  it('resolves a unique prefix to one box', () => {
    const sessions = [mk({ sessionId: 'aaaa-1111' }), mk({ sessionId: 'bbbb-2222' })];
    expect(resolveMessageTarget('aaaa', sessions, noCloud)).toEqual({ kind: 'local', id: 'aaaa-1111' });
  });

  it('errors (never guesses) when a prefix matches more than one agent', () => {
    const sessions = [
      mk({ sessionId: 'aaaa-1111', topic: 'refactor' }),
      mk({ sessionId: 'aaaa-2222', topic: 'tests' }),
    ];
    const res = resolveMessageTarget('aaaa', sessions, noCloud);
    expect(res.kind).toBe('ambiguous');
    if (res.kind === 'ambiguous') {
      expect(res.candidates.map((c) => c.id).sort()).toEqual(['aaaa-1111', 'aaaa-2222']);
      expect(res.candidates[0].label).toBeTruthy();
    }
  });

  it('returns none when nothing matches', () => {
    expect(resolveMessageTarget('zzzz', [mk({ sessionId: 'aaaa-1111' })], noCloud)).toEqual({ kind: 'none' });
  });

  it('keys a teams teammate box by agentId', () => {
    const s = mk({ context: 'teams', agentId: 'agent-uuid', sessionId: 'agent-uuid', teamName: 'feat' });
    expect(mailboxIdForActiveSession(s)).toBe('agent-uuid');
    expect(resolveMessageTarget('agent-uuid', [s], noCloud)).toEqual({ kind: 'local', id: 'agent-uuid' });
  });

  it('routes to agentId even when sessionId differs (RUSH-1534 regression)', () => {
    const s = mk({
      context: 'teams',
      agentId: 'teams-minted-uuid',
      sessionId: 'runtime-session-uuid',
      teamName: 'feat',
    });
    expect(mailboxIdForActiveSession(s)).toBe('teams-minted-uuid');
    expect(resolveMessageTarget('teams-minted-uuid', [s], noCloud)).toEqual({
      kind: 'local',
      id: 'teams-minted-uuid',
    });
    expect(resolveMessageTarget('runtime-session-uuid', [s], noCloud)).toEqual({
      kind: 'local',
      id: 'teams-minted-uuid',
    });
  });

  it('collapses multiple rows that share one canonical id (subagents/forks) to a single box', () => {
    const sessions = [
      mk({ sessionId: 'aaaa-1111', pidCount: 2 }),
      mk({ sessionId: 'aaaa-1111', pidCount: 2 }),
    ];
    expect(resolveMessageTarget('aaaa-1111', sessions, noCloud)).toEqual({ kind: 'local', id: 'aaaa-1111' });
  });

  it('treats an empty target as no match (no startsWith-matches-everything footgun)', () => {
    const sessions = [mk({ sessionId: 'aaaa-1111' }), mk({ sessionId: 'bbbb-2222' })];
    expect(resolveMessageTarget('', sessions, noCloud)).toEqual({ kind: 'none' });
    expect(resolveMessageTarget('', [mk({ sessionId: 'only-one' })], noCloud)).toEqual({ kind: 'none' });
  });

  it('exact match wins over a prefix that would be ambiguous', () => {
    const sessions = [mk({ sessionId: 'aaaa' }), mk({ sessionId: 'aaaa-longer' })];
    expect(resolveMessageTarget('aaaa', sessions, noCloud)).toEqual({ kind: 'local', id: 'aaaa' });
  });
});

describe('decideHostTaskRoute', () => {
  it('returns not-found when no host task matches the target', () => {
    expect(decideHostTaskRoute(null, 'nope')).toEqual({ kind: 'not-found' });
  });

  it('reroutes to the owning host, preferring the remote session id over the typed target', () => {
    const task = mkTask({ status: 'running', host: 'yosemite-s0', sessionId: 'claude-session-uuid' });
    expect(decideHostTaskRoute(task, 'my-dispatch-name')).toEqual({
      kind: 'reroute',
      remoteRef: 'claude-session-uuid',
      host: 'yosemite-s0',
    });
  });

  it('falls back to the --name handle when no session id was captured yet', () => {
    const task = mkTask({ status: 'running', host: 'yosemite-s0', sessionId: undefined, name: 'nightly-audit' });
    expect(decideHostTaskRoute(task, 'nightly-audit')).toEqual({
      kind: 'reroute',
      remoteRef: 'nightly-audit',
      host: 'yosemite-s0',
    });
  });

  it('falls back to the typed target itself when neither a session id nor a name exist', () => {
    const task = mkTask({ status: 'running', host: 'yosemite-s0', sessionId: undefined, name: undefined });
    expect(decideHostTaskRoute(task, 'raw-dispatch-id')).toEqual({
      kind: 'reroute',
      remoteRef: 'raw-dispatch-id',
      host: 'yosemite-s0',
    });
  });

  it('reports a finished task rather than silently rerouting to a dead dispatch', () => {
    const task = mkTask({ status: 'completed', host: 'yosemite-s0', exitCode: 0 });
    expect(decideHostTaskRoute(task, 'x')).toEqual({
      kind: 'finished',
      host: 'yosemite-s0',
      status: 'completed',
      exitCode: 0,
    });
  });

  it('reports a failed task with its exit code', () => {
    const task = mkTask({ status: 'failed', host: 'yosemite-s0', exitCode: 1 });
    expect(decideHostTaskRoute(task, 'x')).toEqual({
      kind: 'finished',
      host: 'yosemite-s0',
      status: 'failed',
      exitCode: 1,
    });
  });
});
