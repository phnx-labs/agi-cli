import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import Database from '../lib/sqlite.js';
import type { SessionAgentId, SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { MARKDOWN_RENDER_AGENTS, renderSessionMarkdownDocument } from './sessions-render.js';

const TESTDATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/session/testdata/render');

const FIXTURES = {
  claude: path.join(TESTDATA, 'claude.jsonl'),
  codex: path.join(TESTDATA, 'codex.jsonl'),
  kimi: path.join(TESTDATA, 'kimi', 'state.json'),
  grok: path.join(TESTDATA, 'grok', 'summary.json'),
  cursor: path.join(TESTDATA, 'cursor.jsonl'),
  droid: path.join(TESTDATA, 'droid.jsonl'),
};

function meta(agent: SessionAgentId, filePath: string): SessionMeta {
  return {
    id: `render-${agent}`,
    shortId: `render-${agent}`,
    agent,
    timestamp: '2026-08-03T10:00:00.000Z',
    lastActivity: '2026-08-03T10:00:04.000Z',
    cwd: '/Users/alice/private',
    project: 'private-project',
    topic: `Deploy the ${agent} session`,
    filePath,
    messageCount: 2,
    tokenCount: 42,
    prUrl: 'https://github.com/phnx-labs/agents-cli/pull/123',
    prNumber: 123,
  };
}

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return bytes;
}

function encodeStringField(field: number, value: string): number[] {
  const bytes = Array.from(Buffer.from(value));
  return [...encodeVarint((field << 3) | 2), ...encodeVarint(bytes.length), ...bytes];
}

function antigravityFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-render-antigravity-'));
  const dbPath = path.join(dir, 'fixture.db');
  const payload = Buffer.from([
    ...encodeStringField(1, 'call-1'),
    ...encodeStringField(2, 'run_command'),
    ...encodeStringField(3, JSON.stringify({
      CommandLine: 'printf antigravity-rendered',
      toolAction: 'Render fixture',
      toolSummary: 'Rendered Antigravity fixture',
    })),
  ]);
  const db = new Database(dbPath);
  db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL, step_payload blob);');
  db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)').run(0, 15, payload);
  db.close();
  return dbPath;
}

function opencodeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-render-opencode-'));
  const dbPath = path.join(dir, 'opencode.db');
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE message (
    id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
    time_updated integer NOT NULL, data text NOT NULL
  );
  CREATE TABLE part (
    id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
  );`);
  const insertMessage = db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
  );
  const insertPart = db.prepare(
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insertMessage.run('user', 'session-render', 1, 1, JSON.stringify({ role: 'user' }));
  insertMessage.run('assistant', 'session-render', 2, 2, JSON.stringify({ role: 'assistant' }));
  insertPart.run('user-text', 'user', 'session-render', 1, 1, JSON.stringify({ type: 'text', text: 'Render OpenCode' }));
  insertPart.run('assistant-text', 'assistant', 'session-render', 2, 2, JSON.stringify({ type: 'text', text: 'OpenCode rendered' }));
  insertPart.run('tool', 'assistant', 'session-render', 3, 3, JSON.stringify({
    type: 'tool',
    tool: 'shell',
    state: { input: { command: 'printf opencode-rendered' }, output: 'opencode-rendered', status: 'completed' },
  }));
  db.close();
  return `${dbPath}#session-render`;
}

describe('sessions render harness parity', () => {
  it('pins the complete supported-harness set', () => {
    expect(MARKDOWN_RENDER_AGENTS).toEqual([
      'claude',
      'codex',
      'antigravity',
      'opencode',
      'grok',
      'rush',
      'hermes',
      'kimi',
      'droid',
      'cursor',
    ]);
  });

  for (const agent of Object.keys(FIXTURES) as Array<keyof typeof FIXTURES>) {
    it(`renders ${agent} through the shared parser and redactor`, () => {
      const markdown = renderSessionMarkdownDocument(meta(agent, FIXTURES[agent]));
      expect(markdown).toContain('## Session preview');
      expect(markdown).toMatch(/^# Deploy /);
      expect(markdown).toContain('## Conversation');
      expect(markdown).toContain('## User');
      expect(markdown).toContain('## Assistant');
      expect(markdown).toContain('### Tool:');
      expect(markdown).toContain('```bash');
      expect(markdown).toContain('TOKEN=[REDACTED]');
      expect(markdown).not.toContain('fixture-secret');
      expect(markdown).not.toContain('/Users/alice');
      expect(markdown).toContain('[HOME]/private');
    });
  }

  it('fails loudly for openclaw because it has no parseable transcript data', () => {
    expect(() => renderSessionMarkdownDocument(meta('openclaw', path.join(TESTDATA, 'claude.jsonl'))))
      .toThrow(/Cannot render openclaw session/);
  });

  it.each([
    ['antigravity', antigravityFixture, 'antigravity-rendered'],
    ['opencode', opencodeFixture, 'opencode-rendered'],
  ] as const)('renders a real %s parser fixture', (agent, createFixture, proof) => {
    const fixture = createFixture();
    try {
      expect(renderSessionMarkdownDocument(meta(agent, fixture))).toContain(proof);
    } finally {
      fs.rmSync(path.dirname(fixture.split('#')[0]), { recursive: true, force: true });
    }
  });

  it('omits harness-injected user scaffolding from the shareable document', () => {
    const markdown = renderSessionMarkdownDocument(meta('codex', FIXTURES.codex));
    expect(markdown).not.toContain('internal scaffold');
  });

  it('lets the renderer truncate full normalized output with an exact note', () => {
    const markdown = renderSessionMarkdownDocument(meta('codex', FIXTURES.codex), {
      maxToolOutputChars: 20,
    });
    expect(markdown).toContain('[Output truncated: 580 characters omitted.]');
  });
});
