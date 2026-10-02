import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionEvent, SessionMeta } from '@phnx-labs/sessions-cli/reader';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-db-reparse-'));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const db = await import('./db.js');

afterAll(() => {
  db.closeDB();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('upsertSessionsBatch scanner event reuse', () => {
  it('indexes scanner-produced events without reopening the transcript', () => {
    const missingTranscript = path.join(testHome, '.cursor', 'missing.jsonl');
    const meta: SessionMeta = {
      id: 'cursor-single-parse',
      shortId: 'cursor-s',
      agent: 'cursor',
      timestamp: '2026-08-05T00:00:00.000Z',
      cwd: '/tmp/project',
      filePath: missingTranscript,
      messageCount: 2,
    };
    const events: SessionEvent[] = [
      {
        type: 'message',
        agent: 'cursor',
        timestamp: '2026-08-05T00:00:00.500Z',
        role: 'user',
        content: 'Keep the complete request\nwith its acceptance criteria.',
      },
      {
        type: 'tool_use',
        agent: 'cursor',
        timestamp: '2026-08-05T00:00:01.000Z',
        tool: 'TodoWrite',
        args: { todos: [{ content: 'Avoid the second parse', status: 'in_progress' }] },
      },
    ];

    db.upsertSessionsBatch([{
      meta,
      content: 'single parse',
      scan: { fileMtimeMs: 1, fileSize: 1 },
      events,
    }]);

    expect(fs.existsSync(missingTranscript)).toBe(false);
    expect(db.getSessionById(meta.id)?.todos).toMatchObject({
      done: 0,
      total: 1,
      activeForm: 'Avoid the second parse',
    });
    expect(db.getSessionById(meta.id)?.firstUserMessage).toBe(
      'Keep the complete request\nwith its acceptance criteria.',
    );
    expect((db.getDB().prepare(
      'SELECT count(*) AS count FROM tool_calls WHERE session_id = ?',
    ).get(meta.id) as { count: number }).count).toBe(1);
  });

  it('skips parseSession for kimi/grok large-transcript entries with no events (PHNX-3411)', () => {
    // Kimi reads wire.jsonl and Grok reads chat_history.jsonl — potentially
    // large flat files. Their scanners produce only metadata, no events.
    // The warm tick must NOT open the transcript file for these agents —
    // tool indexing is deferred to runDeferredToolIndex. Verify by pointing
    // filePath at a non-existent file: if parseSession were called it would
    // throw and the upsert would fail.
    const deferredAgents: Array<SessionMeta['agent']> = ['kimi', 'grok'];
    for (const agent of deferredAgents) {
      const missingTranscript = path.join(testHome, `.${agent}`, 'no-events.jsonl');
      const meta: SessionMeta = {
        id: `${agent}-no-events`,
        shortId: `${agent}-ne`,
        agent,
        timestamp: '2026-08-05T00:00:00.000Z',
        cwd: '/tmp/project',
        filePath: missingTranscript,
        messageCount: 5,
      };
      // No events — scanner produced only metadata.
      db.upsertSessionsBatch([{
        meta,
        content: 'no events',
        scan: { fileMtimeMs: 1, fileSize: 1 },
      }]);
      // Transcript file must not have been created or opened.
      expect(fs.existsSync(missingTranscript)).toBe(false);
      // Session row inserted with metadata intact.
      expect(db.getSessionById(meta.id)?.agent).toBe(agent);
      // No tool_calls written — deferred to runDeferredToolIndex.
      expect((db.getDB().prepare(
        'SELECT count(*) AS count FROM tool_calls WHERE session_id = ?',
      ).get(meta.id) as { count: number }).count).toBe(0);
    }
  });
});
