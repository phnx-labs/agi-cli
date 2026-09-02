import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-sessions-backfill-'));
process.env.HOME = TEST_HOME;

const { closeDB, getDB, getSessionById, upsertSession } = await import('../lib/session/db.js');
const { discoverSessions } = await import('../lib/session/discover.js');
const { backfillToolsLocal, runToolsBackfill, runTitlesBackfill } = await import('./sessions-backfill.js');
type SessionMeta = import('../lib/session/types.js').SessionMeta;

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('sessions backfill tools', () => {
  it('populates historical rows once and resumes as an idempotent no-op', async () => {
    const filePath = path.join(TEST_HOME, '.codex', 'sessions', '2026', '08', '03', 'backfill.jsonl');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, [
      { timestamp: '2026-08-03T00:00:00Z', type: 'response_item', payload: {
        type: 'function_call', name: 'exec_command', call_id: 'backfill-call',
        arguments: JSON.stringify({ cmd: 'git status; git diff' }),
      } },
      { timestamp: '2026-08-03T00:00:01Z', type: 'response_item', payload: {
        type: 'function_call_output', call_id: 'backfill-call', output: 'clean',
      } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    upsertSession({
      id: 'backfill-session', shortId: 'backfill', agent: 'codex',
      timestamp: '2026-08-03T00:00:00Z', filePath,
    } as SessionMeta, 'backfill tools');
    await discoverSessions({ agent: 'codex', all: true, unbounded: true, includeUnmanaged: true });
    getDB().exec(`
      DELETE FROM tool_program_occurrences;
      DELETE FROM tool_call_programs;
      DELETE FROM tool_call_text;
      DELETE FROM tool_calls;
      DELETE FROM tool_scan_ledger;
    `);

    const first = await runToolsBackfill({ local: true, unmanaged: true, agent: 'codex' });
    expect(first).toMatchObject({ complete: true, machines: [{ indexedFiles: 1, indexedCalls: 1 }] });
    expect(getDB().prepare(`
      SELECT occurrence_ordinal, program FROM tool_program_occurrences ORDER BY occurrence_ordinal
    `).all()).toEqual([
      { occurrence_ordinal: 0, program: 'git' },
      { occurrence_ordinal: 1, program: 'git' },
    ]);

    const second = await runToolsBackfill({ local: true, unmanaged: true, agent: 'codex' });
    expect(second).toMatchObject({ complete: true, machines: [{ indexedFiles: 0, indexedCalls: 0 }] });
  });

  it('keeps a remote-style invocation to one bounded batch', async () => {
    for (let index = 0; index < 30; index++) {
      const id = `batch-session-${index}`;
      const filePath = path.join(TEST_HOME, '.codex', 'sessions', '2026', '08', '03', `${id}.jsonl`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({
        timestamp: '2026-08-03T00:00:00Z', type: 'response_item', payload: {
          type: 'function_call', name: 'exec_command', call_id: `${id}-call`,
          arguments: JSON.stringify({ cmd: 'git status' }),
        },
      }) + '\n');
      upsertSession({
        id, shortId: id.slice(0, 8), agent: 'codex',
        timestamp: '2026-08-03T00:00:00Z', filePath,
      } as SessionMeta, id);
    }
    await discoverSessions({ agent: 'codex', all: true, unbounded: true, includeUnmanaged: true });
    getDB().exec(`
      DELETE FROM tool_program_occurrences;
      DELETE FROM tool_call_programs;
      DELETE FROM tool_call_text;
      DELETE FROM tool_calls;
      DELETE FROM tool_scan_ledger;
    `);

    const first = await backfillToolsLocal({ local: true, unmanaged: true, agent: 'codex' }, true);
    expect(first.indexedFiles).toBe(25);
    expect(first.coverage.complete).toBe(false);
    const second = await runToolsBackfill({ local: true, unmanaged: true, agent: 'codex' });
    expect(second.complete).toBe(true);
    expect(second.machines[0].indexedFiles).toBeGreaterThan(0);
  });
});

describe('sessions backfill titles (the explicit-refresh half of PHNX-3797)', () => {
  const id = 'title-backfill-session';

  it('generates a headline for an untitled session on demand, then cache-hits', async () => {
    upsertSession({
      id, shortId: 'titlebf', agent: 'codex',
      timestamp: new Date().toISOString(), lastActivity: new Date().toISOString(),
      filePath: path.join(TEST_HOME, 'titles.jsonl'),
      topic: 'the sessions list headline is the agent last message',
      firstUserMessage: 'Every row headlines the agent latest message. Make it a real title.',
    } as SessionMeta, 'make it a real title');

    let calls = 0;
    const run = async () => { calls++; return 'Session headline ladder fix'; };

    const first = await runTitlesBackfill({ session: id, run });
    expect(first).toMatchObject({ kind: 'titles-backfill', generated: 1, failed: 0 });
    expect(getSessionById(id)?.generatedTitle).toBe('Session headline ladder fix');

    const second = await runTitlesBackfill({ session: id, run });
    expect(second).toMatchObject({ generated: 0, cached: 1 });
    expect(calls).toBe(1);

    const refreshed = await runTitlesBackfill({ session: id, refresh: true, run: async () => 'Regenerated headline' });
    expect(refreshed.generated).toBe(1);
    expect(getSessionById(id)?.generatedTitle).toBe('Regenerated headline');
  });

  it('rejects a non-positive --limit loudly instead of silently doing nothing', async () => {
    await expect(runTitlesBackfill({ limit: '0' })).rejects.toThrow(/--limit must be a positive integer/);
    await expect(runTitlesBackfill({ limit: 'many' })).rejects.toThrow(/--limit must be a positive integer/);
  });
});
