import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from '../../sqlite.js';
import { buildFtsQuery, getDB } from '../db.js';
import { scanClaudeSession, parseCodexThreadNameIndex, shouldDeferRecentAppend, machineForSessionFile, discoverSessions, resolveSessionById, isCompleteSessionId, looksLikeSessionId, readGrokMeta } from '../discover.js';
import { machineId } from '../sync/config.js';
import { getHistoryDir } from '../../state.js';

describe('machineForSessionFile', () => {
  it('reads the origin machine from the cross-machine mirror path', () => {
    const p = path.join(getHistoryDir(), 'backups', 'claude', 'zion', 'projects', 'foo', 'sess.jsonl');
    expect(machineForSessionFile(p, 'claude')).toBe('zion');
  });

  it('keys the mirror machine off the correct agent segment', () => {
    const p = path.join(getHistoryDir(), 'backups', 'codex', 'yosemite-s1', 'sessions', 'x.jsonl');
    expect(machineForSessionFile(p, 'codex')).toBe('yosemite-s1');
  });

  it('falls back to the local machine for live-home (non-mirror) files', () => {
    const p = path.join(os.homedir(), '.claude', 'projects', 'foo', 'sess.jsonl');
    expect(machineForSessionFile(p, 'claude')).toBe(machineId());
  });
});

describe('routine archive discovery', () => {
  const jobName = '__test_routine_sessions__';
  const runId = '2026-07-21T10-30-00-000Z';
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const runDir = path.join(getHistoryDir(), 'runs', jobName, runId);

  afterEach(() => {
    fs.rmSync(path.join(getHistoryDir(), 'runs', jobName), { recursive: true, force: true });
    const db = getDB();
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
    db.prepare(`DELETE FROM session_text WHERE session_id = ?`).run(sessionId);
    db.prepare(`DELETE FROM scan_ledger WHERE file_path LIKE ?`).run(`${runDir}%`);
  });

  it('indexes archived routine transcripts and resolves them by routine run id', async () => {
    const transcriptDir = path.join(runDir, 'sessions', 'claude', 'projects', 'routine-project');
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(
      path.join(transcriptDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-07-21T10:30:00.000Z',
          cwd: '/tmp/routine-project',
          sessionId,
          message: { role: 'user', content: 'summarize routine result' },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-07-21T10:31:00.000Z',
          cwd: '/tmp/routine-project',
          sessionId,
          message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const sessions = await discoverSessions({
      agent: 'claude',
      origin: 'routine',
      all: true,
      limit: 100,
    });
    const hit = sessions.find((s) => s.id === sessionId);

    expect(hit).toBeDefined();
    expect(hit!.origin).toBe('routine');
    expect(hit!.routineName).toBe(jobName);
    expect(hit!.routineRunId).toBe(runId);
    expect(hit!.project).toBe(jobName);
    expect(hit!.label).toBe(jobName);
    expect(resolveSessionById(sessions, runId).map((s) => s.id)).toContain(sessionId);
  });
});

describe('buildFtsQuery', () => {
  it('returns empty expression for whitespace-only input', () => {
    expect(buildFtsQuery('').expr).toBe('');
    expect(buildFtsQuery('   ').expr).toBe('');
  });

  it('splits on non-alphanumerics, drops 1-char tokens, prefix-matches', () => {
    const { expr, terms } = buildFtsQuery('rush deploy-a2a a b 42');
    expect(terms).toEqual(['rush', 'deploy', 'a2a', '42']);
    expect(expr).toBe('rush* OR deploy* OR a2a* OR 42*');
  });

  it('lowercases tokens', () => {
    const { terms } = buildFtsQuery('RUSH Deploy');
    expect(terms).toEqual(['rush', 'deploy']);
  });
});

describe('FTS5 session_text schema (smoke test)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-fts-'));
    db = new Database(path.join(tmpDir, 'sessions.db'));
    db.exec(`
      CREATE VIRTUAL TABLE session_text USING fts5(
        session_id UNINDEXED,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ranks rare terms higher than common ones (IDF)', () => {
    const insert = db.prepare('INSERT INTO session_text (session_id, content) VALUES (?, ?)');
    insert.run('a', 'session bug bug');
    insert.run('b', 'session notes');
    insert.run('c', 'session thoughts');
    insert.run('d', 'session plan');

    const rows = db.prepare(`
      SELECT session_id, bm25(session_text) AS r
      FROM session_text WHERE session_text MATCH ? ORDER BY r ASC
    `).all('bug') as { session_id: string; r: number }[];

    expect(rows[0].session_id).toBe('a');
  });

  it('supports prefix queries for partial typing', () => {
    const insert = db.prepare('INSERT INTO session_text (session_id, content) VALUES (?, ?)');
    insert.run('x', 'rush deploy yaml agent');
    insert.run('y', 'unrelated content');

    const rows = db.prepare(`
      SELECT session_id FROM session_text WHERE session_text MATCH ? ORDER BY bm25(session_text) ASC
    `).all('rush* OR dep*') as { session_id: string }[];

    expect(rows.map(r => r.session_id)).toContain('x');
    expect(rows.map(r => r.session_id)).not.toContain('y');
  });
});

// ---------------------------------------------------------------------------
// Claude session titles: `/rename` (custom-title) > Claude auto (ai-title).
// The first prompt remains the topic; both title events can repeat and last wins.
// ---------------------------------------------------------------------------

describe('scanClaudeSession title resolution', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-claude-title-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(lines: object[]): string {
    const fp = path.join(dir, 'session.jsonl');
    fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return fp;
  }

  const userMsg = (text: string) => ({
    type: 'user',
    timestamp: '2026-06-28T00:00:00.000Z',
    cwd: '/x',
    message: { role: 'user', content: text },
  });

  it('prefers a user custom-title over the auto ai-title and first prompt', async () => {
    const fp = write([
      userMsg('fix the auth refresh bug please'),
      { type: 'ai-title', aiTitle: 'Auth refresh fix', sessionId: 's' },
      { type: 'custom-title', customTitle: 'close-li-outreach-gap', sessionId: 's' },
    ]);
    const scan = await scanClaudeSession(fp);
    expect(scan.topic).toBe('fix the auth refresh bug please');
    expect(scan.label).toBe('close-li-outreach-gap');
  });

  it('falls back to ai-title when there is no custom-title', async () => {
    const fp = write([
      userMsg('do the thing'),
      { type: 'ai-title', aiTitle: 'Release new version of agents-cli', sessionId: 's' },
    ]);
    const scan = await scanClaudeSession(fp);
    expect(scan.topic).toBe('do the thing');
    expect(scan.label).toBe('Release new version of agents-cli');
  });

  it('falls back to the first-prompt topic when no title events exist', async () => {
    const fp = write([userMsg('investigate the flaky test')]);
    const scan = await scanClaudeSession(fp);
    expect(scan.topic).toBe('investigate the flaky test');
    expect(scan.label).toBeUndefined();
  });

  it('takes the last custom-title when renamed more than once', async () => {
    const fp = write([
      userMsg('start'),
      { type: 'custom-title', customTitle: 'first name', sessionId: 's' },
      { type: 'custom-title', customTitle: 'second name', sessionId: 's' },
    ]);
    const scan = await scanClaudeSession(fp);
    expect(scan.topic).toBe('start');
    expect(scan.label).toBe('second name');
  });

  it('ignores whitespace-only title values', async () => {
    const fp = write([
      userMsg('real prompt here'),
      { type: 'ai-title', aiTitle: '   ', sessionId: 's' },
    ]);
    const scan = await scanClaudeSession(fp);
    expect(scan.topic).toBe('real prompt here');
    expect(scan.label).toBeUndefined();
  });

  it('sets lastActivity to the last event time, distinct from the creation timestamp', async () => {
    const fp = write([
      { type: 'user', timestamp: '2026-06-28T00:00:00.000Z', cwd: '/x', message: { role: 'user', content: 'start' } },
      { type: 'assistant', timestamp: '2026-06-28T02:30:00.000Z', cwd: '/x', message: { role: 'assistant', content: 'done' } },
    ]);
    const scan = await scanClaudeSession(fp);
    expect(scan.timestamp).toBe('2026-06-28T00:00:00.000Z'); // first event = creation
    expect(scan.lastActivity).toBe('2026-06-28T02:30:00.000Z'); // last event = activity
  });
});

// ---------------------------------------------------------------------------
// Codex titles live in session_index.jsonl (thread_name), updated out of band.
// ---------------------------------------------------------------------------

describe('parseCodexThreadNameIndex', () => {
  it('maps id -> thread_name, trims, and skips malformed/empty/id-less lines', () => {
    const raw = [
      JSON.stringify({ id: 'a', thread_name: 'Review skill placement', updated_at: 'x' }),
      '',
      'not json at all',
      JSON.stringify({ id: 'b', thread_name: '   ' }),
      JSON.stringify({ id: '', thread_name: 'no id' }),
      JSON.stringify({ id: 'c', thread_name: '  Find top resource hogs  ' }),
    ].join('\n');

    const map = parseCodexThreadNameIndex(raw);
    expect(map.get('a')).toBe('Review skill placement');
    expect(map.has('b')).toBe(false);
    expect(map.has('')).toBe(false);
    expect(map.get('c')).toBe('Find top resource hogs');
    expect(map.size).toBe(2);
  });

  it('returns an empty map for empty input', () => {
    expect(parseCodexThreadNameIndex('').size).toBe(0);
  });
});

describe('shouldDeferRecentAppend', () => {
  const now = 1_000_000;
  const prev = {
    fileMtimeMs: now - 2_000,
    fileSize: 1_000,
    scannedAt: now - 1_000,
  };

  it('defers append-only growth scanned inside the debounce window', () => {
    expect(shouldDeferRecentAppend(prev, {
      fileMtimeMs: now - 500,
      fileSize: 1_500,
    }, now, 5_000)).toBe(true);
  });

  it('rescans append-only growth after the debounce window expires', () => {
    expect(shouldDeferRecentAppend({ ...prev, scannedAt: now - 6_000 }, {
      fileMtimeMs: now - 500,
      fileSize: 1_500,
    }, now, 5_000)).toBe(false);
  });

  it('does not defer truncates or same-size rewrites', () => {
    expect(shouldDeferRecentAppend(prev, {
      fileMtimeMs: now - 500,
      fileSize: 900,
    }, now, 5_000)).toBe(false);

    expect(shouldDeferRecentAppend(prev, {
      fileMtimeMs: now - 500,
      fileSize: 1_000,
    }, now, 5_000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Grok stores one directory per session with a structured summary.json. The
// scanner reads that (not the JSONL event streams) for metadata. Fixture shape
// mirrors a real ~/.grok/sessions/<enc-cwd>/<uuid>/summary.json.
// ---------------------------------------------------------------------------

describe('readGrokMeta', () => {
  let dir: string;
  const uuid = '019f86cf-9d1d-7621-b80a-1e6d801904ce';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-grok-'));
    fs.mkdirSync(path.join(dir, uuid), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeSummary(summary: object): string {
    const fp = path.join(dir, uuid, 'summary.json');
    fs.writeFileSync(fp, JSON.stringify(summary));
    return fp;
  }

  it('maps id, cwd, title, timestamps, message count and version from summary.json', () => {
    const fp = writeSummary({
      info: { id: uuid, cwd: '/Users/muqsit/src/github.com/muqsitnawaz' },
      session_summary: 'a summary',
      generated_title: 'Minecraft Installation and Play',
      created_at: '2026-07-21T22:33:01.057529Z',
      updated_at: '2026-07-21T22:44:05.605009Z',
      last_active_at: '2026-07-21T22:44:05.605009Z',
      num_messages: 152,
      num_chat_messages: 51,
      grok_home: '/Users/muqsit/.agents/.history/versions/grok/0.2.101/home/.grok',
    });
    const r = readGrokMeta(fp);
    expect(r).not.toBeNull();
    expect(r!.meta.id).toBe(uuid);
    expect(r!.meta.agent).toBe('grok');
    expect(r!.meta.topic).toBe('Minecraft Installation and Play'); // generated_title wins over session_summary
    expect(r!.meta.cwd).toBe('/Users/muqsit/src/github.com/muqsitnawaz');
    expect(r!.meta.project).toBe('muqsitnawaz');
    expect(r!.meta.timestamp).toBe('2026-07-21T22:33:01.057529Z'); // created_at = start
    expect(r!.meta.lastActivity).toBe('2026-07-21T22:44:05.605009Z'); // last_active_at
    expect(r!.meta.messageCount).toBe(51); // num_chat_messages preferred over num_messages
    expect(r!.meta.version).toBe('0.2.101'); // parsed from grok_home path
    expect(r!.meta.shortId).toBe(uuid.slice(0, 8));
  });

  it('resolves the version from a Windows (backslash) grok_home path (RUSH-2286)', () => {
    // The Grok CLI writes grok_home in the writing host's native separators; a
    // Windows-authored summary is backslash-separated. The summary lives in a
    // tmp dir (no versions/grok path on disk), so grok_home is the ONLY version
    // source — before the fix the `/`-only regex left version undefined here.
    const fp = writeSummary({
      info: { id: uuid, cwd: 'C:\\Users\\muqsit\\src' },
      generated_title: 'Windows session',
      grok_home: 'C:\\Users\\muqsit\\.agents\\.history\\versions\\grok\\0.2.101\\home\\.grok',
    });
    const r = readGrokMeta(fp);
    expect(r).not.toBeNull();
    expect(r!.meta.version).toBe('0.2.101');
  });

  it('falls back to session_summary when no generated_title, and to the dir uuid when info.id is absent', () => {
    const fp = writeSummary({
      info: { cwd: '/tmp/x' },
      session_summary: 'fallback topic',
      created_at: '2026-07-21T00:00:00.000Z',
    });
    const r = readGrokMeta(fp);
    expect(r!.meta.id).toBe(uuid); // recovered from the directory name
    expect(r!.meta.topic).toBe('fallback topic');
  });

  it('coerces a missing timestamp to the file mtime (NOT NULL column safety)', () => {
    const fp = writeSummary({ info: { id: uuid, cwd: '/tmp/x' } });
    const r = readGrokMeta(fp);
    expect(r!.meta.timestamp).toBeTruthy();
    expect(() => new Date(r!.meta.timestamp).toISOString()).not.toThrow();
  });

  it('returns null for malformed json', () => {
    const fp = path.join(dir, uuid, 'summary.json');
    fs.writeFileSync(fp, '{ not valid json');
    expect(readGrokMeta(fp)).toBeNull();
  });
});

describe('isCompleteSessionId', () => {
  it('accepts a bare 36-char UUID, in either case', () => {
    expect(isCompleteSessionId('d3470b57-2af6-4c11-b1de-3fab94f43603')).toBe(true);
    expect(isCompleteSessionId('D3470B57-2AF6-4C11-B1DE-3FAB94F43603')).toBe(true);
  });

  it('accepts a v7 UUID (the shape newer harnesses mint)', () => {
    expect(isCompleteSessionId('019fbd2f-971a-7fb0-a213-3709a27cd12b')).toBe(true);
  });

  // The prefixed shapes are the ones the index actually holds — verified against
  // a live 12,507-row index: session_+UUID (kimi, rush) and ses_+26-char ULID
  // (opencode). `ses_` is NOT a UUID, so it needs its own shape, and `api-`
  // appears zero times and is deliberately not claimed.
  it('accepts session_ + UUID, the shape kimi and rush mint', () => {
    expect(isCompleteSessionId('session_933f4131-f3ed-495d-946b-71825e9f6a25')).toBe(true);
  });

  it('accepts ses_ + 26-char ULID, the shape opencode actually mints', () => {
    expect(isCompleteSessionId('ses_0485d75c1ffewpzVfoI0ni6hW1')).toBe(true);
    expect(isCompleteSessionId('ses_0e508fa24ffeZe0092umrYovhg')).toBe(true);
  });

  it('rejects ses_ + UUID — a shape no harness mints', () => {
    expect(isCompleteSessionId('ses_933f4131-f3ed-495d-946b-71825e9f6a25')).toBe(false);
  });

  it('rejects a truncated ULID, so a ses_ prefix stays searchable', () => {
    expect(isCompleteSessionId('ses_0485d75c')).toBe(false);
  });

  it('accepts a padded id, matching the resolver that trims before lookup', () => {
    expect(isCompleteSessionId('  d3470b57-2af6-4c11-b1de-3fab94f43603 ')).toBe(true);
  });

  it('rejects a short id, a truncated id, and a search phrase', () => {
    expect(isCompleteSessionId('d3470b57')).toBe(false);
    expect(isCompleteSessionId('d3470b57-2af6-4c11-b1de')).toBe(false);
    expect(isCompleteSessionId('add auth middleware')).toBe(false);
    expect(isCompleteSessionId('')).toBe(false);
  });

  it('rejects a UUID with trailing text, so a phrase quoting an id stays a search', () => {
    expect(isCompleteSessionId('resume d3470b57-2af6-4c11-b1de-3fab94f43603')).toBe(false);
    expect(isCompleteSessionId('d3470b57-2af6-4c11-b1de-3fab94f43603.jsonl')).toBe(false);
  });
});

describe('looksLikeSessionId', () => {
  it('accepts a bare hex short-id/prefix that isCompleteSessionId rejects', () => {
    // The whole point of the wider test: a short id must route to id-only
    // resolution, not content search.
    expect(looksLikeSessionId('d3470b57')).toBe(true);
    expect(looksLikeSessionId('d3470b57-2af6')).toBe(true);
    expect(isCompleteSessionId('d3470b57')).toBe(false);
  });

  it('accepts every complete id shape (delegates to isCompleteSessionId)', () => {
    expect(looksLikeSessionId('d3470b57-2af6-4c11-b1de-3fab94f43603')).toBe(true);
    expect(looksLikeSessionId('session_933f4131-f3ed-495d-946b-71825e9f6a25')).toBe(true);
    expect(looksLikeSessionId('ses_0485d75c1ffewpzVfoI0ni6hW1')).toBe(true);
  });

  it('trims surrounding whitespace before testing', () => {
    expect(looksLikeSessionId('  d3470b57  ')).toBe(true);
  });

  it('rejects a search phrase and a too-short fragment', () => {
    expect(looksLikeSessionId('add auth middleware')).toBe(false);
    expect(looksLikeSessionId('d347')).toBe(false); // < 6 hex chars
    expect(looksLikeSessionId('')).toBe(false);
  });
});
