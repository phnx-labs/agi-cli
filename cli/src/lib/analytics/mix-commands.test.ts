import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import Database from '../sqlite.js';
import { closeUsageDb, recordUsage } from './usage-db.js';
import { registerInsightsCommand } from '../../commands/insights.js';

const tmpDirs: string[] = [];
let prevNoTrack: string | undefined;
let prevUsageDb: string | undefined;
let prevSessionsDb: string | undefined;

function pin(): void {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mix-cmd-'));
  tmpDirs.push(d);
  const usage = path.join(d, 'usage.db');
  const sessions = path.join(d, 'sessions.db');
  process.env.AGENTS_USAGE_DB = usage;
  process.env.AGENTS_SESSIONS_DB = sessions;
  const db = new Database(sessions);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      short_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      model TEXT,
      token_count INTEGER,
      output_tokens INTEGER,
      duration_ms INTEGER,
      machine TEXT,
      tool_call_count INTEGER,
      file_path TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (id, short_id, agent, timestamp, model, token_count, output_tokens, duration_ms, machine, tool_call_count, file_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('s1', 's1', 'claude', now, 'claude-opus-4', 100, 10, 1000, 'box', 1, '/tmp/a.jsonl');
  db.close();
  recordUsage({ kind: 'secret', name: 'npm', event: 'access' });
}

beforeEach(() => {
  prevNoTrack = process.env.AGENTS_NO_USAGE_TRACK;
  prevUsageDb = process.env.AGENTS_USAGE_DB;
  prevSessionsDb = process.env.AGENTS_SESSIONS_DB;
  delete process.env.AGENTS_NO_USAGE_TRACK;
  closeUsageDb();
  pin();
});

afterEach(() => {
  closeUsageDb();
  if (prevNoTrack === undefined) delete process.env.AGENTS_NO_USAGE_TRACK;
  else process.env.AGENTS_NO_USAGE_TRACK = prevNoTrack;
  if (prevUsageDb === undefined) delete process.env.AGENTS_USAGE_DB;
  else process.env.AGENTS_USAGE_DB = prevUsageDb;
  if (prevSessionsDb === undefined) delete process.env.AGENTS_SESSIONS_DB;
  else process.env.AGENTS_SESSIONS_DB = prevSessionsDb;
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {  }
  }
  tmpDirs.length = 0;
});

async function capture(run: () => Promise<void>): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  try {
    await run();
  } finally {
    console.log = ol;
    console.error = oe;
  }
  return { out: out.join('\n'), err: err.join('\n') };
}

describe('insights mix registration', () => {
  it('agents insights mix prints the counter board without a deprecation line', async () => {
    const program = new Command();
    program.exitOverride();
    registerInsightsCommand(program);

    const { out, err } = await capture(async () => {
      await program.parseAsync(['node', 'agents', 'insights', 'mix', '--json']);
    });
    expect(err).not.toMatch(/deprecated/i);
    const parsed = JSON.parse(out);
    expect(parsed.window.days).toBe(7);
    expect(Array.isArray(parsed.sections)).toBe(true);
    expect(parsed.sections.length).toBeGreaterThan(0);
  });

  it('agents insights mix <recipe> runs a single recipe', async () => {
    const program = new Command();
    program.exitOverride();
    registerInsightsCommand(program);

    const { out, err } = await capture(async () => {
      await program.parseAsync(['node', 'agents', 'insights', 'mix', 'harness-mix', '--json']);
    });
    expect(err).not.toMatch(/deprecated/i);
    const parsed = JSON.parse(out);
    expect(parsed.section.id).toBe('harness-mix');
    expect(parsed.section.empty).toBe(false);
  });
});

describe('mix consolidates recipes/trends/shortcuts into one command', () => {
  it('agents insights mix --list names the baked recipe ids', async () => {
    const program = new Command();
    program.exitOverride();
    registerInsightsCommand(program);

    const { out } = await capture(async () => {
      await program.parseAsync(['node', 'agents', 'insights', 'mix', '--list', '--json']);
    });
    const parsed = JSON.parse(out) as Array<{ id: string }>;
    expect(parsed.map((r) => r.id)).toContain('harness-mix');
  });

  it('agents insights mix <unknown-recipe> fails loud', async () => {
    const program = new Command();
    program.exitOverride();
    registerInsightsCommand(program);

    const { err } = await capture(async () => {
      await program.parseAsync(['node', 'agents', 'insights', 'mix', 'not-a-recipe']);
    });
    expect(err).toMatch(/Unknown recipe 'not-a-recipe'/);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('the former standalone shortcut / trends / recipes spellings are gone', async () => {
    for (const gone of ['harness-mix', 'trends', 'recipes']) {
      const program = new Command();
      program.exitOverride();
      registerInsightsCommand(program);
      await expect(
        program.parseAsync(['node', 'agents', 'insights', gone]),
      ).rejects.toThrow();
    }
  });
});

describe('insights subcommands honor --json despite the parent-option collision', () => {
  for (const argv of [['mix'], ['mix', 'harness-mix'], ['mix', '--list'], ['query']]) {
    it(`agents insights ${argv.join(' ')} --json emits parseable JSON`, async () => {
      const program = new Command();
      program.exitOverride();
      registerInsightsCommand(program);
      const { out } = await capture(async () => {
        await program.parseAsync(['node', 'agents', 'insights', ...argv, '--json']);
      });
      expect(() => JSON.parse(out)).not.toThrow();
    });
  }
});
