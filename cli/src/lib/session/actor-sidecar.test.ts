import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-sidecar-'));
process.env.HOME = TEST_HOME;

const { writeSessionActorRecord, writeSessionAliasRecord, readSessionActorRecord, loadSessionActorIndex, resolveSessionAlias } = await import('./actor-sidecar.js');
const { resolveOwner, serializeSessionsJson } = await import('./active.js');
const { getDB, closeDB, upsertSession, upsertSessionsBatch, getSessionById } = await import('./db.js');
type SessionMeta = import('./types.js').SessionMeta;

const FILES = path.join(TEST_HOME, 'files');
fs.mkdirSync(FILES, { recursive: true });

/**
 * RUSH-2019 (P3): the durable sessionId -> actor sidecar makes the session
 * scanner able to attribute a transcript to a person after the launching process
 * is gone. Two things must hold: the record round-trips on disk, and the DB
 * upsert JOINS it to fill the write-once actor column when the scanned meta
 * carries none.
 */
describe('session actor sidecar (RUSH-2019)', () => {
  it('round-trips a written record and skips one with no session id', () => {
    writeSessionActorRecord({ sessionId: 'sid-1', actor: 'ada@example.com', initiatedBy: 'human', phoenixId: 'phx_ada', startedAtMs: 1 });
    const got = readSessionActorRecord('sid-1');
    expect(got?.actor).toBe('ada@example.com');
    expect(got?.initiatedBy).toBe('human');
    expect(got?.phoenixId).toBe('phx_ada');
    // No id -> no file written, and a read of an absent id is undefined.
    writeSessionActorRecord({ sessionId: '', actor: 'x', initiatedBy: 'human', startedAtMs: 1 });
    expect(readSessionActorRecord('missing')).toBeUndefined();
  });

  it('resolveOwner falls back to the sidecar when the pid entry has no actor (RUSH-2018 --active fix)', () => {
    writeSessionActorRecord({ sessionId: 'own-1', actor: 'ada@example.com', initiatedBy: 'human', startedAtMs: 1 });
    // pid entry carried the actor -> use it directly.
    expect(resolveOwner('pid@example.com', 'own-1')).toBe('pid@example.com');
    // pid entry actor-less (the SessionStart-hook clobber case) -> sidecar wins.
    expect(resolveOwner(undefined, 'own-1')).toBe('ada@example.com');
    expect(resolveOwner(null, 'own-1')).toBe('ada@example.com');
    // no pid actor and no sidecar -> honestly undefined.
    expect(resolveOwner(undefined, 'own-absent')).toBeUndefined();
    expect(resolveOwner(undefined, undefined)).toBeUndefined();
  });

  it('loadSessionActorIndex surfaces every record keyed by session id', () => {
    writeSessionActorRecord({ sessionId: 'sid-a', actor: 'a@x.io', initiatedBy: 'human', startedAtMs: 1 });
    writeSessionActorRecord({ sessionId: 'sid-b', actor: 'b@x.io', initiatedBy: 'agent', startedAtMs: 2 });
    const idx = loadSessionActorIndex();
    expect(idx.get('sid-a')?.actor).toBe('a@x.io');
    expect(idx.get('sid-b')?.initiatedBy).toBe('agent');
  });

  it('persists a tmux alias without discarding actor or mode metadata', () => {
    writeSessionActorRecord({ sessionId: 'alias-actor', actor: 'ada@example.com', initiatedBy: 'human', phoenixId: 'phx_ada', mode: 'edit', startedAtMs: 1 });
    writeSessionAliasRecord('alias-actor', 'ag-codex-d4e5f607');
    const record = readSessionActorRecord('alias-actor');
    expect(record?.actor).toBe('ada@example.com');
    expect(record?.phoenixId).toBe('phx_ada');
    expect(record?.mode).toBe('edit');
    expect(record?.aliases).toContain('ag-codex-d4e5f607');
  });

  it('resolves an exact tmux alias plus unique prefix and suffix selectors', () => {
    writeSessionAliasRecord('native-codex-session', 'ag-codex-e5f60718');
    expect(resolveSessionAlias('ag-codex-e5f60718')).toEqual({ kind: 'resolved', sessionId: 'native-codex-session' });
    expect(resolveSessionAlias('ag-codex-e5')).toEqual({ kind: 'resolved', sessionId: 'native-codex-session' });
    expect(resolveSessionAlias('e5f60718')).toEqual({ kind: 'resolved', sessionId: 'native-codex-session' });
  });

  it('fails closed when an alias suffix belongs to more than one native session', () => {
    writeSessionAliasRecord('native-a', 'ag-codex-a1b2c3d4');
    writeSessionAliasRecord('native-b', 'ag-claude-a1b2c3d4');
    expect(resolveSessionAlias('a1b2c3d4')).toEqual({ kind: 'ambiguous', sessionIds: ['native-a', 'native-b'] });
  });

  it('refuses a session id with path separators (no write outside by-session/)', () => {
    // A caller-supplied `--session-id '../../evil'` must not escape the dir via
    // path.join; the write is dropped and the read finds nothing.
    writeSessionActorRecord({ sessionId: '../../evil', actor: 'mallory@x.io', initiatedBy: 'human', startedAtMs: 1 });
    expect(readSessionActorRecord('../../evil')).toBeUndefined();
    const escaped = path.join(TEST_HOME, '.agents', '.history', 'evil.json');
    expect(fs.existsSync(escaped)).toBe(false);
  });
});

/**
 * The DB join is the whole point: a scan builds a SessionMeta with NO actor (the
 * transcript can't carry one), upsertSession reads the sidecar and fills the
 * column — so `agents sessions` attributes historical sessions to a person.
 */
describe('upsertSession joins the actor sidecar (RUSH-2019)', () => {
  beforeAll(() => {
    fs.mkdirSync(FILES, { recursive: true });
    getDB(); // migrate a fresh home
  });
  afterAll(() => {
    closeDB();
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  function scanMeta(id: string): SessionMeta {
    const filePath = path.join(FILES, `${id}.jsonl`);
    fs.writeFileSync(filePath, '');
    // No actor field — exactly what the transcript scanner produces.
    return { id, shortId: id.slice(0, 8), agent: 'claude', timestamp: '2026-08-01T10:00:00.000Z', filePath };
  }

  it('retains the origin account across alias writes, binary updates and rescans', () => {
    writeSessionActorRecord({ sessionId: 'origin-account', accountId: 'account-a', version: '1.0.0', startedAtMs: 1 });
    writeSessionAliasRecord('origin-account', 'ag-codex-a0123456');
    upsertSession(scanMeta('origin-account'), '');
    expect(getSessionById('origin-account')?.accountId).toBe('account-a');
    writeSessionActorRecord({ sessionId: 'origin-account', accountId: 'account-b', version: '2.0.0', startedAtMs: 2 });
    expect(readSessionActorRecord('origin-account')?.accountId).toBe('account-a');
    upsertSessionsBatch([{ meta: { ...scanMeta('origin-account'), accountId: 'account-b' }, content: '' }]);
    expect(getSessionById('origin-account')?.accountId).toBe('account-a');
  });

  it('fills harness from the sidecar so a deepseek run is not indexed as claude (PHNX-2935)', () => {
    writeSessionActorRecord({ sessionId: 'joined-harness', harness: 'deepseek', startedAtMs: 1 });
    upsertSession(scanMeta('joined-harness'), '');
    const meta = getSessionById('joined-harness');
    expect(meta?.agent).toBe('claude');
    expect(meta?.harness).toBe('deepseek');
  });

  it('preserves a stored harness on rescan and backfills a NULL-first row', () => {
    upsertSession(scanMeta('harness-backfill'), '');
    expect(getSessionById('harness-backfill')?.harness).toBeUndefined();
    writeSessionActorRecord({ sessionId: 'harness-backfill', harness: 'deepseek', startedAtMs: 1 });
    upsertSession(scanMeta('harness-backfill'), '');
    expect(getSessionById('harness-backfill')?.harness).toBe('deepseek');

    fs.rmSync(path.join(TEST_HOME, '.agents', '.history', 'by-session', 'harness-backfill.json'), { force: true });
    upsertSession({ ...scanMeta('harness-backfill'), topic: 'rescanned' }, '');
    expect(getSessionById('harness-backfill')?.harness).toBe('deepseek');
  });

  it('fills the origin version from the sidecar and preserves it across a version-less rescan (PHNX-3626)', () => {
    // A codex-style transcript whose scan derives no version: the launch-time
    // sidecar is the only source, and native resume needs it pinned.
    writeSessionActorRecord({ sessionId: 'joined-version', version: '0.146.0', startedAtMs: 1 });
    upsertSession(scanMeta('joined-version'), '');
    expect(getSessionById('joined-version')?.version).toBe('0.146.0');

    // Sidecar gone + a rescan that still can't derive a version must NOT erase the
    // recorded origin (COALESCE), else resume would relapse to /continue.
    fs.rmSync(path.join(TEST_HOME, '.agents', '.history', 'by-session', 'joined-version.json'), { force: true });
    upsertSession({ ...scanMeta('joined-version'), topic: 'rescanned' }, '');
    expect(getSessionById('joined-version')?.version).toBe('0.146.0');
  });

  it('fills actor/initiatedBy/phoenixId from the sidecar when the scanned meta has none', () => {
    writeSessionActorRecord({ sessionId: 'joined-1', actor: 'grace@example.com', initiatedBy: 'human', phoenixId: 'phx_grace', mode: 'edit', startedAtMs: 1 });
    upsertSession(scanMeta('joined-1'), '');
    const meta = getSessionById('joined-1');
    expect(meta?.actor).toBe('grace@example.com');
    expect(meta?.initiatedBy).toBe('human');
    expect(meta?.phoenixId).toBe('phx_grace');
    expect(meta?.mode).toBe('edit');
  });

  it('round-trips phoenixId from a sidecar record all the way to the sessions --json output (PHNX-3798)', () => {
    // The acceptance path: a human whose `actors:` entry carries a phoenixId
    // launches a session -> the sidecar records it -> the scan-join fills the
    // write-once phoenix_id column -> `agents sessions --json` surfaces it.
    writeSessionActorRecord({ sessionId: 'phx-1', actor: 'linus@example.com', initiatedBy: 'human', phoenixId: 'phx_linus', startedAtMs: 1 });
    upsertSession(scanMeta('phx-1'), '');
    const meta = getSessionById('phx-1');
    expect(meta).toBeTruthy();
    expect(meta?.phoenixId).toBe('phx_linus');
    // serializeSessionsJson is the single seam the `--json` listing emits through.
    const json = JSON.parse(serializeSessionsJson([meta!])) as Array<{ id: string; phoenixId?: string }>;
    expect(json[0].id).toBe('phx-1');
    expect(json[0].phoenixId).toBe('phx_linus');
  });

  it('BACKFILLS a null-first phoenix_id once the sidecar lands, and preserves it across a phoenixId-less rescan', () => {
    upsertSession(scanMeta('phx-backfill'), ''); // null-first: no sidecar yet
    expect(getSessionById('phx-backfill')?.phoenixId).toBeUndefined();
    writeSessionActorRecord({ sessionId: 'phx-backfill', actor: 'ada@example.com', initiatedBy: 'human', phoenixId: 'phx_ada', startedAtMs: 1 });
    upsertSession(scanMeta('phx-backfill'), '');
    expect(getSessionById('phx-backfill')?.phoenixId).toBe('phx_ada');
    // Sidecar gone + a rescan carrying no phoenixId must NOT erase the recorded id.
    fs.rmSync(path.join(TEST_HOME, '.agents', '.history', 'by-session', 'phx-backfill.json'), { force: true });
    upsertSession({ ...scanMeta('phx-backfill'), topic: 'rescanned' }, '');
    expect(getSessionById('phx-backfill')?.phoenixId).toBe('phx_ada');
  });

  it('leaves phoenixId undefined when the sidecar record carries none (honest absent field)', () => {
    writeSessionActorRecord({ sessionId: 'phx-none', actor: 'grace@example.com', initiatedBy: 'human', startedAtMs: 1 });
    upsertSession(scanMeta('phx-none'), '');
    const meta = getSessionById('phx-none');
    expect(meta?.actor).toBe('grace@example.com');
    expect(meta?.phoenixId).toBeUndefined();
    const json = JSON.parse(serializeSessionsJson([meta!])) as Array<Record<string, unknown>>;
    expect('phoenixId' in json[0]).toBe(false);
  });

  it('updates the persisted mode when a later native resume uses an explicit override', () => {
    writeSessionActorRecord({ sessionId: 'mode-1', mode: 'plan', startedAtMs: 1 });
    upsertSession(scanMeta('mode-1'), '');
    expect(getSessionById('mode-1')?.mode).toBe('plan');

    writeSessionActorRecord({ sessionId: 'mode-1', mode: 'auto', startedAtMs: 2 });
    upsertSession(scanMeta('mode-1'), '');
    expect(getSessionById('mode-1')?.mode).toBe('auto');
  });

  it('leaves actor null when no sidecar record exists (honest unattributed row)', () => {
    upsertSession(scanMeta('joined-2'), '');
    const meta = getSessionById('joined-2');
    expect(meta?.actor).toBeUndefined();
  });

  it('BACKFILLS a null-first row once the sidecar lands (RUSH-2018/2019 fix)', () => {
    // The bug: a scanner (an older build, or any scan that ran before the actor
    // sidecar was written) inserts the row with actor NULL. The write-once
    // ON CONFLICT then locked it to NULL forever, so the sidecar-join could never
    // attribute it. COALESCE(existing, incoming) must let the join fill a NULL.
    upsertSession(scanMeta('backfill-1'), ''); // null-first: no sidecar yet
    expect(getSessionById('backfill-1')?.actor).toBeUndefined();
    // Sidecar appears (the run had stamped it), a later rescan runs the join:
    writeSessionActorRecord({ sessionId: 'backfill-1', actor: 'ada@example.com', initiatedBy: 'human', startedAtMs: 1 });
    upsertSession(scanMeta('backfill-1'), '');
    expect(getSessionById('backfill-1')?.actor).toBe('ada@example.com');
    expect(getSessionById('backfill-1')?.initiatedBy).toBe('human');
  });

  it('an explicit meta.actor wins over the sidecar (caller-provided identity)', () => {
    writeSessionActorRecord({ sessionId: 'joined-3', actor: 'sidecar@example.com', initiatedBy: 'human', startedAtMs: 1 });
    const meta = { ...scanMeta('joined-3'), actor: 'explicit@example.com', initiatedBy: 'human' as const };
    upsertSession(meta, '');
    expect(getSessionById('joined-3')?.actor).toBe('explicit@example.com');
  });

  it('the batch scanner path joins the sidecar too (the real discover.ts flow)', () => {
    // upsertSessionsBatch is what every harness scanner in discover.ts calls.
    writeSessionActorRecord({ sessionId: 'batch-1', actor: 'linus@example.com', initiatedBy: 'human', startedAtMs: 1 });
    upsertSessionsBatch([
      { meta: scanMeta('batch-1'), content: '' }, // has a sidecar -> filled
      { meta: scanMeta('batch-2'), content: '' }, // no sidecar -> stays null
    ]);
    expect(getSessionById('batch-1')?.actor).toBe('linus@example.com');
    expect(getSessionById('batch-2')?.actor).toBeUndefined();
  });

  it('a rescan through the batch path does not clobber a stored owner', () => {
    writeSessionActorRecord({ sessionId: 'batch-3', actor: 'grace@example.com', initiatedBy: 'human', startedAtMs: 1 });
    upsertSessionsBatch([{ meta: scanMeta('batch-3'), content: '' }]);
    // Rescan: same id, new content, sidecar removed — the stored owner must persist
    // (ON CONFLICT excludes actor/initiated_by).
    fs.rmSync(path.join(TEST_HOME, '.agents', '.history', 'by-session', 'batch-3.json'), { force: true });
    upsertSessionsBatch([{ meta: { ...scanMeta('batch-3'), topic: 'rescanned' }, content: '' }]);
    const meta = getSessionById('batch-3');
    expect(meta?.topic).toBe('rescanned');
    expect(meta?.actor).toBe('grace@example.com');
  });
});
