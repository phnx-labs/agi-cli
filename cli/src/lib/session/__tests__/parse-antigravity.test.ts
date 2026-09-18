/**
 * Verifies parseAntigravity decodes Antigravity's protobuf-in-SQLite step
 * payloads into the shared SessionEvent shape, normalizes tool names onto the
 * existing vocabulary (run_command -> Bash, view_file -> Read, ...), dedupes the
 * request + completion steps that share a call id, and that detectAgent routes
 * antigravity-cli conversation DBs to this parser.
 *
 * The fixture is built here from scratch — a tiny SQLite `steps` table whose
 * `step_payload` BLOBs are hand-encoded protobuf messages (deterministic,
 * synthetic, no private conversation content). Both the fixture writer and the
 * parser under test read/write through the node/bun SQLite wrapper (the same
 * one production uses), so this exercises the real critical path (real SQLite
 * BLOB round-trip, real protobuf decode) on every OS — the `sqlite3` CLI is
 * absent on the Windows runner.
 */

import { describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from '../../sqlite.js';
import { parseAntigravity, detectAgent, parseSession } from '@phnx-labs/sessions-cli/reader';
import { extractRecentDirectoriesTouched, extractTodoProgressFromEvents } from '@phnx-labs/sessions-cli/reader';

// ── Minimal protobuf wire encoder (mirror of the decoder under test) ────────

/** Encode a non-negative integer as a base-128 varint. */
function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return out;
}

/** Encode a length-delimited string field: tag (field<<3|2) + len + utf8 bytes. */
function strField(field: number, s: string): number[] {
  const bytes = Array.from(Buffer.from(s, 'utf-8'));
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
}

/**
 * Build a step_payload for a tool call. Fields mirror the reverse-engineered
 * layout: f1 = call id, f2 = tool name, f3 = JSON args (must contain
 * "toolAction" for the decoder's JSON sniff). Optionally nests the tool-call
 * message one level deep to exercise the recursive descent.
 */
function toolStep(opts: {
  id: string;
  name: string;
  args: Record<string, any>;
  nested?: boolean;
}): Buffer {
  const inner = [
    ...strField(1, opts.id),
    ...strField(2, opts.name),
    ...strField(3, JSON.stringify(opts.args)),
  ];
  if (!opts.nested) return Buffer.from(inner);
  // Wrap `inner` as a sub-message under an arbitrary field number (7) so the
  // parser has to recurse to find the tool-call node.
  return Buffer.from([...varint((7 << 3) | 2), ...varint(inner.length), ...inner]);
}

/** Create a temp Antigravity conversation DB with the given step payloads. */
function buildDb(steps: Array<{ stepType: number; payload: Buffer }>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-parse-'));
  const conv = path.join(dir, '.gemini', 'antigravity-cli', 'conversations');
  fs.mkdirSync(conv, { recursive: true });
  const dbPath = path.join(conv, 'fixture-uuid.db');

  const db = new Database(dbPath);
  db.exec(
    'CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, step_payload blob);',
  );
  const insert = db.prepare(
    'INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?);',
  );
  steps.forEach((s, i) => insert.run(i, s.stepType, s.payload));
  db.close();
  return dbPath;
}

describe('parseAntigravity', () => {
  test('decodes protobuf steps, normalizes tool names, dedupes by call id', () => {
    // Three raw steps -> two unique tools. The run_command appears twice (a
    // request step + a completion step sharing call id "aaaa1111").
    const dbPath = buildDb([
      {
        stepType: 15,
        payload: toolStep({
          id: 'aaaa1111',
          name: 'run_command',
          args: { CommandLine: 'echo hi', Cwd: '/work', toolAction: 'Running echo', toolSummary: 'Run echo' },
        }),
      },
      {
        stepType: 21, // completion — same id, must be deduped away
        payload: toolStep({
          id: 'aaaa1111',
          name: 'run_command',
          args: { CommandLine: 'echo hi', Cwd: '/work', toolAction: 'Running echo', toolSummary: 'Run echo' },
        }),
      },
      {
        stepType: 15,
        payload: toolStep({
          id: 'bbbb2222',
          name: 'view_file',
          args: { AbsolutePath: '/tmp/x', toolAction: 'Viewing x', toolSummary: 'View x' },
          nested: true, // force recursive descent for this one
        }),
      },
    ]);

    const events = parseAntigravity(dbPath);
    expect(extractTodoProgressFromEvents(events)).toBeUndefined();

    // Deduped: 3 steps -> 2 events.
    expect(events).toHaveLength(2);

    const bash = events[0];
    expect(bash.type).toBe('tool_use');
    expect(bash.agent).toBe('antigravity');
    expect(bash.tool).toBe('Bash');
    expect(bash.command).toBe('echo hi');
    expect(bash.content).toBe('Run echo');
    expect(extractRecentDirectoriesTouched(events, '/fallback')).toEqual(['/work']);

    const read = events[1];
    expect(read.tool).toBe('Read');
    expect(read.path).toBe('/tmp/x');
    expect(read.command).toBeUndefined();
    expect(read.content).toBe('View x');

    fs.rmSync(path.dirname(path.dirname(path.dirname(path.dirname(dbPath)))), { recursive: true, force: true });
  });

  test('maps the remaining tool names onto the shared vocabulary + passes unknowns through', () => {
    const dbPath = buildDb([
      { stepType: 15, payload: toolStep({ id: 'c1', name: 'list_dir', args: { DirectoryPath: '/d', toolAction: 'x', toolSummary: 'List' } }) },
      { stepType: 15, payload: toolStep({ id: 'c2', name: 'grep_search', args: { SearchPath: '/g', Query: 'q', toolAction: 'x', toolSummary: 'Grep' } }) },
      { stepType: 15, payload: toolStep({ id: 'c3', name: 'replace_file_content', args: { TargetFile: '/e', toolAction: 'x', toolSummary: 'Edit' } }) },
      { stepType: 15, payload: toolStep({ id: 'c4', name: 'write_to_file', args: { TargetFile: '/w', toolAction: 'x', toolSummary: 'Write' } }) },
      { stepType: 15, payload: toolStep({ id: 'c5', name: 'some_future_tool', args: { Foo: 'bar', toolAction: 'x', toolSummary: 'Future' } }) },
    ]);

    const events = parseAntigravity(dbPath);
    expect(events.map(e => e.tool)).toEqual(['LS', 'Grep', 'Edit', 'Write', 'some_future_tool']);
    expect(events[0].path).toBe('/d');
    expect(events[1].path).toBe('/g');
    expect(events[2].path).toBe('/e');
    expect(events[3].path).toBe('/w');
    // Unknown tool passes through with its raw args preserved.
    expect(events[4].tool).toBe('some_future_tool');
    expect(events[4].args?.Foo).toBe('bar');

    fs.rmSync(path.dirname(path.dirname(path.dirname(path.dirname(dbPath)))), { recursive: true, force: true });
  });

  test('detectAgent + parseSession route antigravity conversation DBs here', () => {
    const dbPath = buildDb([
      { stepType: 15, payload: toolStep({ id: 'd1', name: 'run_command', args: { CommandLine: 'ls', toolAction: 'x', toolSummary: 'List dir' } }) },
    ]);

    // The path is under ~/.gemini/antigravity-cli/conversations/ (also matches
    // /.gemini/), so this asserts antigravity wins over the gemini fallback.
    expect(detectAgent(dbPath)).toBe('antigravity');

    const events = parseSession(dbPath);
    expect(events).toHaveLength(1);
    expect(events[0].agent).toBe('antigravity');
    expect(events[0].tool).toBe('Bash');
    expect(events[0].command).toBe('ls');

    fs.rmSync(path.dirname(path.dirname(path.dirname(path.dirname(dbPath)))), { recursive: true, force: true });
  });
});
