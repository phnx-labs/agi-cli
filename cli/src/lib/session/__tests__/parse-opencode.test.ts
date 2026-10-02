/**
 * Verifies parseOpenCode reads an OpenCode session out of its SQLite database
 * (session -> message -> part) and normalizes each part into the shared
 * SessionEvent shape: text -> message, reasoning -> thinking, tool ->
 * tool_use (+ tool_result / error for completed calls).
 *
 * The fixture is built here from scratch — a tiny SQLite DB with the real
 * OpenCode `message`/`part` schema. Both the fixture writer and the parser
 * under test read/write through the node/bun SQLite wrapper (the same one
 * production uses), not the `sqlite3` CLI, so this exercises the real critical
 * path on every OS — the `sqlite3` CLI is absent on the Windows runner
 * (issue #751).
 */

import { describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from '../../sqlite.js';
import { parseOpenCode } from '@phnx-labs/sessions-cli/reader';
import { extractTodoProgressFromEvents } from '@phnx-labs/sessions-cli/reader';

interface PartRow {
  id: string;
  messageId: string;
  data: unknown;
}
interface MessageRow {
  id: string;
  role: 'user' | 'assistant';
  timeCreated: number;
  parts: PartRow[];
}

/** Create a temp OpenCode DB (session/message/part) with the given messages. */
function buildDb(sessionId: string, messages: MessageRow[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-parse-'));
  const dbPath = path.join(dir, 'opencode.db');

  const db = new Database(dbPath);
  db.exec(
    `CREATE TABLE message (
       id text PRIMARY KEY,
       session_id text NOT NULL,
       time_created integer NOT NULL,
       time_updated integer NOT NULL,
       data text NOT NULL
     );
     CREATE TABLE part (
       id text PRIMARY KEY,
       message_id text NOT NULL,
       session_id text NOT NULL,
       time_created integer NOT NULL,
       time_updated integer NOT NULL,
       data text NOT NULL
     );`,
  );
  const insMsg = db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?);',
  );
  const insPart = db.prepare(
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?);',
  );
  for (const m of messages) {
    insMsg.run(m.id, sessionId, m.timeCreated, m.timeCreated, JSON.stringify({ role: m.role }));
    m.parts.forEach((p, i) => {
      insPart.run(p.id, m.id, sessionId, m.timeCreated + i, m.timeCreated + i, JSON.stringify(p.data));
    });
  }
  db.close();
  return dbPath;
}

describe('parseOpenCode', () => {
  test('normalizes text, reasoning, and tool parts into SessionEvents', () => {
    const sessionId = 'ses_test1';
    const dbPath = buildDb(sessionId, [
      {
        id: 'msg_1',
        role: 'user',
        timeCreated: 1_700_000_000_000,
        parts: [{ id: 'prt_1', messageId: 'msg_1', data: { type: 'text', text: 'fix the bug' } }],
      },
      {
        id: 'msg_2',
        role: 'assistant',
        timeCreated: 1_700_000_001_000,
        parts: [
          { id: 'prt_2', messageId: 'msg_2', data: { type: 'reasoning', text: 'let me look' } },
          { id: 'prt_3', messageId: 'msg_2', data: { type: 'text', text: 'on it' } },
          {
            id: 'prt_4',
            messageId: 'msg_2',
            data: {
              type: 'tool',
              tool: 'shell',
              state: { input: { command: 'ls -la' }, output: 'file.txt', status: 'completed' },
            },
          },
        ],
      },
    ]);

    const events = parseOpenCode(`${dbPath}#${sessionId}`);
    expect(extractTodoProgressFromEvents(events)).toBeUndefined();

    expect(events.map(e => e.type)).toEqual([
      'message', // user text
      'thinking', // reasoning
      'message', // assistant text
      'tool_use', // shell call
      'tool_result', // shell output
    ]);

    const userMsg = events[0];
    expect(userMsg.agent).toBe('opencode');
    expect(userMsg.role).toBe('user');
    expect(userMsg.content).toBe('fix the bug');
    // Timestamp comes from the row's integer epoch-ms, not now().
    expect(userMsg.timestamp).toBe(new Date(1_700_000_000_000).toISOString());

    expect(events[1].content).toBe('let me look');
    expect(events[2].role).toBe('assistant');
    expect(events[2].content).toBe('on it');

    const toolUse = events[3];
    expect(toolUse.tool).toBe('shell');
    expect(toolUse.command).toBe('ls -la');
    expect(toolUse.args).toEqual({ command: 'ls -la' });

    const toolResult = events[4];
    expect(toolResult.type).toBe('tool_result');
    expect(toolResult.success).toBe(true);
    expect(toolResult.output).toBe('file.txt');

    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test('marks failed tool calls as error events and captures filePath', () => {
    const sessionId = 'ses_test2';
    const dbPath = buildDb(sessionId, [
      {
        id: 'msg_1',
        role: 'assistant',
        timeCreated: 1_700_000_002_000,
        parts: [
          {
            id: 'prt_1',
            messageId: 'msg_1',
            data: {
              type: 'tool',
              tool: 'read',
              state: { input: { filePath: '/tmp/x' }, output: 'boom', status: 'error' },
            },
          },
        ],
      },
    ]);

    const events = parseOpenCode(`${dbPath}#${sessionId}`);
    expect(events.map(e => e.type)).toEqual(['tool_use', 'error']);
    expect(events[0].path).toBe('/tmp/x');
    expect(events[1].success).toBe(false);
    expect(events[1].output).toBe('boom');

    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test('binds the session id as a parameter (no SQL injection via quotes)', () => {
    // A session id containing a single quote must be matched literally by the
    // parameterized query, not interpolated into the SQL text.
    const sessionId = `ses_o'brien`;
    const dbPath = buildDb(sessionId, [
      {
        id: 'msg_1',
        role: 'user',
        timeCreated: 1_700_000_003_000,
        parts: [{ id: 'prt_1', messageId: 'msg_1', data: { type: 'text', text: 'quoted id works' } }],
      },
    ]);

    const events = parseOpenCode(`${dbPath}#${sessionId}`);
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe('quoted id works');

    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  test('returns [] for a missing db path or malformed filePath', () => {
    expect(parseOpenCode('/nonexistent/opencode.db#ses_x')).toEqual([]);
    expect(parseOpenCode('/nonexistent/opencode.db')).toEqual([]);
    expect(parseOpenCode('')).toEqual([]);
  });
});
