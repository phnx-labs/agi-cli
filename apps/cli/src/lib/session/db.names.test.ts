import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate the sessions DB under a temp HOME before db.js/state.js capture the
// path at import time.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-dbnames-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { upsertSession, seedLabelsFromNames, syncLabels, ftsSearch, getSessionById, findSessionsByShortIds } =
  await import('./db.js');
type SessionMeta = import('./types.js').SessionMeta;

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: new Date().toISOString(),
    filePath: '',
    ...extra,
  };
}

describe('--name seeds the unified session label', () => {
  it('resolves `agents sessions <name>` to the run, exact match ranked top', () => {
    upsertSession(meta('run-alpha'), '');
    upsertSession(meta('run-beta'), '');
    // `--name` seeds the label by id — the same idempotent, re-applied-every-scan
    // path used in discovery (seedLabelsFromNames), keyed off the run-name sidecars.
    seedLabelsFromNames(new Map([['run-alpha', 'fix-bug'], ['run-beta', 'other']]));

    const hits = ftsSearch('fix-bug');
    expect(hits[0]?.sessionId).toBe('run-alpha');
    expect(hits[0]?.score).toBe(1_000_000);
    // The seed lands on the single `label` field, readable back — no separate `name`.
    expect(getSessionById('run-alpha')?.label).toBe('fix-bug');
  });

  it('matches a seeded name by prefix below an exact match', () => {
    upsertSession(meta('run-gamma'), '');
    seedLabelsFromNames(new Map([['run-gamma', 'nightly-audit']]));
    const hits = ftsSearch('nightly');
    const hit = hits.find(h => h.sessionId === 'run-gamma');
    expect(hit?.score).toBe(900_000);
  });

  it('an agent-generated title WINS over the --name seed (refine beats seed)', () => {
    upsertSession(meta('run-refine'), '');
    // Discovery order: the per-agent scan applies the generated title first...
    syncLabels(new Map([['run-refine', 'Real generated title']]));
    // ...then the seed pass runs — and must NOT clobber the real title.
    seedLabelsFromNames(new Map([['run-refine', 'my-seed']]));
    expect(getSessionById('run-refine')?.label).toBe('Real generated title');
    // The refined title resolves; the superseded seed no longer does.
    expect(ftsSearch('Real generated title')[0]?.sessionId).toBe('run-refine');
    expect(ftsSearch('my-seed').some(h => h.score >= 800_000)).toBe(false);
  });

  it('the seed shows until a title exists, and survives a bare rescan', () => {
    upsertSession(meta('run-persist'), '');
    seedLabelsFromNames(new Map([['run-persist', 'keep-me']]));
    expect(getSessionById('run-persist')?.label).toBe('keep-me');
    // A bare rescan re-upserts with an EMPTY label. The upsert now PRESERVES the
    // stored non-empty label instead of clearing it, so the handle stays
    // resolvable even before the seed pass re-runs.
    upsertSession(meta('run-persist'), 'rescanned preview');
    expect(getSessionById('run-persist')?.label).toBe('keep-me');
    // The FTS label column stays consistent too — search still resolves the run.
    expect(ftsSearch('keep-me')[0]?.sessionId).toBe('run-persist');
    // The seed pass re-running is a harmless no-op (label already non-empty).
    seedLabelsFromNames(new Map([['run-persist', 'keep-me']]));
    expect(getSessionById('run-persist')?.label).toBe('keep-me');
    expect(ftsSearch('keep-me')[0]?.sessionId).toBe('run-persist');
  });

  it('leaves unnamed runs resolvable by id only (no spurious handle match)', () => {
    upsertSession(meta('run-plain'), '');
    expect(getSessionById('run-plain')?.label).toBeUndefined();
    expect(ftsSearch('run-plain').some(h => h.score >= 800_000)).toBe(false);
  });
});

describe('upsertSession preserves a good label; a real one still wins (clobber fix)', () => {
  it('an EMPTY incoming label does NOT overwrite a stored non-empty label', () => {
    upsertSession(meta('clobber-empty'), '');
    // Seed a good label (the --name seed path).
    seedLabelsFromNames(new Map([['clobber-empty', 'good-label']]));
    expect(getSessionById('clobber-empty')?.label).toBe('good-label');
    // A later scan re-upserts with no label at all — must NOT erase the good one.
    upsertSession(meta('clobber-empty'), 'preview text');
    expect(getSessionById('clobber-empty')?.label).toBe('good-label');
    // A whitespace-only incoming label counts as empty and must not clobber either.
    upsertSession(meta('clobber-empty', { label: '   ' }), 'more preview');
    expect(getSessionById('clobber-empty')?.label).toBe('good-label');
    // FTS label stayed consistent through both blank rescans.
    expect(ftsSearch('good-label')[0]?.sessionId).toBe('clobber-empty');
  });

  it('a REAL incoming label DOES win over the stored one', () => {
    upsertSession(meta('clobber-real'), '');
    seedLabelsFromNames(new Map([['clobber-real', 'old-label']]));
    expect(getSessionById('clobber-real')?.label).toBe('old-label');
    // An upsert carrying a genuine (non-empty) label overwrites — the /rename and
    // agent-title paths that flow a real label through upsert must still change it.
    upsertSession(meta('clobber-real', { label: 'new-real-label' }), '');
    expect(getSessionById('clobber-real')?.label).toBe('new-real-label');
    // The FTS index moved to the new label and dropped the old one.
    expect(ftsSearch('new-real-label')[0]?.sessionId).toBe('clobber-real');
    expect(ftsSearch('old-label').some(h => h.score >= 800_000)).toBe(false);
  });

  it('syncLabels can still CHANGE a label after the preserve fix', () => {
    upsertSession(meta('sync-change', { label: 'first' }), '');
    expect(getSessionById('sync-change')?.label).toBe('first');
    // The agent-title / `/rename` diff path replaces the label outright.
    syncLabels(new Map([['sync-change', 'renamed']]));
    expect(getSessionById('sync-change')?.label).toBe('renamed');
    expect(ftsSearch('renamed')[0]?.sessionId).toBe('sync-change');
  });

  it('syncLabels does not erase a stored label when live metadata has no name', () => {
    upsertSession(meta('sync-empty', { label: 'generated-title' }), '');
    syncLabels(new Map([['sync-empty', null]]));
    expect(getSessionById('sync-empty')?.label).toBe('generated-title');
    expect(ftsSearch('generated-title')[0]?.sessionId).toBe('sync-empty');
  });

  it('the first upsert still sets a real label (INSERT path unaffected)', () => {
    upsertSession(meta('first-real', { label: 'born-with-a-label' }), '');
    expect(getSessionById('first-real')?.label).toBe('born-with-a-label');
    expect(ftsSearch('born-with-a-label')[0]?.sessionId).toBe('first-real');
  });
});

describe('findSessionsByShortIds (batched short-id -> session, the live-scan resolver)', () => {
  it('resolves many short ids in ONE map keyed by short_id; unknowns are absent', () => {
    upsertSession(meta('11112222-aaaa-4bbb-8ccc-000000000001'), '');
    upsertSession(meta('33334444-aaaa-4bbb-8ccc-000000000002'), '');
    const map = findSessionsByShortIds(['11112222', '33334444', 'deadbeef']);
    expect(map.get('11112222')?.id).toBe('11112222-aaaa-4bbb-8ccc-000000000001');
    expect(map.get('33334444')?.id).toBe('33334444-aaaa-4bbb-8ccc-000000000002');
    expect(map.has('deadbeef')).toBe(false);
  });

  it('is case-insensitive on the query side (uuid prefixes are lowercase hex)', () => {
    upsertSession(meta('aabbccdd-aaaa-4bbb-8ccc-000000000003'), '');
    expect(findSessionsByShortIds(['AABBCCDD']).get('aabbccdd')?.id)
      .toBe('aabbccdd-aaaa-4bbb-8ccc-000000000003');
  });

  it('returns an empty map for empty input (no query at all)', () => {
    expect(findSessionsByShortIds([]).size).toBe(0);
  });

  it('when two sessions share a short id, the most-recently-active one wins', () => {
    upsertSession(meta('55556666-aaaa-4bbb-8ccc-000000000004', { timestamp: '2026-01-01T00:00:00.000Z' }), '');
    upsertSession(meta('55556666-ffff-4bbb-8ccc-000000000005', { timestamp: '2026-02-01T00:00:00.000Z' }), '');
    expect(findSessionsByShortIds(['55556666']).get('55556666')?.id)
      .toBe('55556666-ffff-4bbb-8ccc-000000000005');
  });
});
