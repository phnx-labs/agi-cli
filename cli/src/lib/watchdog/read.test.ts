import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTailLines, findSessionJsonlIn, readWatchdogTail } from './read.js';
import { summarizeWatchdogTail } from './watchdogTail.js';

const FIXTURE = path.join(import.meta.dirname, 'testdata', 'tail-sample-claude.jsonl');

describe('readTailLines', () => {
  it('returns the last N non-empty JSONL lines of a real transcript', () => {
    const lines = readTailLines(FIXTURE, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('I will write the module and run the tests next.');
    expect(lines[0]).toContain('tool_result');
  });

  it('returns every line when maxLines exceeds the file length', () => {
    const lines = readTailLines(FIXTURE, 100);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('port the watchdog into agents-cli');
  });

  it('returns [] for a missing file', () => {
    expect(readTailLines('/no/such/transcript.jsonl', 20)).toEqual([]);
  });

  describe('with generated temp files', () => {
    let dir: string;
    let empty: string;
    let big: string;
    const BIG_LINES = 5000;

    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-read-'));
      empty = path.join(dir, 'empty.jsonl');
      fs.writeFileSync(empty, '');
      big = path.join(dir, 'big.jsonl');
      const rows: string[] = [];
      for (let i = 0; i < BIG_LINES; i++) {
        rows.push(JSON.stringify({ type: 'assistant', seq: i, message: { content: [{ type: 'text', text: `row ${i} ${'x'.repeat(40)}` }] } }));
      }
      fs.writeFileSync(big, rows.join('\n') + '\n');
    });

    afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('returns [] for an empty file', () => {
      expect(readTailLines(empty, 20)).toEqual([]);
    });

    it('reads the true tail across chunk boundaries, not a mid-chunk slice', () => {
      const lines = readTailLines(big, 20);
      expect(lines).toHaveLength(20);
      const last = JSON.parse(lines[lines.length - 1]);
      expect(last.seq).toBe(BIG_LINES - 1);
      const first = JSON.parse(lines[0]);
      expect(first.seq).toBe(BIG_LINES - 20);
    });
  });
});

describe('findSessionJsonlIn', () => {
  let root: string;
  const sessionId = 'a1b2c3d4-1111-2222-3333-444455556666';

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-resolve-'));
    const proj = path.join(root, 'projects', '-home-user-repo');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, `${sessionId}.jsonl`), '{}\n');
    fs.writeFileSync(path.join(proj, 'other-session.jsonl'), '{}\n');
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('locates a Claude-style <enc>/<sessionId>.jsonl under the projects root', () => {
    const dirs = [path.join(root, 'projects')];
    const found = findSessionJsonlIn(dirs, sessionId);
    expect(found).toBeDefined();
    expect(path.basename(found!)).toBe(`${sessionId}.jsonl`);
  });

  it('matches a Codex-style filename that merely embeds the uuid', () => {
    const cdir = path.join(root, 'sessions');
    fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, `rollout-2026-07-01T10-00-00-${sessionId}.jsonl`), '{}\n');
    const found = findSessionJsonlIn([cdir], sessionId);
    expect(found).toBeDefined();
    expect(found!).toContain(sessionId);
  });

  it('finds a Codex rollout in a DEEP date partition (sessions/YYYY/MM/DD/)', () => {
    const deepSid = 'deadbeef-1111-2222-3333-444455556666';
    const sessionsRoot = path.join(root, 'sessions-deep');
    const partition = path.join(sessionsRoot, '2026', '05', '27');
    fs.mkdirSync(partition, { recursive: true });
    const rollout = path.join(partition, `rollout-2026-05-27T09-30-00-${deepSid}.jsonl`);
    fs.writeFileSync(rollout, '{}\n');
    const found = findSessionJsonlIn([sessionsRoot], deepSid);
    expect(found).toBe(rollout);
  });

  it('returns undefined when the session is absent', () => {
    expect(findSessionJsonlIn([path.join(root, 'projects')], 'ffffffff-0000-0000-0000-000000000000')).toBeUndefined();
  });

  it('returns undefined for an empty session id', () => {
    expect(findSessionJsonlIn([path.join(root, 'projects')], '')).toBeUndefined();
  });
});

describe('watchdog tail pipeline (read -> summarize)', () => {
  it('feeds real transcript lines into the pure summarizer the agent reads', () => {
    const tail = readTailLines(FIXTURE, 20);
    const summary = summarizeWatchdogTail(tail, 'claude');
    expect(summary.lastUserMessage).toBe('port the watchdog into agents-cli');
    expect(summary.lastAssistantMessage).toContain('I will write the module');
  });

  it('readWatchdogTail returns [] when the session cannot be resolved', () => {
    expect(readWatchdogTail('nonexistent-session-id', 'claude')).toEqual([]);
  });
});
