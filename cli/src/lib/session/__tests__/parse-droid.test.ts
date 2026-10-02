/**
 * Verifies parseDroid normalizes Droid's (Factory) message-envelope JSONL to
 * the shared SessionEvent shape, drops injected <system-reminder> context, and
 * detectAgent routes ~/.factory/ paths to the droid parser.
 */

import { describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { parseDroid, detectAgent, parseSession } from '@phnx-labs/sessions-cli/reader';

// fileURLToPath (not new URL().pathname) — on Windows the latter yields
// "/C:/…", so path.join produces a doubled-drive "C:\C:\…" that ENOENTs.
const TESTDATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testdata');

function writeTmp(content: string): string {
  const dir = path.join(os.tmpdir(), `droid-parse-${Date.now()}-${Math.random()}`, '.factory', 'sessions', 'proj');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(p, content);
  return p;
}

describe('parseDroid', () => {
  test('maps session_start + message envelope to normalized events', () => {
    const jsonl = [
      { type: 'session_start', id: 's1', title: 'Hi there', sessionTitle: 'Greeting', cwd: '/work' },
      {
        type: 'message',
        timestamp: '2026-06-30T10:00:00Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<system-reminder>injected context</system-reminder>' },
            { type: 'text', text: 'How do I run the tests?' },
          ],
        },
      },
      {
        type: 'message',
        timestamp: '2026-06-30T10:00:01Z',
        message: {
          role: 'assistant',
          modelId: 'claude-opus-4-8',
          content: [
            { type: 'thinking', thinking: 'consider the options' },
            { type: 'text', text: 'Run bun test.' },
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'bun test' } },
          ],
        },
      },
      {
        type: 'message',
        timestamp: '2026-06-30T10:00:02Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu1', content: 'all green' },
          ],
        },
      },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n');

    const p = writeTmp(jsonl);
    try {
      const events = parseDroid(p);
      // session_start skipped; system-reminder block dropped.
      expect(events).toHaveLength(5);
      expect(events[0]).toMatchObject({ type: 'message', agent: 'droid', role: 'user', content: 'How do I run the tests?' });
      expect(events[1]).toMatchObject({ type: 'thinking', content: 'consider the options' });
      expect(events[2]).toMatchObject({ type: 'message', role: 'assistant', content: 'Run bun test.' });
      expect(events[3]).toMatchObject({ type: 'tool_use', tool: 'Bash', callId: 'tu1', command: 'bun test' });
      expect(events[4]).toMatchObject({ type: 'tool_result', tool: 'Bash', callId: 'tu1', success: true, output: 'all green' });
    } finally {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    }
  });

  test('marks is_error tool_result as an error event', () => {
    const jsonl = [
      { type: 'message', timestamp: '2026-06-30T10:00:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'false' } }] } },
      { type: 'message', timestamp: '2026-06-30T10:00:01Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'boom' }] } },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n');

    const p = writeTmp(jsonl);
    try {
      const events = parseDroid(p);
      expect(events.find((e) => e.type === 'error')).toMatchObject({ type: 'error', tool: 'Bash', content: 'boom' });
    } finally {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    }
  });
});

describe('parseDroid Execute and Create tools', () => {
  test('Execute tool_use sets command from fixture', () => {
    // Uses synthetic fixture: testdata/droid-execute-create.jsonl
    // Routes through a tmp .factory path so detectAgent works correctly.
    const fixtureContent = fs.readFileSync(path.join(TESTDATA, 'droid-execute-create.jsonl'), 'utf-8');
    const dir = path.join(os.tmpdir(), `droid-exec-${Date.now()}`, '.factory', 'sessions', 'proj');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(p, fixtureContent);
    try {
      const events = parseDroid(p);
      const execEvent = events.find((e) => e.type === 'tool_use' && e.tool === 'Execute');
      expect(execEvent).toBeDefined();
      expect(execEvent).toMatchObject({ type: 'tool_use', tool: 'Execute', command: 'ls -la' });
    } finally {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    }
  });

  test('Create tool_use sets path from file_path field', () => {
    const fixtureContent = fs.readFileSync(path.join(TESTDATA, 'droid-execute-create.jsonl'), 'utf-8');
    const dir = path.join(os.tmpdir(), `droid-create-${Date.now()}`, '.factory', 'sessions', 'proj');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(p, fixtureContent);
    try {
      const events = parseDroid(p);
      const createEvent = events.find((e) => e.type === 'tool_use' && e.tool === 'Create');
      expect(createEvent).toBeDefined();
      expect(createEvent).toMatchObject({ type: 'tool_use', tool: 'Create', path: '/work/hello.ts' });
    } finally {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    }
  });

  test('Execute tool_use carries its `summary` as the per-call label', () => {
    // Droid spells the human one-liner `summary` where Claude spells it
    // `description`. Without it the timeline's now-line renders `ls -la` instead
    // of "List files" — the harness-parity gap in review BLOCKER 3.
    const fixtureContent = fs.readFileSync(path.join(TESTDATA, 'droid-execute-create.jsonl'), 'utf-8');
    const dir = path.join(os.tmpdir(), `droid-label-${Date.now()}`, '.factory', 'sessions', 'proj');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(p, fixtureContent);
    try {
      const events = parseDroid(p);
      const execEvent = events.find((e) => e.type === 'tool_use' && e.tool === 'Execute');
      expect(execEvent?.label).toBe('List files');
    } finally {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    }
  });
});

describe('detectAgent routes droid paths', () => {
  test('local ~/.factory/ path', () => {
    expect(detectAgent('/home/me/.factory/sessions/proj/abc.jsonl')).toBe('droid');
  });

  test('parseSession dispatches through detectAgent for droid', () => {
    const jsonl =
      JSON.stringify({
        type: 'message',
        timestamp: '2026-06-30T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hello droid' }] },
      }) + '\n';

    const p = writeTmp(jsonl);
    try {
      const events = parseSession(p);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ agent: 'droid', role: 'user', content: 'hello droid' });
    } finally {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    }
  });
});
