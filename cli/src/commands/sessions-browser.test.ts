import { describe, it, expect } from 'vitest';
import {
  browserFilterToArgv,
  cycle,
  cycleWindow,
  sessionMatchesQuery,
  normalizeDeviceSeed,
  activeBrowserSeed,
  bareBrowserSeed,
  buildInitialFilter,
  liveRowKey,
  indexLiveRows,
  liveSessionToMeta,
  mergeLiveIntoPool,
  shouldShowHostColumn,
  applyFilters,
  remotePoolArgs,
  type BrowserFilter,
} from './sessions-browser.js';
import { liveHostLabel } from './sessions.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import type { ActiveSession } from '../lib/session/active.js';

const row = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id: 'x',
    shortId: 'a1b2c3d4',
    agent: 'claude',
    timestamp: '2026-07-16T00:00:00Z',
    filePath: '/tmp/x.jsonl',
    project: 'my-app',
    topic: "Review Taylor's PRs and release",
    ...over,
  }) as SessionMeta;

const base: BrowserFilter = {
  running: false,
  teams: false,
  bookmarks: false,
  agent: undefined,
  device: undefined,
  projectScope: 'repo',
  window: undefined,
  statuses: [],
  routine: false,
  limit: 500,
  unmanaged: false,
  sort: 'timestamp',
};

describe('browserFilterToArgv — the human↔agent contract', () => {
  it('an empty repo-scoped filter is just `sessions`', () => {
    // projectScope 'repo' is the default view, so it emits no flag.
    expect(browserFilterToArgv(base)).toEqual(['sessions']);
  });

  it('bookmarks-only maps to --bookmarks, so `y` round-trips a bookmarked view', () => {
    expect(browserFilterToArgv({ ...base, bookmarks: true })).toEqual(['sessions', '--bookmarks']);
  });

  it('running-only maps to --active', () => {
    expect(browserFilterToArgv({ ...base, running: true })).toEqual(['sessions', '--active']);
  });

  it('all-dirs scope maps to --all; repo scope emits nothing', () => {
    expect(browserFilterToArgv({ ...base, projectScope: 'all' })).toEqual(['sessions', '--all']);
    expect(browserFilterToArgv({ ...base, projectScope: 'repo' })).toEqual(['sessions']);
  });

  it('stacks every dimension in a stable, reproducible order', () => {
    const f: BrowserFilter = {
      running: true,
      teams: true,
      agent: 'claude',
      device: 'zion',
      projectScope: 'all',
      window: '7d',
      statuses: [],
      routine: false,
      bookmarks: false,
      limit: 500,
      unmanaged: false,
      sort: 'timestamp',
    };
    expect(browserFilterToArgv(f)).toEqual([
      'sessions',
      '--active',
      '--teams',
      '-a',
      'claude',
      '--device',
      'zion',
      '--all',
      '--since',
      '7d',
    ]);
  });

  it('round-trips the team filter as --in-team', () => {
    expect(browserFilterToArgv({ ...base, team: 'redesign' })).toEqual([
      'sessions',
      '--in-team',
      'redesign',
    ]);
  });

  it('round-trips all-routine and named-routine filters', () => {
    expect(browserFilterToArgv({ ...base, routine: true })).toEqual(['sessions', '--routine']);
    expect(browserFilterToArgv({ ...base, routine: 'nightly-review' })).toEqual([
      'sessions', '--routine', 'nightly-review',
    ]);
  });

  it('appends a search query as a quoted positional', () => {
    expect(browserFilterToArgv({ ...base, agent: 'codex' }, 'auth bug')).toEqual([
      'sessions',
      '-a',
      'codex',
      '"auth bug"',
    ]);
  });

  it('ignores a blank query', () => {
    expect(browserFilterToArgv(base, '   ')).toEqual(['sessions']);
  });

  it('round-trips a live-status union without adding a redundant --active', () => {
    expect(browserFilterToArgv({ ...base, running: true, statuses: ['orphaned', 'waiting'] })).toEqual([
      'sessions', '--orphan', '--waiting',
    ]);
  });

  it('round-trips a non-default discovery limit', () => {
    expect(browserFilterToArgv({ ...base, limit: 25 })).toEqual(['sessions', '--limit', '25']);
  });
});

describe('remotePoolArgs — per-device version aliases', () => {
  it('forwards latest unresolved so the peer resolves its own installed inventory', () => {
    expect(remotePoolArgs({ ...base, agent: 'claude@latest' }, true)).toContain('claude@latest');
  });

  it('forwards a bare harness only for a fixed selector, not a browser hotkey pool', () => {
    expect(remotePoolArgs({ ...base, agent: 'claude' }, true)).toContain('claude');
    expect(remotePoolArgs({ ...base, agent: 'claude' }, false)).not.toContain('claude');
  });

  it('preserves a named routine on the peer query', () => {
    expect(remotePoolArgs({ ...base, routine: 'nightly-review' }, false)).toContain('nightly-review');
  });
});

describe('applyFilters — shared browser/focus selection', () => {
  it('keeps only routine rows for the all-routines filter', () => {
    const rows = [
      row({ id: 'nightly', origin: 'routine', routineName: 'nightly-review' }),
      row({ id: 'manual', origin: 'cli' }),
    ];
    const result = applyFilters(
      rows,
      new Map(),
      { ...base, routine: true, projectScope: 'all' },
      'zion',
      new Set(),
    );
    expect(result.map((session) => session.id)).toEqual(['nightly']);
  });

  it('narrows a named routine with the same fuzzy resolver as the flag path', () => {
    const rows = [
      row({ id: 'nightly', origin: 'routine', routineName: 'nightly-review' }),
      row({ id: 'release', origin: 'routine', routineName: 'release-notes' }),
    ];
    const result = applyFilters(
      rows,
      new Map(),
      { ...base, routine: 'nightly', projectScope: 'all' },
      'zion',
      new Set(),
    );
    expect(result.map((session) => session.id)).toEqual(['nightly']);
  });

  it('filters historical versions even when that version is no longer installed', () => {
    const rows = [row({ id: 'old', version: '2.1.187' }), row({ id: 'new', version: '2.1.218' })];
    const result = applyFilters(
      rows,
      new Map(),
      { ...base, agent: 'claude@2.1.187', projectScope: 'all' },
      'zion',
      new Set(),
    );
    expect(result.map((session) => session.id)).toEqual(['old']);
  });

  it('uses the exact live-status union shared with sessions --active', () => {
    const rows = [row({ id: 'orphan' }), row({ id: 'working' }), row({ id: 'closed' })];
    const live = new Map<string, ActiveSession>([
      ['orphan', { context: 'terminal', kind: 'claude', status: 'orphaned', sessionId: 'orphan' } as ActiveSession],
      ['working', { context: 'terminal', kind: 'claude', status: 'running', activity: 'working', sessionId: 'working' } as ActiveSession],
      ['closed', { context: 'terminal', kind: 'claude', status: 'closed', sessionId: 'closed' } as ActiveSession],
    ]);
    const result = applyFilters(
      rows,
      live,
      { ...base, running: true, statuses: ['orphaned', 'working'], projectScope: 'all' },
      'zion',
      new Set(),
    );
    expect(result.map((session) => session.id)).toEqual(['orphan', 'working']);
  });

  it('keeps retained dead rows out of bare --active while explicit lifecycle filters can select them', () => {
    const rows = [row({ id: 'working' }), row({ id: 'closed' }), row({ id: 'crashed' })];
    const live = new Map<string, ActiveSession>([
      ['working', { context: 'terminal', kind: 'claude', status: 'running', machine: 'zion', pid: 111, pidAlive: true, sessionId: 'working' } as ActiveSession],
      ['closed', { context: 'terminal', kind: 'claude', status: 'closed', machine: 'zion', pid: 222, pidAlive: false, sessionId: 'closed' } as ActiveSession],
      ['crashed', { context: 'terminal', kind: 'claude', status: 'crashed', machine: 'zion', pid: 333, pidAlive: false, sessionId: 'crashed' } as ActiveSession],
    ]);

    expect(applyFilters(
      rows,
      live,
      { ...base, running: true, projectScope: 'all' },
      'zion',
      new Set(),
    ).map((session) => session.id)).toEqual(['working']);

    expect(applyFilters(
      rows,
      live,
      { ...base, running: true, statuses: ['closed', 'crashed'], projectScope: 'all' },
      'zion',
      new Set(),
    ).map((session) => session.id)).toEqual(['closed', 'crashed']);
  });

  it('does not treat a synced mirror as a peer-resolved latest result', () => {
    const rows = [
      row({ id: 'mirror', machine: 'yosemite-s0', version: '2.1.187' }),
      row({ id: 'peer', machine: 'yosemite-s0', version: '2.1.218', _remote: true }),
    ];
    const result = applyFilters(
      rows,
      new Map(),
      { ...base, agent: 'claude@latest', projectScope: 'all' },
      'zion',
      new Set(),
    );
    expect(result.map((session) => session.id)).toEqual(['peer']);
  });
});

describe('cycle — [none, ...options] wrapping for A/D hotkeys', () => {
  it('none → first → … → last → none', () => {
    const opts = ['claude', 'codex', 'droid'];
    expect(cycle(undefined, opts)).toBe('claude');
    expect(cycle('claude', opts)).toBe('codex');
    expect(cycle('droid', opts)).toBeUndefined(); // wraps back to "all"
  });

  it('a value no longer in the pool restarts at the first option', () => {
    // findIndex returns -1 → (-1 + 1) % len === 0 → first entry (undefined).
    expect(cycle('gone', ['claude'])).toBeUndefined();
  });

  it('an empty pool always yields none', () => {
    expect(cycle(undefined, [])).toBeUndefined();
  });
});

describe('cycleWindow — W hotkey', () => {
  it('cycles all → 1d → 7d → 30d → all', () => {
    expect(cycleWindow(undefined)).toBe('1d');
    expect(cycleWindow('1d')).toBe('7d');
    expect(cycleWindow('7d')).toBe('30d');
    expect(cycleWindow('30d')).toBeUndefined();
  });
});

describe('activeBrowserSeed — the --active call-site filter (fleet-wide)', () => {
  it('is fleet-wide (projectScope all), not repo-scoped', () => {
    // The static --active is fleet-wide; the interactive one must match, else
    // `sessions --active` silently narrows to the current directory.
    expect(activeBrowserSeed({}).projectScope).toBe('all');
  });

  it('is running-only and defaults the window to 30d', () => {
    const f = activeBrowserSeed({});
    expect(f.running).toBe(true);
    expect(f.window).toBe('30d');
  });

  it('seeds the window from --since', () => {
    expect(activeBrowserSeed({ since: '2h' }).window).toBe('2h');
  });

  it('--all widens the window to all-time (undefined); --since still overrides; stays running-only', () => {
    const f = activeBrowserSeed({ all: true });
    expect(f.window).toBeUndefined();
    expect(f.running).toBe(true);
    expect(f.projectScope).toBe('all');
    expect(activeBrowserSeed({ all: true, since: '2h' }).window).toBe('2h');
  });

  it('normalizes a user@host / FQDN device seed to the canonical machine id', () => {
    expect(activeBrowserSeed({ host: ['muqsit@mac-mini.local'] }).device).toBe('mac-mini');
    expect(activeBrowserSeed({ host: ['YOSEMITE-S1'] }).device).toBe('yosemite-s1');
    expect(activeBrowserSeed({}).device).toBeUndefined();
  });
});

describe('bareBrowserSeed — the bare-listing call-site filter', () => {
  it('defaults to this-repo scope, widens to all dirs with --all', () => {
    expect(bareBrowserSeed({}).projectScope).toBe('repo');
    expect(bareBrowserSeed({ all: true }).projectScope).toBe('all');
  });

  it('is not running-only and seeds the window from --since', () => {
    expect(bareBrowserSeed({}).running).toBeUndefined();
    expect(bareBrowserSeed({ since: '7d' }).window).toBe('7d');
  });

  it('defaults the window to 30d, but --all widens it to all-time (undefined)', () => {
    expect(bareBrowserSeed({}).window).toBe('30d');
    expect(bareBrowserSeed({ all: true }).window).toBeUndefined();
    // an explicit --since still wins over --all's all-time default
    expect(bareBrowserSeed({ all: true, since: '7d' }).window).toBe('7d');
  });
});

describe('bareBrowserSeed — an explicit --device scope', () => {
  it('forces all-dirs scope so a peer\'s rows are not filtered away', () => {
    // Every fetched row is the peer's, and no peer cwd sits under OUR
    // process.cwd() — with the default 'repo' scope the browser renders empty.
    expect(bareBrowserSeed({ host: ['zion'] }).projectScope).toBe('all');
    expect(bareBrowserSeed({ host: ['zion', 'mac-mini'] }).projectScope).toBe('all');
  });

  it('seeds the device chip only when the scope names exactly one host', () => {
    expect(bareBrowserSeed({ host: ['user@Zion.local'] }).device).toBe('zion');
    // Two hosts: seeding the first would narrow the view to it and hide the other.
    expect(bareBrowserSeed({ host: ['zion', 'mac-mini'] }).device).toBeUndefined();
    expect(bareBrowserSeed({}).device).toBeUndefined();
  });

  it('leaves the no-host behaviour untouched', () => {
    expect(bareBrowserSeed({}).projectScope).toBe('repo');
    expect(bareBrowserSeed({}).window).toBe('30d');
  });

  it('seeds the team filter from --in-team', () => {
    expect(bareBrowserSeed({ inTeam: 'redesign' }).team).toBe('redesign');
    expect(bareBrowserSeed({}).team).toBeUndefined();
  });

  it('carries routine filters into the shared browser', () => {
    expect(bareBrowserSeed({ routine: true }).routine).toBe(true);
    expect(bareBrowserSeed({ routine: 'nightly-review' }).routine).toBe('nightly-review');
    expect(activeBrowserSeed({ routine: 'nightly-review' }).routine).toBe('nightly-review');
  });

  it('widens scope and window for --in-team, since a team outlives both defaults', () => {
    // The browser is the path a human actually reaches, so seeding the filter
    // without widening left the interactive default hiding exactly the rows the
    // flag exists to surface: teammates run in their own worktrees (a different
    // cwd), and the team itself is often older than the 30-day window.
    const seed = bareBrowserSeed({ inTeam: 'redesign' });
    expect(seed.projectScope).toBe('all');
    expect(seed.window).toBeUndefined();
  });

  it('lets an explicit --since still bound an --in-team view', () => {
    expect(bareBrowserSeed({ inTeam: 'redesign', since: '7d' }).window).toBe('7d');
  });
});

describe('buildInitialFilter — the seed must survive into the live filter', () => {
  // The seed is copied field-by-field, and every field is optional, so a dropped
  // one is invisible to the compiler and silent at runtime: `team` was omitted
  // here, which made --in-team a no-op interactively while the scope half of the
  // same seed still applied — the browser opened wide and looked filtered.
  it('carries every seeded field through, not just the ones with defaults', () => {
    const seed = bareBrowserSeed({ inTeam: 'redesign', agent: 'codex', host: ['zion'] });
    const filter = buildInitialFilter(seed);

    expect(filter.team).toBe('redesign');
    expect(filter.agent).toBe('codex');
    expect(filter.device).toBe('zion');
    expect(filter.projectScope).toBe('all');
    expect(filter.window).toBeUndefined();
  });

  it('loses no key of the seed', () => {
    // Guards the next filter field someone adds: if the seed sets it and the
    // filter doesn't carry it, this fails without anyone having to remember.
    const seed = bareBrowserSeed({ inTeam: 'redesign', agent: 'codex', host: ['zion'], teams: true });
    const filter = buildInitialFilter(seed) as Record<string, unknown>;
    for (const [key, value] of Object.entries(seed)) {
      expect({ key, value: filter[key] }).toEqual({ key, value });
    }
  });

  it('applies its own defaults only where the seed is silent', () => {
    const filter = buildInitialFilter({});
    expect(filter.running).toBe(false);
    expect(filter.teams).toBe(false);
    expect(filter.projectScope).toBe('repo');
    expect(filter.window).toBe('30d');
    expect(filter.team).toBeUndefined();
  });

  it('honors an explicit undefined window as all-time', () => {
    expect(buildInitialFilter({ window: undefined }).window).toBeUndefined();
  });
});

describe('normalizeDeviceSeed — canonical .machine form', () => {
  it('strips user@ and domain, lowercases', () => {
    expect(normalizeDeviceSeed('user@Zion.local')).toBe('zion');
    expect(normalizeDeviceSeed('mac-mini')).toBe('mac-mini');
    expect(normalizeDeviceSeed(undefined)).toBeUndefined();
  });
});

describe('sessionMatchesQuery — the S search predicate (cheap, not FTS)', () => {
  it('empty query matches everything', () => {
    expect(sessionMatchesQuery(row(), '')).toBe(true);
    expect(sessionMatchesQuery(row(), '   ')).toBe(true);
  });

  it('matches case-insensitively across topic / project / id', () => {
    expect(sessionMatchesQuery(row(), 'taylor')).toBe(true); // topic
    expect(sessionMatchesQuery(row(), 'MY-APP')).toBe(true); // project
    expect(sessionMatchesQuery(row(), 'a1b2')).toBe(true); // shortId prefix
  });

  it('requires every whitespace-separated term (AND)', () => {
    expect(sessionMatchesQuery(row(), 'taylor release')).toBe(true);
    expect(sessionMatchesQuery(row(), 'taylor nope')).toBe(false);
  });

  it('non-matching query excludes the row', () => {
    expect(sessionMatchesQuery(row(), 'zzzznomatch')).toBe(false);
  });

  it('matches the ticket/PR ref', () => {
    expect(sessionMatchesQuery(row({ prNumber: 1248 }), 'pr#1248')).toBe(true);
  });
});

/**
 * The running filter used to be a pure intersection with the transcript pool
 * (`pool.filter(r => live.has(r.id))`) fed by a LOCAL-ONLY live scan. Both
 * halves hid real sessions: `agents sessions --active --json` listed 32 live
 * sessions across 7 machines while the browser showed 4. These pin the union
 * semantics that replaced it.
 */
const live = (over: Partial<ActiveSession> = {}): ActiveSession =>
  ({
    context: 'terminal',
    kind: 'claude',
    status: 'running',
    sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
    cwd: '/home/muqsit/src/app',
    ...over,
  }) as ActiveSession;

describe('liveRowKey — the join key between the live scan and the pool', () => {
  it('keys on the session id so a live row and its transcript row collapse', () => {
    expect(liveRowKey(live(), 'zion')).toBe('aaaaaaaa-1111-2222-3333-444444444444');
  });

  it('falls back to machine+pid so an id-less live agent still gets one row', () => {
    expect(liveRowKey(live({ sessionId: undefined, machine: 'yosemite-s0', pid: 4242 }), 'zion'))
      .toBe('live:yosemite-s0:4242');
  });

  it('attributes an untagged live row to the local machine', () => {
    expect(liveRowKey(live({ sessionId: undefined, pid: 7 }), 'zion')).toBe('live:zion:7');
  });

  it('keys a pid-less cloud task on its task id so two never collapse into one row', () => {
    const a = live({ sessionId: undefined, pid: undefined, context: 'cloud', cloudTaskId: 'task-a' });
    const b = live({ sessionId: undefined, pid: undefined, context: 'cloud', cloudTaskId: 'task-b' });
    expect(liveRowKey(a, 'zion')).not.toBe(liveRowKey(b, 'zion'));
    expect(indexLiveRows([a, b], 'zion').size).toBe(2);
  });
});

describe('mergeLiveIntoPool — running is a SOURCE of rows, not an intersection', () => {
  it("adds a peer's live session the local transcript pool does not carry", () => {
    const rows = [row({ id: 'local-1', machine: 'zion' })];
    const remote = live({ sessionId: 'bbbbbbbb-1111-2222-3333-444444444444', machine: 'yosemite-s0' });
    const merged = mergeLiveIntoPool(rows, indexLiveRows([remote], 'zion'), 'zion');
    expect(merged.map((r) => r.id)).toContain('bbbbbbbb-1111-2222-3333-444444444444');
    expect(merged).toHaveLength(2);
  });

  it('does not duplicate a live session already in the pool', () => {
    const rows = [row({ id: 'aaaaaaaa-1111-2222-3333-444444444444' })];
    const merged = mergeLiveIntoPool(rows, indexLiveRows([live()], 'zion'), 'zion');
    expect(merged).toHaveLength(1);
    // The pool row wins — it carries the indexed transcript metadata.
    expect(merged[0].filePath).toBe('/tmp/x.jsonl');
  });

  it('names an id-less process row by a pid short enough for the id column', () => {
    // 9 chars max: `p:` + a 7-digit Linux pid. The old `pid:` prefix overflowed
    // the 10-wide id column and cost the real pid its last digits.
    const meta = liveSessionToMeta(live({ sessionId: undefined, pid: 2813139 }), 'zion');
    expect(meta.shortId).toBe('p:2813139');
    expect(meta.shortId.length).toBeLessThanOrEqual(9);
  });

  it('keeps an id-less live session instead of dropping it', () => {
    const merged = mergeLiveIntoPool([], indexLiveRows([live({ sessionId: undefined, pid: 99 })], 'zion'), 'zion');
    expect(merged).toHaveLength(1);
    expect(merged[0].shortId).toBe('p:99');
  });

  it('leaves the pool untouched when nothing live is missing from it', () => {
    const rows = [row({ id: 'local-1' })];
    expect(mergeLiveIntoPool(rows, new Map(), 'zion')).toBe(rows);
  });

  it('does not widen a peer-resolved latest/oldest selector with unindexed live rows', () => {
    const indexed = row({ id: 'indexed', machine: 'yosemite-s0', version: '2.1.219', _remote: true });
    const unindexed = live({ sessionId: 'unindexed', machine: 'yosemite-s0', status: 'running' });
    const liveIndex = indexLiveRows([unindexed], 'zion');

    expect(mergeLiveIntoPool([indexed], liveIndex, 'zion', false)).toEqual([indexed]);
    expect(mergeLiveIntoPool([indexed], liveIndex, 'zion', true).map((session) => session.id)).toContain('unindexed');
  });
});

describe('liveSessionToMeta — the projected row', () => {
  it("marks a peer's session remote so read/resume hops back over SSH", () => {
    const meta = liveSessionToMeta(live({ machine: 'yosemite-s0' }), 'zion');
    expect(meta._remote).toBe(true);
    expect(meta.machine).toBe('yosemite-s0');
  });

  it('does not mark a local session remote', () => {
    expect(liveSessionToMeta(live({ machine: 'zion' }), 'zion')._remote).toBe(false);
  });

  it('carries the refs and cwd-derived project the picker columns render', () => {
    const meta = liveSessionToMeta(
      live({ pr: { url: 'https://github.com/o/r/pull/12', number: 12 }, ticket: { id: 'RUSH-1' } }),
      'zion',
    );
    expect(meta.project).toBe('app');
    expect(meta.prNumber).toBe(12);
    expect(meta.ticketId).toBe('RUSH-1');
  });

  it('carries routine provenance so an unindexed live row obeys routine filters', () => {
    const meta = liveSessionToMeta(
      live({ origin: 'routine', routineName: 'nightly-review' }),
      'zion',
    );
    expect(meta.origin).toBe('routine');
    expect(meta.routineName).toBe('nightly-review');
  });

  it('keeps an untracked agent kind off the typed agent field', () => {
    expect(liveSessionToMeta(live({ kind: 'cursor-agent' }), 'zion').agent).toBe('claude');
  });

  it('leaves filePath empty when the scan resolved no transcript', () => {
    expect(liveSessionToMeta(live({ sessionFile: undefined }), 'zion').filePath).toBe('');
  });

  it('flattens a multi-line live topic so it cannot break the row layout', () => {
    const meta = liveSessionToMeta(live({ topic: 'refactor the parser\nsecond line' }), 'zion');
    expect(meta.topic).not.toContain('\n');
    expect(meta.topic).toContain('refactor the parser');
  });
});

describe('liveHostLabel — which program the session runs in', () => {
  it('names the host app for an editor-hosted session', () => {
    expect(liveHostLabel(live({ host: 'codium' }))).toBe('codium');
  });

  it('names both when a tmux session is being watched through another app', () => {
    expect(liveHostLabel(live({ host: 'tmux', viewingIn: { app: 'ghostty', tab: 2 } }))).toBe('tmux→ghostty');
  });

  it('stays a bare tmux when no client is attached (running detached)', () => {
    expect(liveHostLabel(live({ host: 'tmux' }))).toBe('tmux');
  });

  it('is empty when the host could not be resolved', () => {
    expect(liveHostLabel(live({ host: undefined }))).toBe('');
    expect(liveHostLabel(undefined)).toBe('');
  });
});

describe('shouldShowHostColumn — live-only, gated on the filter not the cache', () => {
  const hosted = live({ host: 'ghostty' });
  const rows = [row({ id: hosted.sessionId })];
  const index = indexLiveRows([hosted], 'zion');

  it('shows the column in the running view when a visible row has a host', () => {
    expect(shouldShowHostColumn({ ...base, running: true }, index, rows)).toBe(true);
  });

  it('drops the column when running is toggled back off, even though liveCache survives', () => {
    // Regression: gating on `!!live` alone kept the column after the `r` hotkey
    // turned running off, widening a plain listing with no live rows to explain it.
    expect(shouldShowHostColumn({ ...base, running: false }, index, rows)).toBe(false);
  });

  it('stays off when no visible row resolved a host', () => {
    const hostless = live({ host: undefined });
    expect(
      shouldShowHostColumn({ ...base, running: true }, indexLiveRows([hostless], 'zion'), [
        row({ id: hostless.sessionId }),
      ]),
    ).toBe(false);
  });

  it('stays off before the live index has been fetched', () => {
    expect(shouldShowHostColumn({ ...base, running: true }, null, rows)).toBe(false);
  });
});

/**
 * `buildInitialFilter` copies the seed field by field, and an omitted field is
 * SILENT — the field is optional, so the compiler says nothing and the browser
 * just opens without that filter. `team` was lost exactly this way. So each new
 * field earns an assertion that it survives the copy, in both directions.
 */
describe('bookmarks survives the seed → filter copy', () => {
  it('carries a seeded bookmarks flag into the live filter', () => {
    expect(buildInitialFilter({ bookmarks: true }).bookmarks).toBe(true);
  });

  it('defaults to off, never undefined', () => {
    expect(buildInitialFilter({}).bookmarks).toBe(false);
  });

  it('is reachable from both entry points\u0027 seeds', () => {
    expect(bareBrowserSeed({ bookmarks: true }).bookmarks).toBe(true);
    expect(activeBrowserSeed({ bookmarks: true }).bookmarks).toBe(true);
    expect(bareBrowserSeed({}).bookmarks).toBe(false);
    expect(activeBrowserSeed({}).bookmarks).toBe(false);
  });
});
