import { describe, expect, it } from 'vitest';
import { enrichTickets, extractRefs } from './refs.js';

const sessions = [
  { id: '374bbe22-e021-419b-af0c-05f718ff7749', title: 'Rush MCP token security', status: 'running', host: 'box-a' },
  { id: '9bef2ef9-06ec-41f7-9037-a8f4a9479ef4', title: 'Docs', status: 'idle', host: 'box-b' },
];
const ctx = (extra: Partial<Parameters<typeof extractRefs>[1]> = {}) => ({
  ticketPrefixes: new Set(['PHNX']), repo: 'acme/agents', knownPrs: new Set([3607]), sessions, ...extra,
});

describe('extractRefs', () => {
  it('finds tickets, PR numbers, PR urls and sessions by title or id', () => {
    const text = 'Claude is on PHNX-4365 (see #3607 and https://github.com/acme/other/pull/12). “Rush MCP token security” is idle; 9bef2ef9 finished. UTF-8 is not a ticket.';
    expect(extractRefs(text, ctx())).toEqual([
      { kind: 'ticket', id: 'PHNX-4365' },
      { kind: 'pr', repo: 'acme/other', number: 12, url: 'https://github.com/acme/other/pull/12' },
      { kind: 'pr', repo: 'acme/agents', number: 3607, url: 'https://github.com/acme/agents/pull/3607' },
      { kind: 'session', id: '9bef2ef9-06ec-41f7-9037-a8f4a9479ef4', title: 'Docs', host: 'box-b' },
      { kind: 'session', id: '374bbe22-e021-419b-af0c-05f718ff7749', title: 'Rush MCP token security', host: 'box-a' },
    ]);
  });

  it('ignores lookalike keys, unknown PR numbers, short titles and url anchors', () => {
    const text = 'GPT-4, CVE-2024-1234, TLS-1 and HTTP-2 are not tickets. Docs moved; see https://x.dev/page#12, #7 and #3607.';
    expect(extractRefs(text, ctx())).toEqual([
      { kind: 'pr', repo: 'acme/agents', number: 3607, url: 'https://github.com/acme/agents/pull/3607' },
    ]);
    expect(extractRefs('#3607', ctx({ repo: undefined }))).toEqual([]);
  });

  it('dedupes repeated mentions', () => {
    expect(extractRefs('PHNX-1 and PHNX-1 again', ctx({ sessions: [] }))).toEqual([{ kind: 'ticket', id: 'PHNX-1' }]);
  });
});

describe('enrichTickets', () => {
  it('prefers the brief cache, then the configured workspace url', () => {
    const out = enrichTickets([{ kind: 'ticket', id: 'PHNX-1' }, { kind: 'ticket', id: 'PHNX-2' }, { kind: 'ticket', id: 'PHNX-3' }], {
      cached: (id) => (id === 'PHNX-1' ? { url: 'https://linear.app/w/issue/PHNX-1', title: 'One' } : undefined),
      urlFor: (id) => (id === 'PHNX-2' ? `https://linear.app/w/issue/${id}` : undefined),
    });
    expect(out).toEqual([
      { kind: 'ticket', id: 'PHNX-1', url: 'https://linear.app/w/issue/PHNX-1', title: 'One' },
      { kind: 'ticket', id: 'PHNX-2', url: 'https://linear.app/w/issue/PHNX-2' },
      { kind: 'ticket', id: 'PHNX-3' },
    ]);
  });
});
