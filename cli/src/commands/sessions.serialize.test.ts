import { describe, it, expect } from 'vitest';
import { serializeSessionsJson, serializeActiveSessionsForJson } from './sessions.js';
import { ownerLabel } from './ps-roster.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import type { ActiveSession } from '../lib/session/active.js';


function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'abcdef12-3456-7890-abcd-ef1234567890',
    shortId: 'abcdef12',
    agent: 'claude',
    timestamp: '2026-07-07T10:00:00.000Z',
    filePath: '/home/u/.agents/.history/sessions/abcdef12.jsonl',
    ...over,
  };
}

describe('serializeSessionsJson', () => {
  it('emits a parseable JSON array of SessionMeta (the shape a caller parses)', () => {
    const out = serializeSessionsJson([
      meta({ shortId: 'aaa', project: 'proj-a' }),
      meta({ id: 'ffff', shortId: 'bbb', project: 'proj-b' }),
    ]);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].shortId).toBe('aaa');
    expect(parsed[0].project).toBe('proj-a');
    expect(parsed[1].project).toBe('proj-b');
  });

  it('empty input serializes to an empty array (an offline/0-session host)', () => {
    const parsed = JSON.parse(serializeSessionsJson([]));
    expect(parsed).toEqual([]);
  });

  it('strips the internal _remote / _matchedTerms / _bm25Score fan-out+search fields', () => {
    const out = serializeSessionsJson([
      meta({ _remote: true, _matchedTerms: ['auth'], _bm25Score: 3.14, machine: 'mac-mini' }),
    ]);
    const row = JSON.parse(out)[0];
    expect(row).not.toHaveProperty('_remote');
    expect(row).not.toHaveProperty('_matchedTerms');
    expect(row).not.toHaveProperty('_bm25Score');
    expect(row.machine).toBe('mac-mini');
  });

  it('ends with a single trailing newline (line-oriented stdout contract)', () => {
    const out = serializeSessionsJson([meta()]);
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('emits firstUserMessage (the canonical stream field a consumer routes on, PHNX-3621)', () => {
    const full = 'Implement PHNX-3621.\n\nFull verbatim first turn, not the topic.';
    const row = JSON.parse(serializeSessionsJson([meta({ topic: 'Implement PHNX-3621', firstUserMessage: full })]))[0];
    expect(row.firstUserMessage).toBe(full);
    expect(row.topic).toBe('Implement PHNX-3621');
  });
});

describe('serializeActiveSessionsForJson (RUSH-1981 — join keys)', () => {
  function active(over: Partial<ActiveSession> = {}): ActiveSession {
    return { context: 'terminal', kind: 'agent', status: 'running', ...over } as ActiveSession;
  }

  it('emits flat ticketId, project, and prLink', () => {
    const [row] = serializeActiveSessionsForJson([
      active({
        cwd: '/home/u/src/github.com/acme/widget',
        ticket: { id: 'RUSH-1981' } as ActiveSession['ticket'],
        pr: { url: 'https://github.com/acme/widget/pull/42', number: 42 },
      }),
    ]);
    expect(row.ticketId).toBe('RUSH-1981');
    expect(row.project).toBe('widget');
    expect(row.prLink).toBe('https://github.com/acme/widget/pull/42');
  });

  it('emits every join key (never absent); project buckets a cwd-less row explicitly', () => {
    const [row] = serializeActiveSessionsForJson([active()]);
    expect(Object.prototype.hasOwnProperty.call(row, 'ticketId')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(row, 'project')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(row, 'prLink')).toBe(true);
    expect(row.ticketId).toBeNull();
    expect(row.project).toBe('other');
    expect(row.prLink).toBeNull();
  });

  it('preserves the raw ActiveSession fields alongside the join keys', () => {
    const [row] = serializeActiveSessionsForJson([
      active({ sessionId: 'sess-1', machine: 'yosemite-s1', cwd: '/a/b/repo' }),
    ]);
    expect(row.sessionId).toBe('sess-1');
    expect(row.machine).toBe('yosemite-s1');
    expect(row.ticket).toBeUndefined();
    expect(row.project).toBe('repo');
  });

  it('carries the owner field through the JSON serializer (RUSH-2018)', () => {
    const [row] = serializeActiveSessionsForJson([active({ owner: 'ada@example.com' })]);
    expect(row.owner).toBe('ada@example.com');
  });
});

describe('ownerLabel (RUSH-2018 — --active owner column)', () => {
  const s = (owner?: string): ActiveSession =>
    ({ context: 'terminal', kind: 'agent', status: 'running', owner } as ActiveSession);

  it('shows the local-part of a resolved actor email', () => {
    expect(ownerLabel(s('muqsit@getrush.ai'))).toBe('muqsit');
  });

  it('shows a non-email login id as-is', () => {
    expect(ownerLabel(s('ada-lovelace'))).toBe('ada-lovelace');
  });

  it('shows "-" for an unresolved actor (honest: we do not know who)', () => {
    expect(ownerLabel(s('UNRESOLVED@yosemite-s1'))).toBe('-');
  });

  it('shows "-" when no owner was stamped (launch predates actor stamping)', () => {
    expect(ownerLabel(s(undefined))).toBe('-');
  });
});
