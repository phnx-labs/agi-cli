import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate HOME before db.js captures its module-level DB path (same pattern as
// first-user-message.test.ts / the db migration tests). Dynamic imports run
// AFTER the override so the real index lives under this throwaway home.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-prev-rows-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { upsertSession } = await import('../db.js');
const { buildPreviousRows, toSessionWatchRow } = await import('./watch.js');
type SessionMeta = import('../types.js').SessionMeta;

const SEED_DIR = path.join(TEST_HOME, 'seed');
fs.mkdirSync(SEED_DIR, { recursive: true });

const SCOPE = 'previous-box';
const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const RECENT = '2026-08-31T09:00:00.000Z';

/** Seed one indexed session (with a real transcript file unless `synthetic`). */
function seed(over: Partial<SessionMeta> & { id: string }, synthetic = false): string {
  const filePath = synthetic ? '' : path.join(SEED_DIR, `${over.id}.jsonl`);
  if (filePath) fs.writeFileSync(filePath, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
  const meta: SessionMeta = {
    shortId: over.id.slice(0, 7),
    agent: 'claude',
    timestamp: RECENT,
    lastActivity: RECENT,
    machine: SCOPE,
    ...over,
    filePath,
  };
  upsertSession(meta, 'hi', { fileMtimeMs: 1, fileSize: filePath ? fs.statSync(filePath).size : 0 });
  return filePath;
}

describe('buildPreviousRows — durable recoverable history from the index (PHNX-3621)', () => {
  it('projects a recent local session into a resumable Previous row carrying its enrichment', () => {
    seed({
      id: 'prev-basic',
      version: '2.1.200',
      account: 'dev@example.com',
      harness: 'claude',
      topic: 'Short first line',
      firstUserMessage: 'The full genuine first user turn, verbatim and untruncated.',
      cwd: '/repo/x',
      ticketId: 'PHNX-3621',
    });

    const r = buildPreviousRows(SCOPE, { nowMs: NOW }).find((x) => x.sessionId === 'prev-basic');
    expect(r).toBeDefined();
    expect(r!.previous).toBe(true);
    expect(r!.status).toBe('closed');
    expect(r!.firstUserMessage).toBe('The full genuine first user turn, verbatim and untruncated.');
    expect(r!.version).toBe('2.1.200');
    expect(r!.account).toBe('dev@example.com');
    expect(r!.harness).toBe('claude');
    expect(r!.machine).toBe(SCOPE);
    expect(r!.ticket).toMatchObject({ id: 'PHNX-3621' });
  });

  it('honors the row cap and the 7-day window', () => {
    for (let i = 0; i < 5; i++) seed({ id: `cap-${i}` });
    // A stale row well outside the 7-day window must not appear.
    seed({ id: 'ancient', timestamp: '2026-07-01T00:00:00.000Z', lastActivity: '2026-07-01T00:00:00.000Z' });

    expect(buildPreviousRows(SCOPE, { nowMs: NOW, limit: 3 }).length).toBeLessThanOrEqual(3);
    expect(buildPreviousRows(SCOPE, { nowMs: NOW }).map((r) => r.sessionId)).not.toContain('ancient');
  });

  it('emits a resumable harness but excludes a captured-only one that cannot recover', () => {
    // Two rows identical except harness: a resumable Claude vs a captured-only
    // Grok (buildResumeCommand → null). The stream carries RECOVERABLE history,
    // so only the Claude must appear — a Grok Previous row would carry a dead
    // Resume (PHNX-3621).
    seed({ id: 'resumable-claude', agent: 'claude', harness: 'claude' });
    seed({ id: 'captured-grok', agent: 'grok', harness: 'grok' });

    const rows = buildPreviousRows(SCOPE, { nowMs: NOW });
    const ids = rows.map((r) => r.sessionId);
    expect(ids).toContain('resumable-claude');
    expect(ids).not.toContain('captured-grok');

    // Projected into the watch stream, the surviving Claude row is genuinely
    // recoverable — resumable with a live Resume command, never a dead one.
    const watchRow = toSessionWatchRow(SCOPE, rows.find((r) => r.sessionId === 'resumable-claude')!);
    expect(watchRow.previous).toBe(true);
    expect(watchRow.resumable).toBe(true);
    expect(watchRow.recovery).toMatchObject({ command: 'agents', args: ['sessions', 'resume', 'resumable-claude', '--device', SCOPE] });
  });

  it('excludes team-origin, a foreign-box mirror, a synthetic row, and an archived (file-gone) row', () => {
    seed({ id: 'team-child', isTeamOrigin: true });
    seed({ id: 'foreign', machine: 'some-other-box' });
    seed({ id: 'synthetic-channel' }, true);
    const goneFile = seed({ id: 'archived-gone' });
    fs.rmSync(goneFile); // transcript removed → querySessions stamps it archived

    const ids = buildPreviousRows(SCOPE, { nowMs: NOW }).map((r) => r.sessionId);
    expect(ids).not.toContain('team-child');
    expect(ids).not.toContain('foreign');
    expect(ids).not.toContain('synthetic-channel');
    expect(ids).not.toContain('archived-gone');
  });
});
