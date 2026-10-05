import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  countsFromIssuesResponse,
  fetchLinearProjectCounts,
  nextMilestone,
  orderedMilestones,
  type LinearIssuesResponse,
} from './linear-project-counts.js';

let cacheHome: string;
beforeEach(() => {
  cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lpc-cache-'));
  process.env.AGENTS_LINEAR_CACHE_PATH = path.join(cacheHome, 'c.json');
});
afterEach(() => {
  delete process.env.AGENTS_LINEAR_CACHE_PATH;
  fs.rmSync(cacheHome, { recursive: true, force: true });
});

function response(types: (string | null | undefined)[]): LinearIssuesResponse {
  return {
    issues: {
      nodes: types.map((t) => (t === undefined ? {} : { state: t === null ? null : { type: t } })),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

function page(types: string[], hasNextPage: boolean, endCursor: string | null): LinearIssuesResponse {
  return {
    issues: {
      nodes: types.map((t) => ({ state: { type: t } })),
      pageInfo: { hasNextPage, endCursor },
    },
  };
}

function scriptedPages(pages: LinearIssuesResponse[]) {
  const calls: Array<string | undefined> = [];
  const fetchPage = async (_p: string, after: string | undefined) => {
    calls.push(after);
    return pages[calls.length - 1];
  };
  return { calls, fetchPage };
}

describe('countsFromIssuesResponse', () => {
  it('groups by state type: completed → done, started → inProgress, all → total', () => {
    const counts = countsFromIssuesResponse(
      response([
        'completed', 'completed', 'completed',
        'started', 'started',
        'unstarted', 'backlog', 'triage', 'canceled',
      ]),
    );
    expect(counts).toEqual({ done: 3, total: 9, inProgress: 2 });
  });

  it('an issue with no state still counts toward total', () => {
    const counts = countsFromIssuesResponse(response([null, undefined, 'completed']));
    expect(counts).toEqual({ done: 1, total: 3, inProgress: 0 });
  });

  it('an empty / malformed response is zeros, never a throw', () => {
    expect(countsFromIssuesResponse({})).toEqual({ done: 0, total: 0, inProgress: 0 });
    expect(countsFromIssuesResponse({ issues: {} })).toEqual({ done: 0, total: 0, inProgress: 0 });
  });
});

describe('fetchLinearProjectCounts — pagination accumulator', () => {
  it('concatenates pages without overlap, handing the cursor across', async () => {
    const { calls, fetchPage } = scriptedPages([
      page(['completed', 'started'], true, 'cur-1'),
      page(['completed', 'backlog'], false, null),
    ]);
    const counts = await fetchLinearProjectCounts('proj-1', fetchPage);
    expect(calls).toEqual([undefined, 'cur-1']);
    expect(counts).toEqual({ done: 2, total: 4, inProgress: 1 });
  });

  it('terminates when hasNextPage is true but the cursor is null (no infinite loop)', async () => {
    const { calls, fetchPage } = scriptedPages([page(['completed'], true, null)]);
    const counts = await fetchLinearProjectCounts('proj-1', fetchPage);
    expect(calls).toHaveLength(1);
    expect(counts).toEqual({ done: 1, total: 1, inProgress: 0 });
  });

  it('hits the page cap and reports truncated instead of lying about the total', async () => {
    const endless = page(['completed'], true, 'cur');
    const { calls, fetchPage } = scriptedPages(Array.from({ length: 20 }, () => endless));
    const counts = await fetchLinearProjectCounts('proj-1', fetchPage);
    expect(calls).toHaveLength(10);
    expect(counts).toEqual({ done: 10, total: 10, inProgress: 0, truncated: true });
  });

  it('a failed page degrades the whole enrichment to undefined (card omits the line)', async () => {
    const fetchPage = async () => undefined;
    expect(await fetchLinearProjectCounts('proj-1', fetchPage)).toBeUndefined();
  });
});

function issue(stateType: string, msId?: string) {
  return { state: { type: stateType }, ...(msId ? { projectMilestone: { id: msId } } : {}) };
}

const M1 = { id: 'm1', name: 'Beta cut', targetDate: '2026-08-21' };
const M2 = { id: 'm2', name: 'GA', targetDate: '2026-09-30' };

describe('nextMilestone', () => {
  it('picks the earliest-dated milestone that still has work', () => {
    expect(
      nextMilestone([M2, M1], [issue('completed', 'm2'), issue('started', 'm2'), issue('completed', 'm1'), issue('unstarted', 'm1')]),
    ).toEqual({ name: 'Beta cut', targetDate: '2026-08-21', done: 1, total: 2 });
  });

  it('surfaces a declared milestone with NO issues filed under it', () => {
    expect(nextMilestone([M1], [issue('started'), issue('completed')])).toEqual({
      name: 'Beta cut',
      targetDate: '2026-08-21',
      done: 0,
      total: 0,
    });
  });

  it('skips a finished milestone — done is not "next"', () => {
    expect(nextMilestone([M1, M2], [issue('completed', 'm1'), issue('completed', 'm1'), issue('started', 'm2')])).toEqual({
      name: 'GA',
      targetDate: '2026-09-30',
      done: 0,
      total: 1,
    });
  });

  it('returns nothing when the project declares no milestones, or all are complete', () => {
    expect(nextMilestone([], [issue('started', 'm1')])).toBeUndefined();
    expect(nextMilestone([M1], [issue('completed', 'm1')])).toBeUndefined();
  });

  it('sorts undated milestones last but still surfaces one when nothing is dated', () => {
    const undated = { id: 'm3', name: 'Someday' };
    expect(nextMilestone([undated, M1], [])?.name).toBe('Beta cut');
    const only = nextMilestone([undated], []);
    expect(only).toEqual({ name: 'Someday', done: 0, total: 0 });
    expect(only?.targetDate).toBeUndefined();
  });

  it('ignores a malformed declared milestone rather than inventing one', () => {
    expect(nextMilestone([{ name: 'no id' }, { id: 'x', name: '' }], [])).toBeUndefined();
  });
});

describe('countsFromIssuesResponse — milestone', () => {
  it('carries the next milestone alongside the counts, and omits it when there is none', () => {
    const withMs = countsFromIssuesResponse({
      issues: { nodes: [issue('completed', 'm1'), issue('started', 'm1')] },
      project: { projectMilestones: { nodes: [M1] } },
    });
    expect(withMs).toEqual({
      done: 1,
      total: 2,
      inProgress: 1,
      milestones: [{ name: 'Beta cut', targetDate: '2026-08-21', done: 1, total: 2 }],
      nextMilestone: { name: 'Beta cut', targetDate: '2026-08-21', done: 1, total: 2 },
    });
    expect(countsFromIssuesResponse(response(['completed', 'started']))).not.toHaveProperty('nextMilestone');
  });
});

describe('fetchLinearProjectCounts — request budget', () => {
  const onePage = (): LinearIssuesResponse => ({
    issues: { nodes: [{ state: { type: 'completed' } }, { state: { type: 'started' } }], pageInfo: { hasNextPage: false, endCursor: null } },
    project: { projectMilestones: { nodes: [{ id: 'm1', name: 'Beta cut', targetDate: '2026-08-21' }] } },
  });

  it('spends ZERO requests on a second call inside the TTL', async () => {
    let calls = 0;
    const page = async () => { calls++; return onePage(); };
    const t0 = new Date(2026, 7, 3, 12, 0, 0).getTime();
    const first = await fetchLinearProjectCounts('p1', page, t0);
    expect(calls).toBe(1);
    const second = await fetchLinearProjectCounts('p1', page, t0 + 60_000);
    expect(calls).toBe(1);
    expect(second).toEqual(first);
    expect(second?.stale).toBeUndefined();
  });

  it('refetches once the TTL lapses', async () => {
    let calls = 0;
    const page = async () => { calls++; return onePage(); };
    const t0 = new Date(2026, 7, 3, 12, 0, 0).getTime();
    await fetchLinearProjectCounts('p1', page, t0);
    await fetchLinearProjectCounts('p1', page, t0 + 11 * 60_000);
    expect(calls).toBe(2);
  });

  it('serves the last good answer marked stale rather than dropping the line', async () => {
    const t0 = new Date(2026, 7, 3, 12, 0, 0).getTime();
    await fetchLinearProjectCounts('p1', async () => onePage(), t0);
    const afterFailure = await fetchLinearProjectCounts('p1', async () => undefined, t0 + 11 * 60_000);
    expect(afterFailure?.done).toBe(1);
    expect(afterFailure?.stale).toBe(true);
  });

  it('still returns undefined when a fetch fails with nothing cached', async () => {
    expect(await fetchLinearProjectCounts('never-seen', async () => undefined, Date.now())).toBeUndefined();
  });

  it('keeps separate answers per project', async () => {
    const t0 = new Date(2026, 7, 3, 12, 0, 0).getTime();
    await fetchLinearProjectCounts('p1', async () => onePage(), t0);
    let calls = 0;
    await fetchLinearProjectCounts('p2', async () => { calls++; return onePage(); }, t0);
    expect(calls).toBe(1);
  });
});

describe('orderedMilestones', () => {
  const A = { id: 'a', name: 'Beta cut', targetDate: '2026-09-30' };
  const B = { id: 'b', name: 'GA', targetDate: '2026-09-15' };
  const C = { id: 'c', name: 'Done thing', targetDate: '2026-08-01' };

  it('returns every declared milestone, unfinished first by date', () => {
    const out = orderedMilestones([A, B, C], [issue('completed', 'c')]);
    expect(out.map((m) => m.name)).toEqual(['GA', 'Beta cut', 'Done thing']);
  });

  it('shows all three of a project whose milestones carry no issues at all', () => {
    const out = orderedMilestones([A, B], []);
    expect(out).toEqual([
      { name: 'GA', targetDate: '2026-09-15', done: 0, total: 0 },
      { name: 'Beta cut', targetDate: '2026-09-30', done: 0, total: 0 },
    ]);
  });

  it("marks Linear's own next flag", () => {
    const out = orderedMilestones([{ ...A, status: 'next' }, B], []);
    expect(out.find((m) => m.name === 'Beta cut')?.isNext).toBe(true);
    expect(out.find((m) => m.name === 'GA')?.isNext).toBeUndefined();
  });
});

describe('nextMilestone — Linear wins over our date guess', () => {
  const early = { id: 'e', name: 'Earlier', targetDate: '2026-09-01' };
  const flagged = { id: 'f', name: 'Flagged', targetDate: '2026-12-01', status: 'next' };

  it("prefers Linear's own next marker over the earliest date", () => {
    expect(nextMilestone([early, flagged], [])?.name).toBe('Flagged');
  });

  it('falls back to earliest-dated unfinished when nothing is flagged', () => {
    expect(nextMilestone([early, { ...flagged, status: 'unstarted' }], [])?.name).toBe('Earlier');
  });

  it('never returns a finished milestone even if Linear flags it', () => {
    const doneFlagged = { id: 'f', name: 'Flagged', targetDate: '2026-09-01', status: 'next' };
    expect(nextMilestone([doneFlagged, early], [issue('completed', 'f')])?.name).toBe('Earlier');
  });
});
