/**
 * The titling sweep against a REAL session index (PHNX-3797). Only the model
 * call is injected — that is the module's declared boundary (the same seam the
 * watchdog agent uses); candidate selection, the source-key cache, persistence,
 * and the scan upsert's preservation of a written title all run for real.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate a fresh HOME BEFORE importing state/db — db.ts captures DB_PATH at
// module load (same pattern as the migration/mirror tests in this directory).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-titletick-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getSessionsDir } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const db = await import('./db.js');
const { runSessionTitleTick, SESSION_TITLE_PROMPT_MARKER } = await import('./title.js');
const { machineId } = await import('./sync/config.js');

const self = machineId();

function seed(id: string, over: Record<string, unknown> = {}): void {
  const meta: any = {
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: '2026-09-01T10:00:00.000Z',
    lastActivity: new Date().toISOString(),
    filePath: `/tmp/${id}.jsonl`,
    machine: self,
    project: 'agents-cli',
    topic: 'fix the session headline',
    firstUserMessage: 'The Sessions list shows the agent latest message as the headline. Fix it.',
    ...over,
  };
  db.upsertSession(meta, String(meta.firstUserMessage ?? ''));
}

describe('runSessionTitleTick (real index, injected model call)', () => {
  it('generates once, persists it, and cache-hits on the next sweep', async () => {
    seed('11111111-0000-0000-0000-000000000001');
    let calls = 0;
    const run = async () => {
      calls++;
      return '"Session headline ladder fix"\n';
    };

    const first = await runSessionTitleTick({ run, limit: 5 });
    expect(first.generated).toBe(1);
    expect(calls).toBe(1);
    expect(db.getSessionById('11111111-0000-0000-0000-000000000001')?.generatedTitle)
      .toBe('Session headline ladder fix');

    const second = await runSessionTitleTick({ run, limit: 5 });
    expect(second.generated).toBe(0);
    expect(second.cached).toBe(1);
    // The point of the source key: a titled session costs ZERO model calls forever.
    expect(calls).toBe(1);
  });

  it('re-titles when the first user message changes, and on an explicit refresh', async () => {
    const id = '22222222-0000-0000-0000-000000000002';
    seed(id);
    await runSessionTitleTick({ run: async () => 'First title', limit: 5 });
    expect(db.getSessionById(id)?.generatedTitle).toBe('First title');

    // The user's first turn is re-derived by a rescan (a resumed transcript whose
    // real first turn finally parsed): the stored key no longer matches.
    seed(id, { firstUserMessage: 'Actually: make the fleet mirror carry the title too.' });
    const changed = await runSessionTitleTick({ run: async () => 'Mirror carries title', limit: 5 });
    expect(changed.generated).toBe(1);
    expect(db.getSessionById(id)?.generatedTitle).toBe('Mirror carries title');

    const forced = await runSessionTitleTick({ id, force: true, run: async () => 'Refreshed title' });
    expect(forced.generated).toBe(1);
    expect(db.getSessionById(id)?.generatedTitle).toBe('Refreshed title');
  });

  it('leaves the row untitled when generation fails — the fallback stays the user\'s own words', async () => {
    const id = '33333333-0000-0000-0000-000000000003';
    seed(id, { firstUserMessage: 'A request nobody could title right now.' });
    const result = await runSessionTitleTick({
      id,
      run: async () => { throw new Error('no signed-in harness'); },
    });
    expect(result.failed).toBe(1);
    expect(result.generated).toBe(0);
    const meta = db.getSessionById(id)!;
    expect(meta.generatedTitle).toBeUndefined();
    expect(meta.firstUserMessage).toBe('A request nobody could title right now.');
  });

  it('never titles a session whose own prompt IS a title-generation prompt', async () => {
    const id = '44444444-0000-0000-0000-000000000004';
    seed(id, {
      topic: SESSION_TITLE_PROMPT_MARKER,
      firstUserMessage: `${SESSION_TITLE_PROMPT_MARKER} naming what this coding session worked on.`,
    });
    let calls = 0;
    await runSessionTitleTick({ id, run: async () => { calls++; return 'Nope'; } });
    expect(calls).toBe(0);
    expect(db.getSessionById(id)?.generatedTitle).toBeUndefined();
  });

  it('skips a session that already carries a /rename label — the label outranks a title', async () => {
    const id = '55555555-0000-0000-0000-000000000005';
    seed(id, { label: 'ship the auth fix' });
    const swept = await runSessionTitleTick({ run: async () => 'Should not be used', limit: 10 });
    expect(swept.titles.some((t) => t.id === id)).toBe(false);
    expect(db.getSessionById(id)?.generatedTitle).toBeUndefined();
  });

  it('keeps the stored title across a later transcript rescan', async () => {
    const id = '66666666-0000-0000-0000-000000000006';
    seed(id);
    await runSessionTitleTick({ id, run: async () => 'Durable across rescan' });
    // A normal incremental scan re-upserts the row; it carries no title column,
    // so the value must survive (the scanner never names those columns).
    seed(id, { messageCount: 42 });
    expect(db.getSessionById(id)?.generatedTitle).toBe('Durable across rescan');
  });
});

describe('explicit --session targeting', () => {
  it('fails loud for an id no indexed session matches, instead of reporting a quiet zero', async () => {
    await expect(runSessionTitleTick({ id: 'not-a-real-session', run: async () => 'x' }))
      .rejects.toThrow(/no indexed session matches "not-a-real-session"/);
  });

  it('accepts a short id', async () => {
    const id = '77777777-0000-0000-0000-000000000007';
    seed(id);
    const result = await runSessionTitleTick({ id: id.slice(0, 8), run: async () => 'Short id target' });
    expect(result.generated).toBe(1);
    expect(db.getSessionById(id)?.generatedTitle).toBe('Short id target');
  });
});
