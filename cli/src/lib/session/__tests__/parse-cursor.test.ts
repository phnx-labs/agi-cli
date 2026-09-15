import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { readCursorMeta } from '../discover.js';
import { detectAgent, parseCursor, parseSession } from '@phnx-labs/sessions-cli/reader';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'testdata', 'cursor-session.jsonl');
const SESSION_ID = '123e4567-e89b-12d3-a456-426614174000';

describe('Cursor session parsing and discovery metadata', () => {
  let root: string;
  let transcriptPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-cursor-'));
    transcriptPath = path.join(
      root, '.cursor', 'projects', 'tmp-public-project', 'agent-transcripts',
      SESSION_ID, `${SESSION_ID}.jsonl`,
    );
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.copyFileSync(FIXTURE, transcriptPath);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('maps text and tool-use blocks and ignores turn_ended', () => {
    const events = parseCursor(transcriptPath);
    expect(events).toHaveLength(8);
    expect(events[0]).toMatchObject({
      agent: 'cursor', type: 'message', role: 'user',
      content: 'Inspect the public CLI documentation and summarize the session commands.',
      timestamp: '2026-08-02T10:51:00.000Z',
    });
    expect(events[1]).toMatchObject({
      agent: 'cursor', type: 'message', role: 'assistant',
      content: 'I will inspect the session documentation.',
    });
    expect(events[2]).toMatchObject({
      agent: 'cursor', type: 'tool_use', tool: 'Read',
      path: '/tmp/public-project/docs/sessions.md',
    });
    expect(events[3]).toMatchObject({
      agent: 'cursor', type: 'message', role: 'assistant',
      content: 'The sessions command discovers and renders local transcripts.',
    });
    expect(events[4]).toMatchObject({
      agent: 'cursor', type: 'tool_use', tool: 'TodoWrite',
      args: { todos: [
        { content: 'Read the docs', status: 'completed' },
        { content: 'Summarize the commands', status: 'in_progress' },
      ] },
    });
    expect(events[5]).toMatchObject({
      agent: 'cursor', type: 'tool_use', tool: 'Task',
      args: { description: 'Audit session commands', subagent_type: 'general-purpose' },
    });
    expect(events[6]).toMatchObject({
      agent: 'cursor', type: 'tool_use', tool: 'Shell',
      command: 'ls docs/',
    });
    expect(events[7]).toMatchObject({
      agent: 'cursor', type: 'tool_use', tool: 'Write',
      path: '/tmp/public-project/NOTES.md',
    });
  });

  test('carries a tool call\'s `description` as its per-call label', () => {
    // The same signal the Claude arm reads, on the parser Cursor and Droid
    // share — without it the timeline's now-line falls back to raw command
    // text (review BLOCKER 3).
    const events = parseCursor(transcriptPath);
    expect(events[5].label).toBe('Audit session commands');
    // A call that wrote no description gets none, rather than an invented one.
    expect(events[6].label).toBeUndefined();
  });

  test('joins authoritative cwd, title, and timestamps from chats meta.json', () => {
    const unrelatedMetaPath = path.join(root, '.cursor', 'chats', 'another-workspace', 'other-session', 'meta.json');
    fs.mkdirSync(path.dirname(unrelatedMetaPath), { recursive: true });
    fs.writeFileSync(unrelatedMetaPath, JSON.stringify({ title: 'Different session' }));
    const metaPath = path.join(root, '.cursor', 'chats', 'workspace-hash', SESSION_ID, 'meta.json');
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify({
      schemaVersion: 1,
      createdAtMs: 1785654071336,
      hasConversation: true,
      title: 'Session command audit',
      updatedAtMs: 1785668144486,
      cwd: '/tmp/public-project',
    }));

    const result = readCursorMeta(transcriptPath, '2026.07.23-e383d2b');
    expect(result).not.toBeNull();
    expect(result!.meta).toMatchObject({
      id: SESSION_ID,
      shortId: '123e4567',
      agent: 'cursor',
      timestamp: '2026-08-02T07:01:11.336Z',
      lastActivity: '2026-08-02T10:55:44.486Z',
      cwd: '/tmp/public-project',
      project: 'public-project',
      label: 'Session command audit',
      topic: 'Inspect the public CLI documentation and summarize the session commands.',
      messageCount: 3,
    });
    expect(result!.meta.todos).toMatchObject({
      done: 1,
      total: 2,
      activeForm: 'Summarize the commands',
    });
    expect(result!.content).toBe('Inspect the public CLI documentation and summarize the session commands.');
    expect(result!.events).toEqual(parseCursor(transcriptPath));
  });

  test('collapses a scaffolded chatMeta.title to the skill, matching Claude ai-title', () => {
    // Cursor writes its own auto-title into chats/.../meta.json independently of
    // the Claude JSONL ai-title path. The same skill-preamble echo that PR #2995
    // cleaned for Claude must collapse here too — label wins on every surface.
    const metaPath = path.join(root, '.cursor', 'chats', 'workspace-hash', SESSION_ID, 'meta.json');
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify({
      schemaVersion: 1,
      createdAtMs: 1785654071336,
      hasConversation: true,
      title: 'Base directory for this skill: /home/u/.agents/.history/versions/claude/2.1.207/home/.claude/skills/continue',
      updatedAtMs: 1785668144486,
      cwd: '/tmp/public-project',
    }));

    const result = readCursorMeta(transcriptPath);
    expect(result).not.toBeNull();
    expect(result!.meta.label).toBe('/continue');
  });

  test('leaves a Cursor title that merely names a skills/ path unchanged', () => {
    const metaPath = path.join(root, '.cursor', 'chats', 'workspace-hash', SESSION_ID, 'meta.json');
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify({
      title: 'rewrite the skills/continue docs',
      cwd: '/tmp/public-project',
    }));

    const result = readCursorMeta(transcriptPath);
    expect(result).not.toBeNull();
    expect(result!.meta.label).toBe('rewrite the skills/continue docs');
  });

  test('indexes transcript-only archives without inventing cwd or title', () => {
    const result = readCursorMeta(transcriptPath);
    expect(result).not.toBeNull();
    expect(result!.meta.cwd).toBe('');
    expect(result!.meta.project).toBeUndefined();
    expect(result!.meta.label).toBeUndefined();
    expect(result!.meta.messageCount).toBe(3);
  });

  test('detectAgent and parseSession route Cursor transcript paths', () => {
    expect(detectAgent(transcriptPath)).toBe('cursor');
    expect(parseSession(transcriptPath)).toEqual(parseCursor(transcriptPath));
  });

  test('skips malformed JSONL lines without dropping valid events', () => {
    fs.appendFileSync(transcriptPath, '{not json}\n');
    expect(parseCursor(transcriptPath)).toHaveLength(8);
  });
});
