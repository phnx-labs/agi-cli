import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Set HOME before db.js loads so its module-level base dir picks up the
// override. Plain top-level statements run before the dynamic `await import`
// below, so vi.hoisted is not needed (and is also not supported by Bun's
// native test runner).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-db-test-'));
process.env.HOME = TEST_HOME;

const {
  getDB,
  getDBPath,
  querySessions,
  findSessionsById,
  closeDB,
  upsertSession,
  upsertSessionsBatch,
  queryUsageRollup,
  topSessionsByCost,
  syncTopics,
  ftsSearch,
  SCHEMA_VERSION,
} = await import('../db.js');
const { costOfUsage } = await import('../../pricing/index.js');
const { emit } = await import('../../feed/events.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

// JSONL files live under TEST_HOME so they're isolated and torn down with it.
// querySessions filters out rows whose file_path no longer exists on disk
// (defense against phantom rows after a config-symlink swap, see #136), so
// every seeded row needs a real backing file.
const SEED_FILES_DIR = path.join(TEST_HOME, 'seed-files');
fs.mkdirSync(SEED_FILES_DIR, { recursive: true });

function seed(id: string, version: string | null, timestamp: string): void {
  const filePath = path.join(SEED_FILES_DIR, `${id}.jsonl`);
  fs.writeFileSync(filePath, '');
  const db = getDB();
  db.prepare(`
    INSERT INTO sessions (
      id, short_id, agent, version, timestamp, project, cwd,
      file_path, file_mtime_ms, file_size, scanned_at, is_team_origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    id,
    id.slice(0, 8),
    'claude',
    version,
    timestamp,
    'agents-cli',
    SEED_FILES_DIR,
    filePath,
    0,
    0,
    0,
  );
}

describe('querySessions version filter', () => {
  beforeAll(() => {
    seed('s1-older', '2.1.111', '2026-04-19T10:00:00.000Z');
    seed('s2-newer', '2.1.112', '2026-04-19T11:00:00.000Z');
    seed('s3-same',  '2.1.112', '2026-04-19T12:00:00.000Z');
    seed('s4-null',  null,      '2026-04-19T13:00:00.000Z');
  });

  it('returns only sessions matching the requested version', () => {
    const rows = querySessions({ version: '2.1.112' });
    expect(rows.map(r => r.id).sort()).toEqual(['s2-newer', 's3-same']);
  });

  it('stores the sessions database under ~/.agents/.history/sessions', () => {
    expect(getDBPath()).toBe(path.join(TEST_HOME, '.agents', '.history', 'sessions', 'sessions.db'));
  });

  it('returns no sessions for an unknown version', () => {
    const rows = querySessions({ version: '99.99.99' });
    expect(rows).toEqual([]);
  });

  it('returns all sessions when version is omitted', () => {
    const rows = querySessions({});
    expect(rows.map(r => r.id).sort()).toEqual(['s1-older', 's2-newer', 's3-same', 's4-null']);
  });

  it('filters by version even when agent is also set', () => {
    const rows = querySessions({ agent: 'claude', version: '2.1.111' });
    expect(rows.map(r => r.id)).toEqual(['s1-older']);
  });
});

describe('cached checklist metadata', () => {
  it('persists todos and recent directories on transcript upsert', () => {
    const filePath = path.join(SEED_FILES_DIR, 'task-cache.jsonl');
    const rows = [
      { type: 'assistant', timestamp: '2026-08-01T00:00:00Z', message: { content: [
        { type: 'tool_use', id: '1', name: 'TaskCreate', input: { subject: 'Inspect', activeForm: 'Inspecting' } },
        { type: 'tool_use', id: '2', name: 'TaskCreate', input: { subject: 'Build', activeForm: 'Building' } },
        { type: 'tool_use', id: '3', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
        { type: 'tool_use', id: '4', name: 'TaskUpdate', input: { taskId: '2', status: 'in_progress' } },
        { type: 'tool_use', id: '5', name: 'Edit', input: { file_path: '/repo/src/config.ts' } },
      ] } },
    ];
    fs.writeFileSync(filePath, rows.map(row => JSON.stringify(row)).join('\n'));
    const meta: SessionMeta = {
      id: 'task-cache', shortId: 'task-cac', agent: 'claude', timestamp: '2026-08-01T00:00:00Z',
      filePath, cwd: '/repo',
    };
    upsertSession(meta, '', { fileMtimeMs: 1, fileSize: fs.statSync(filePath).size });
    expect(findSessionsById('task-cache')[0]).toMatchObject({
      todos: { done: 1, total: 2, activeForm: 'Building' },
      recentDirectoriesTouched: ['/repo/src'],
    });
  });
});

describe('firstUserMessage — the genuine full first user turn on the durable index (PHNX-3621)', () => {
  function emptyFile(id: string): string {
    const filePath = path.join(SEED_FILES_DIR, `fum-${id}.jsonl`);
    fs.writeFileSync(filePath, '');
    return filePath;
  }

  it('persists and reads back the full first user turn via upsertSession', () => {
    const filePath = emptyFile('roundtrip');
    const full = 'Implement PHNX-3621: add the canonical firstUserMessage stream field.\n\nMulti-line, verbatim.';
    const meta: SessionMeta = {
      id: 'fum-roundtrip', shortId: 'fum-roun', agent: 'claude', timestamp: '2026-08-31T00:00:00Z',
      filePath, topic: 'Implement PHNX-3621', firstUserMessage: full,
    };
    upsertSession(meta, '', { fileMtimeMs: 1, fileSize: fs.statSync(filePath).size });
    const row = findSessionsById('fum-roundtrip')[0];
    expect(row.firstUserMessage).toBe(full);
    expect(row.topic).toBe('Implement PHNX-3621');
  });

  it('rides through upsertSessionsBatch and querySessions', () => {
    const filePath = emptyFile('batch');
    const meta: SessionMeta = {
      id: 'fum-batch', shortId: 'fum-batc', agent: 'codex', timestamp: '2026-08-31T00:00:00Z',
      filePath, firstUserMessage: 'first turn from a batch upsert',
    };
    upsertSessionsBatch([{ meta, content: '' }]);
    const row = querySessions({}).find(s => s.id === 'fum-batch');
    expect(row?.firstUserMessage).toBe('first turn from a batch upsert');
  });

  it('derives firstUserMessage from events in the batch enrichment for a non-claude/codex harness', () => {
    const filePath = emptyFile('enrich');
    const meta: SessionMeta = {
      id: 'fum-enrich', shortId: 'fum-enri', agent: 'gemini', timestamp: '2026-08-31T00:00:00Z',
      filePath,
    };
    upsertSessionsBatch([{
      meta,
      content: '',
      events: [
        { type: 'message', agent: 'gemini', timestamp: '2026-08-31T00:00:00Z', role: 'user', content: 'the events-derived first turn' },
        { type: 'message', agent: 'gemini', timestamp: '2026-08-31T00:00:01Z', role: 'assistant', content: 'ack' },
      ],
    }]);
    expect(findSessionsById('fum-enrich')[0].firstUserMessage).toBe('the events-derived first turn');
  });

  it('is first-wins: a later rescan that carries no first turn never blanks a stored one', () => {
    const filePath = emptyFile('firstwins');
    const withTurn: SessionMeta = {
      id: 'fum-firstwins', shortId: 'fum-firs', agent: 'claude', timestamp: '2026-08-31T00:00:00Z',
      filePath, firstUserMessage: 'the original first turn',
    };
    upsertSession(withTurn, '', { fileMtimeMs: 1, fileSize: fs.statSync(filePath).size });
    const withoutTurn: SessionMeta = { ...withTurn, firstUserMessage: undefined };
    upsertSession(withoutTurn, '', { fileMtimeMs: 2, fileSize: fs.statSync(filePath).size });
    expect(findSessionsById('fum-firstwins')[0].firstUserMessage).toBe('the original first turn');
  });
});

describe('usedBrowser/usedComputer — a scoped events-log read, not a transcript re-scan (#11)', () => {
  function emptyFile(id: string): string {
    const filePath = path.join(SEED_FILES_DIR, `${id}.jsonl`);
    fs.writeFileSync(filePath, '');
    return filePath;
  }

  it('upsertSession sets usedBrowser=true from a real browser.navigate event stamped with the session id', () => {
    emit('browser.navigate', { sessionId: 'tool-browser', profile: 'default', url: 'https://example.com' });
    const filePath = emptyFile('tool-browser');
    const meta: SessionMeta = { id: 'tool-browser', shortId: 'tool-bro', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', filePath };
    upsertSession(meta, '', { fileMtimeMs: 1, fileSize: fs.statSync(filePath).size });

    const row = findSessionsById('tool-browser')[0];
    expect(row.usedBrowser).toBe(true);
    expect(row.usedComputer).toBe(false);
  });

  it('upsertSessionsBatch sets usedComputer=true — and runs for claude/codex too (the todos/dirs skip does not apply here)', () => {
    emit('computer.action', { sessionId: 'tool-computer', command: 'click', targetPid: 100 });
    const filePath = emptyFile('tool-computer');
    const meta: SessionMeta = { id: 'tool-computer', shortId: 'tool-com', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', filePath };
    upsertSessionsBatch([{ meta, content: '' }]);

    const row = findSessionsById('tool-computer')[0];
    expect(row.usedComputer).toBe(true);
    expect(row.usedBrowser).toBe(false);
  });

  it('a computer-screenshot-only session sets usedComputer=true (agents computer screenshot / run, not just the explicit verbs)', () => {
    // Mirrors what computer.ts's screenshot command and dispatch.ts's run-loop
    // dispatcher now emit — previously neither path emitted computer.action at
    // all, so a session that only ran `computer screenshot`/`run` read back
    // usedComputer=false (reviewer-flagged regression on #1864).
    emit('computer.action', { sessionId: 'tool-computer-screenshot', command: 'screenshot', targetPid: 200 });
    const filePath = emptyFile('tool-computer-screenshot');
    const meta: SessionMeta = { id: 'tool-computer-screenshot', shortId: 'tool-scr', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', filePath };
    upsertSession(meta, '', { fileMtimeMs: 1, fileSize: fs.statSync(filePath).size });

    const row = findSessionsById('tool-computer-screenshot')[0];
    expect(row.usedComputer).toBe(true);
    expect(row.usedBrowser).toBe(false);
  });

  it('a session with no browser/computer events reads back false for both', () => {
    const filePath = emptyFile('tool-none');
    const meta: SessionMeta = { id: 'tool-none', shortId: 'tool-non', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', filePath };
    upsertSession(meta, '', { fileMtimeMs: 1, fileSize: fs.statSync(filePath).size });

    const row = findSessionsById('tool-none')[0];
    expect(row.usedBrowser).toBe(false);
    expect(row.usedComputer).toBe(false);
  });

  it('a legacy row (used_browser/used_computer still NULL) reads back undefined, not false', () => {
    // Simulates a row from before this migration that hasn't been rescanned —
    // NULL, not 0, is what the ALTER TABLE leaves on every pre-existing row.
    const filePath = emptyFile('tool-legacy');
    const db = getDB();
    db.prepare(`
      INSERT INTO sessions (id, short_id, agent, timestamp, project, cwd, file_path, is_team_origin)
      VALUES ('tool-legacy', 'tool-leg', 'claude', '2026-08-01T00:00:00Z', 'agents-cli', ?, ?, 0)
    `).run(SEED_FILES_DIR, filePath);

    const row = findSessionsById('tool-legacy')[0];
    expect(row.usedBrowser).toBeUndefined();
    expect(row.usedComputer).toBeUndefined();
  });

  it('upsertSessionsBatch correctly flags multiple sessions in one call without scanning event logs inside the write transaction', () => {
    // Three sessions in one batch: browser-only, computer-only, and neither.
    // This exercises the pre-computed queryToolUsageForSessions path that runs
    // outside the SQLite write transaction (RUSH-2207 fix).
    emit('browser.navigate', { sessionId: 'batch-browser', profile: 'default', url: 'https://a.com' });
    emit('computer.action', { sessionId: 'batch-computer', command: 'click', targetPid: 1 });
    // 'batch-none' gets no events

    const makeMeta = (id: string): SessionMeta => ({
      id,
      shortId: id.slice(0, 8),
      agent: 'claude' as const,
      timestamp: '2026-08-01T00:00:00Z',
      filePath: emptyFile(id),
    });

    upsertSessionsBatch([
      { meta: makeMeta('batch-browser'), content: '' },
      { meta: makeMeta('batch-computer'), content: '' },
      { meta: makeMeta('batch-none'), content: '' },
    ]);

    const browser = findSessionsById('batch-browser')[0];
    expect(browser.usedBrowser).toBe(true);
    expect(browser.usedComputer).toBe(false);

    const computer = findSessionsById('batch-computer')[0];
    expect(computer.usedBrowser).toBe(false);
    expect(computer.usedComputer).toBe(true);

    const none = findSessionsById('batch-none')[0];
    expect(none.usedBrowser).toBe(false);
    expect(none.usedComputer).toBe(false);
  });
});

describe('session_resource_usage — skill/slash-command usage joined against real provenance (#12)', () => {
  const RES_DIR = path.join(TEST_HOME, 'resource-usage-files');
  fs.mkdirSync(RES_DIR, { recursive: true });

  function rowsFor(sessionId: string): Array<Record<string, unknown>> {
    return getDB()
      .prepare(`SELECT kind, name, plugin, source, repo_root, snapshot_sha, count FROM session_resource_usage WHERE session_id = ? ORDER BY kind, name`)
      .all(sessionId) as Array<Record<string, unknown>>;
  }

  function skillEvent(skill: string): { type: 'tool_use'; agent: 'claude'; timestamp: string; tool: string; args: Record<string, unknown> } {
    return { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Skill', args: { skill } };
  }

  it('resolves a real user-repo skill: source + repoRoot populated from resolveResource', () => {
    const userAgentsDir = path.join(TEST_HOME, '.agents');
    fs.mkdirSync(path.join(userAgentsDir, 'skills', 'teams'), { recursive: true });
    fs.writeFileSync(path.join(userAgentsDir, 'skills', 'teams', 'SKILL.md'), '---\nname: teams\n---\n');

    const filePath = path.join(RES_DIR, 'skill-user.jsonl');
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T00:00:00Z', message: { content: [
        { type: 'tool_use', id: '1', name: 'Skill', input: { skill: 'teams' } },
      ] } }),
    ].join('\n'));
    const meta: SessionMeta = { id: 'res-skill-user', shortId: 'res-sk-u', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', filePath, cwd: RES_DIR };
    upsertSession(meta, '', { fileMtimeMs: 1, fileSize: fs.statSync(filePath).size });

    expect(rowsFor('res-skill-user')).toEqual([
      { kind: 'skill', name: 'teams', plugin: null, source: 'user', repo_root: userAgentsDir, snapshot_sha: null, count: 1 },
    ]);
  });

  it('resolves a namespaced plugin skill (rush:design) against the discovered plugin, not resolveResource', () => {
    const pluginRoot = path.join(TEST_HOME, '.agents', 'plugins', 'rush');
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'rush', version: '1.0.0', description: 'x' }));
    fs.mkdirSync(path.join(pluginRoot, 'skills', 'design'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'skills', 'design', 'SKILL.md'), '---\nname: design\n---\n');

    const filePath = path.join(RES_DIR, 'skill-plugin.jsonl');
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T00:00:00Z', message: { content: [
        { type: 'tool_use', id: '1', name: 'Skill', input: { skill: 'rush:design' } },
      ] } }),
    ].join('\n'));
    const meta: SessionMeta = { id: 'res-skill-plugin', shortId: 'res-sk-p', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', filePath, cwd: RES_DIR };
    upsertSession(meta, '', { fileMtimeMs: 1, fileSize: fs.statSync(filePath).size });

    const rows = rowsFor('res-skill-plugin');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'skill', name: 'rush:design', plugin: 'rush', repo_root: path.join(TEST_HOME, '.agents') });
  });

  it('resolves a real slash command and strips the leading slash for the stored name', () => {
    const userAgentsDir = path.join(TEST_HOME, '.agents');
    fs.mkdirSync(path.join(userAgentsDir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(userAgentsDir, 'commands', 'recap.md'), '# recap');

    const filePath = path.join(RES_DIR, 'command-user.jsonl');
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: 'user', timestamp: '2026-08-01T00:00:00Z', message: { role: 'user', content: '<command-message>recap</command-message>\n<command-name>/recap</command-name>' } }),
    ].join('\n'));
    const meta: SessionMeta = { id: 'res-command-user', shortId: 'res-cmd', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', filePath, cwd: RES_DIR };
    upsertSession(meta, '', { fileMtimeMs: 1, fileSize: fs.statSync(filePath).size });

    expect(rowsFor('res-command-user')).toEqual([
      { kind: 'command', name: 'recap', plugin: null, source: 'user', repo_root: userAgentsDir, snapshot_sha: null, count: 1 },
    ]);
  });

  it('a skill/command no longer installed still gets a row, with provenance left NULL (not a stale guess)', () => {
    const filePath = path.join(RES_DIR, 'skill-gone.jsonl');
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T00:00:00Z', message: { content: [
        { type: 'tool_use', id: '1', name: 'Skill', input: { skill: 'renamed-or-removed' } },
      ] } }),
    ].join('\n'));
    const meta: SessionMeta = { id: 'res-skill-gone', shortId: 'res-gone', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', filePath, cwd: RES_DIR };
    upsertSession(meta, '', { fileMtimeMs: 1, fileSize: fs.statSync(filePath).size });

    expect(rowsFor('res-skill-gone')).toEqual([
      { kind: 'skill', name: 'renamed-or-removed', plugin: null, source: null, repo_root: null, snapshot_sha: null, count: 1 },
    ]);
  });

  it('counts repeated invocations and a rescan REPLACES rather than accumulates', () => {
    // A name distinct from the other cases in this describe block ('teams' is
    // deliberately installed for an earlier test and would resolve here too).
    const filePath = path.join(RES_DIR, 'skill-rescan.jsonl');
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T00:00:00Z', message: { content: [
        { type: 'tool_use', id: '1', name: 'Skill', input: { skill: 'rescan-only-skill' } },
        { type: 'tool_use', id: '2', name: 'Skill', input: { skill: 'rescan-only-skill' } },
      ] } }),
    ].join('\n'));
    const meta: SessionMeta = { id: 'res-rescan', shortId: 'res-rescn', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', filePath, cwd: RES_DIR };
    upsertSession(meta, '', { fileMtimeMs: 1, fileSize: fs.statSync(filePath).size });
    expect(rowsFor('res-rescan')).toEqual([{ kind: 'skill', name: 'rescan-only-skill', plugin: null, source: null, repo_root: null, snapshot_sha: null, count: 2 }]);

    // Rescan with the SAME file (simulating a bare re-index) must not double the count.
    upsertSession(meta, '', { fileMtimeMs: 2, fileSize: fs.statSync(filePath).size });
    expect(rowsFor('res-rescan')).toEqual([{ kind: 'skill', name: 'rescan-only-skill', plugin: null, source: null, repo_root: null, snapshot_sha: null, count: 2 }]);
  });

  it('a session with no skill/slash-command activity writes zero rows', () => {
    const filePath = path.join(RES_DIR, 'no-usage.jsonl');
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T00:00:00Z', message: { content: [
        { type: 'tool_use', id: '1', name: 'Read', input: { file_path: '/repo/a.ts' } },
      ] } }),
    ].join('\n'));
    const meta: SessionMeta = { id: 'res-none', shortId: 'res-none', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', filePath, cwd: RES_DIR };
    upsertSession(meta, '', { fileMtimeMs: 1, fileSize: fs.statSync(filePath).size });
    expect(rowsFor('res-none')).toEqual([]);
  });

  it('querySessions({ skill }) matches a bare name and a namespaced plugin skill by its short name (#12)', () => {
    // Reuses the sessions seeded by the earlier tests in this block:
    // res-skill-user used 'teams', res-skill-plugin used 'rush:design'.
    const byTeams = querySessions({ skill: 'teams' });
    expect(byTeams.map((s) => s.id)).toContain('res-skill-user');
    expect(byTeams.map((s) => s.id)).not.toContain('res-skill-plugin');

    // '--skill design' finds the namespaced 'rush:design' via the short-name fallback.
    const byDesign = querySessions({ skill: 'design' });
    expect(byDesign.map((s) => s.id)).toContain('res-skill-plugin');
    expect(byDesign.map((s) => s.id)).not.toContain('res-skill-user');

    expect(querySessions({ skill: 'no-such-skill-anywhere' })).toEqual([]);
  });

  it('querySessions({ plugin }) matches sessions that used ANY resource owned by that plugin (#12)', () => {
    const byPlugin = querySessions({ plugin: 'rush' });
    expect(byPlugin.map((s) => s.id)).toContain('res-skill-plugin');
    // res-command-user used a plain (non-plugin) command — must not match.
    expect(byPlugin.map((s) => s.id)).not.toContain('res-command-user');

    expect(querySessions({ plugin: 'no-such-plugin' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cost + duration (issue #323) — real SQLite, migration v6 columns, sort,
// rollup grouping for a multi-model session.
// ---------------------------------------------------------------------------

// Single teardown for the whole file (the per-describe teardown was removed so
// later describe blocks still have a live DB and an intact TEST_HOME).
afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

const COST_FILES_DIR = path.join(TEST_HOME, 'cost-files');
fs.mkdirSync(COST_FILES_DIR, { recursive: true });

/** Upsert a costed session through the public API (exercises the v6 schema). */
function seedCosted(
  id: string,
  agent: SessionMeta['agent'],
  timestamp: string,
  costUsd: number | undefined,
  durationMs: number | undefined,
  project = 'agents-cli',
): void {
  const filePath = path.join(COST_FILES_DIR, `${id}.jsonl`);
  fs.writeFileSync(filePath, '');
  const meta: SessionMeta = {
    id,
    shortId: id.slice(0, 8),
    agent,
    timestamp,
    project,
    cwd: COST_FILES_DIR,
    filePath,
    costUsd,
    durationMs,
  };
  upsertSession(meta, '');
}

describe('migration v5 -> v6 adds cost/duration columns', () => {
  it('sessions table has cost_usd and duration_ms columns', () => {
    const db = getDB();
    const cols = (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('cost_usd');
    expect(cols).toContain('duration_ms');
  });

  it('schema_version is recorded as the current version', () => {
    const db = getDB();
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
    expect(row.value).toBe(String(SCHEMA_VERSION));
  });

  it('persists the session model when present', () => {
    const filePath = path.join(COST_FILES_DIR, 'model-row.jsonl');
    fs.writeFileSync(filePath, '');
    upsertSession({
      id: 'model-row',
      shortId: 'model-ro',
      agent: 'claude',
      timestamp: '2026-08-01T14:00:00.000Z',
      filePath,
      model: 'claude-sonnet-4-20250514',
    }, '');
    expect(querySessions({ idExact: 'model-row' })[0]?.model).toBe('claude-sonnet-4-20250514');
  });

  it('v10 unifies name into label — the separate `name` column is dropped', () => {
    const db = getDB();
    const cols = (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).not.toContain('name');
    expect(cols).toContain('label');
  });

  it('v7 adds the session-state columns (pr_url, worktree_slug, ticket_id)', () => {
    const db = getDB();
    const cols = (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('pr_url');
    expect(cols).toContain('pr_number');
    expect(cols).toContain('worktree_slug');
    expect(cols).toContain('ticket_id');
  });

  it('v8 adds the last_activity column', () => {
    const db = getDB();
    const cols = (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('last_activity');
  });

  it('v11 adds the plan column (ExitPlanMode markdown)', () => {
    const db = getDB();
    const cols = (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('plan');
  });

  it('v13 adds routine-origin linkage columns', () => {
    const db = getDB();
    const cols = (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('origin');
    expect(cols).toContain('routine_name');
    expect(cols).toContain('routine_run_id');
  });
});

// ---------------------------------------------------------------------------
// last_activity (v8) — the listing sorts and labels by last-message time, not
// creation time. A session created long ago but active recently must lead.
// ---------------------------------------------------------------------------
const ACTIVITY_FILES_DIR = path.join(TEST_HOME, 'activity-files');
fs.mkdirSync(ACTIVITY_FILES_DIR, { recursive: true });

function seedActive(id: string, timestamp: string, lastActivity: string | undefined): void {
  const filePath = path.join(ACTIVITY_FILES_DIR, `${id}.jsonl`);
  fs.writeFileSync(filePath, '');
  upsertSession(
    { id, shortId: id.slice(0, 8), agent: 'claude', timestamp, lastActivity, project: 'agents-cli', cwd: ACTIVITY_FILES_DIR, filePath },
    '',
  );
}

describe('default sort orders by last_activity (v8)', () => {
  beforeAll(() => {
    // Creation order and activity order deliberately disagree.
    seedActive('la-oldcreate-newactive', '2026-01-01T00:00:00.000Z', '2026-07-04T12:00:00.000Z');
    seedActive('la-midcreate-midactive', '2026-06-01T00:00:00.000Z', '2026-06-15T00:00:00.000Z');
    seedActive('la-newcreate-oldactive', '2026-07-01T00:00:00.000Z', '2026-07-01T00:05:00.000Z');
    seedActive('la-noactivity', '2026-05-20T00:00:00.000Z', undefined); // no lastActivity → falls back to timestamp
  });

  it('round-trips last_activity through SQLite', () => {
    const rows = querySessions({ cwdPrefix: ACTIVITY_FILES_DIR });
    expect(rows.find(r => r.id === 'la-oldcreate-newactive')!.lastActivity).toBe('2026-07-04T12:00:00.000Z');
  });

  it('ranks by last activity, not creation time (fallback = timestamp)', () => {
    const rows = querySessions({ cwdPrefix: ACTIVITY_FILES_DIR });
    expect(rows.map(r => r.id)).toEqual([
      'la-oldcreate-newactive', // active Jul 4 (though created back in Jan)
      'la-newcreate-oldactive', // active Jul 1
      'la-midcreate-midactive', // active Jun 15
      'la-noactivity',          // no activity → creation ts May 20
    ]);
  });
});

describe('cost/duration upsert round-trip', () => {
  beforeAll(() => {
    seedCosted('c1-cheap', 'claude', '2026-05-01T10:00:00.000Z', 0.50, 60_000, 'proj-a');
    seedCosted('c2-pricey', 'claude', '2026-05-02T10:00:00.000Z', 12.34, 3_600_000, 'proj-b');
    seedCosted('c3-mid', 'codex', '2026-05-03T10:00:00.000Z', 3.00, 600_000, 'proj-a');
    seedCosted('c4-null', 'claude', '2026-05-04T10:00:00.000Z', undefined, undefined, 'proj-b');
  });

  it('round-trips cost_usd and duration_ms through SQLite', () => {
    const rows = querySessions({ cwdPrefix: COST_FILES_DIR });
    const pricey = rows.find(r => r.id === 'c2-pricey')!;
    expect(pricey.costUsd).toBeCloseTo(12.34, 10);
    expect(pricey.durationMs).toBe(3_600_000);
    const nullRow = rows.find(r => r.id === 'c4-null')!;
    expect(nullRow.costUsd).toBeUndefined();
    expect(nullRow.durationMs).toBeUndefined();
  });

  it('--sort cost orders by cost desc with NULLs last', () => {
    const rows = querySessions({ cwdPrefix: COST_FILES_DIR, sortBy: 'cost' });
    expect(rows.map(r => r.id)).toEqual(['c2-pricey', 'c3-mid', 'c1-cheap', 'c4-null']);
  });

  it('--sort duration orders by duration desc with NULLs last', () => {
    const rows = querySessions({ cwdPrefix: COST_FILES_DIR, sortBy: 'duration' });
    expect(rows.map(r => r.id)).toEqual(['c2-pricey', 'c3-mid', 'c1-cheap', 'c4-null']);
  });

  it('topSessionsByCost returns priciest first and excludes NULL-cost rows', () => {
    const top = topSessionsByCost(10, { cwdPrefix: COST_FILES_DIR });
    expect(top.map(t => t.meta.id)).toEqual(['c2-pricey', 'c3-mid', 'c1-cheap']);
    expect(top[0].costUsd).toBeCloseTo(12.34, 10);
  });

  it('queryUsageRollup groups by agent with summed cost', () => {
    const rows = queryUsageRollup({ cwdPrefix: COST_FILES_DIR, groupBy: 'agent' });
    const byKey = new Map(rows.map(r => [r.key, r]));
    expect(byKey.get('claude')!.costUsd).toBeCloseTo(0.50 + 12.34, 10);
    expect(byKey.get('claude')!.sessionCount).toBe(3);
    expect(byKey.get('codex')!.costUsd).toBeCloseTo(3.00, 10);
  });

  it('queryUsageRollup groups by project across agents', () => {
    const rows = queryUsageRollup({ cwdPrefix: COST_FILES_DIR, groupBy: 'project' });
    const byKey = new Map(rows.map(r => [r.key, r]));
    // proj-a = c1-cheap (claude) + c3-mid (codex) = 0.50 + 3.00
    expect(byKey.get('proj-a')!.costUsd).toBeCloseTo(3.50, 10);
    expect(byKey.get('proj-a')!.sessionCount).toBe(2);
    // proj-b = c2-pricey + c4-null (null cost contributes 0)
    expect(byKey.get('proj-b')!.costUsd).toBeCloseTo(12.34, 10);
    expect(byKey.get('proj-b')!.sessionCount).toBe(2);
  });

  it('queryUsageRollup groups by day (ISO date prefix)', () => {
    const rows = queryUsageRollup({ cwdPrefix: COST_FILES_DIR, groupBy: 'day' });
    const keys = rows.map(r => r.key);
    expect(keys).toContain('2026-05-01');
    expect(keys).toContain('2026-05-02');
  });
});

describe('multi-model session cost equals sum of per-model usage', () => {
  it('an opus+haiku session sums to the sum of each model cost', () => {
    // Simulate a session that ran two models; the scanner accumulates per-model
    // cost into one costUsd. Verify the rollup reflects that exact sum.
    const opus = costOfUsage({ model: 'claude-opus-4', inputTokens: 10_000, outputTokens: 5_000 });
    const haiku = costOfUsage({ model: 'claude-haiku-4', inputTokens: 20_000, outputTokens: 8_000 });
    const sessionCost = opus + haiku;
    seedCosted('mm1', 'claude', '2026-05-10T10:00:00.000Z', sessionCost, 120_000, 'proj-mm');

    const rows = queryUsageRollup({ cwdPrefix: COST_FILES_DIR, groupBy: 'project' });
    const projMm = rows.find(r => r.key === 'proj-mm')!;
    expect(projMm.costUsd).toBeCloseTo(opus + haiku, 10);
    expect(projMm.costUsd).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// syncTopics — apply externally-sourced titles (Codex thread_name) by id.
// ---------------------------------------------------------------------------

const TOPIC_FILES_DIR = path.join(TEST_HOME, 'topic-files');
fs.mkdirSync(TOPIC_FILES_DIR, { recursive: true });

function seedTopic(id: string, topic: string): void {
  const filePath = path.join(TOPIC_FILES_DIR, `${id}.jsonl`);
  fs.writeFileSync(filePath, '');
  const meta: SessionMeta = {
    id,
    shortId: id.slice(0, 8),
    agent: 'codex',
    timestamp: '2026-06-28T00:00:00.000Z',
    project: 'agents-cli',
    cwd: TOPIC_FILES_DIR,
    filePath,
    topic,
  };
  // Upsert through the public API so session_text (FTS) is populated too.
  upsertSession(meta, 'searchable body text');
}

describe('syncTopics', () => {
  beforeAll(() => {
    seedTopic('codex-rename', 'first prompt fallback');
    seedTopic('codex-keep', 'Already correct');
  });

  it('updates topic in sessions + FTS only for ids whose title differs', () => {
    const updated = syncTopics(
      new Map([
        ['codex-rename', 'Review skill placement'],
        ['codex-keep', 'Already correct'], // identical -> no update
        ['codex-missing', 'No such session'], // not in DB -> no update
      ]),
    );
    expect(updated).toBe(1);

    const rows = querySessions({ agent: 'codex' });
    expect(rows.find(r => r.id === 'codex-rename')?.topic).toBe('Review skill placement');
    expect(rows.find(r => r.id === 'codex-keep')?.topic).toBe('Already correct');

    // The new title is searchable via FTS (topic column was updated, not just sessions).
    const hits = ftsSearch('Review skill placement');
    expect(hits.some(h => h.sessionId === 'codex-rename')).toBe(true);
  });

  it('never clears an existing topic with an empty value', () => {
    const updated = syncTopics(new Map([['codex-keep', '']]));
    expect(updated).toBe(0);
    const rows = querySessions({ agent: 'codex' });
    expect(rows.find(r => r.id === 'codex-keep')?.topic).toBe('Already correct');
  });

  it('returns 0 for an empty map', () => {
    expect(syncTopics(new Map())).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// findSessionsById — exact-then-prefix id resolution over the index (the
// DB-backed equivalent of resolveSessionById, used by `agents run --resume`).
// ---------------------------------------------------------------------------

const ID_FILES_DIR = path.join(TEST_HOME, 'id-files');
fs.mkdirSync(ID_FILES_DIR, { recursive: true });

/** Seed a session with explicit id / short_id / agent / version / cwd. */
function seedId(
  id: string,
  shortId: string,
  agent: string,
  version: string | null,
  cwd: string,
  timestamp: string,
): void {
  const filePath = path.join(ID_FILES_DIR, `${id}.jsonl`);
  fs.writeFileSync(filePath, '');
  getDB().prepare(`
    INSERT INTO sessions (
      id, short_id, agent, version, timestamp, project, cwd,
      file_path, file_mtime_ms, file_size, scanned_at, is_team_origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(id, shortId, agent, version, timestamp, 'proj-id', cwd, filePath, 0, 0, 0);
}

describe('findSessionsById', () => {
  const HERE = path.join(ID_FILES_DIR, 'here');
  const ELSEWHERE = path.join(ID_FILES_DIR, 'elsewhere');

  beforeAll(() => {
    // Two sessions sharing the prefix "80af" in THIS project's cwd.
    seedId('80af76ca-b734-4f45-8833-ef1142219568', '80af76ca', 'claude', '2.1.180', HERE, '2026-06-01T10:00:00.000Z');
    seedId('80af0000-0000-4000-8000-000000000001', '80af0000', 'claude', '2.1.181', HERE, '2026-06-02T10:00:00.000Z');
    // A non-overlapping id in a DIFFERENT project's cwd (for widen test).
    seedId('cccccccc-0000-4000-8000-000000000002', 'cccccccc', 'claude', '2.1.181', ELSEWHERE, '2026-06-03T10:00:00.000Z');
    // A codex session whose id collides on prefix with the claude ones.
    seedId('80af9999-0000-4000-8000-000000000003', '80af9999', 'codex', '0.50.0', HERE, '2026-06-04T10:00:00.000Z');
  });

  it('resolves a full id exactly (no prefix siblings dragged in)', () => {
    const r = findSessionsById('80af76ca-b734-4f45-8833-ef1142219568', { agent: 'claude' });
    expect(r.map(s => s.id)).toEqual(['80af76ca-b734-4f45-8833-ef1142219568']);
  });

  it('resolves a short id exactly', () => {
    const r = findSessionsById('80af0000', { agent: 'claude' });
    expect(r.map(s => s.id)).toEqual(['80af0000-0000-4000-8000-000000000001']);
  });

  it('is case-insensitive', () => {
    const r = findSessionsById('80AF76CA', { agent: 'claude' });
    expect(r.map(s => s.id)).toEqual(['80af76ca-b734-4f45-8833-ef1142219568']);
  });

  it('returns all prefix matches when ambiguous, newest first', () => {
    const r = findSessionsById('80af', { agent: 'claude' });
    expect(r.map(s => s.id)).toEqual([
      '80af0000-0000-4000-8000-000000000001',
      '80af76ca-b734-4f45-8833-ef1142219568',
    ]);
  });

  it('scopes by agent — codex prefix sibling does not leak into a claude lookup', () => {
    const claude = findSessionsById('80af', { agent: 'claude' });
    expect(claude.some(s => s.agent === 'codex')).toBe(false);
    const codex = findSessionsById('80af', { agent: 'codex' });
    expect(codex.map(s => s.id)).toEqual(['80af9999-0000-4000-8000-000000000003']);
  });

  it('scopes by version', () => {
    const r = findSessionsById('80af', { agent: 'claude', version: '2.1.180' });
    expect(r.map(s => s.id)).toEqual(['80af76ca-b734-4f45-8833-ef1142219568']);
  });

  it('cwd scope finds in-project, and dropping cwd widens to other projects', () => {
    const scoped = findSessionsById('cccccccc', { agent: 'claude', cwd: HERE });
    expect(scoped).toEqual([]); // lives in ELSEWHERE, not HERE
    const widened = findSessionsById('cccccccc', { agent: 'claude' });
    expect(widened.map(s => s.id)).toEqual(['cccccccc-0000-4000-8000-000000000002']);
  });

  it('returns empty for an unknown id and a blank query', () => {
    expect(findSessionsById('deadbeef', { agent: 'claude' })).toEqual([]);
    expect(findSessionsById('   ', { agent: 'claude' })).toEqual([]);
  });
});

describe('upsertSessionsBatch per-row guard', () => {
  it('skips a row that violates a NOT NULL column and still indexes the rest', () => {
    const goodFile = path.join(SEED_FILES_DIR, 'batch-good.jsonl');
    const badFile = path.join(SEED_FILES_DIR, 'batch-bad.jsonl');
    fs.writeFileSync(goodFile, '');
    fs.writeFileSync(badFile, '');
    const mk = (id: string, timestamp: string, filePath: string) => ({
      meta: { id, shortId: id.slice(0, 8), agent: 'kimi' as const, timestamp, filePath } as SessionMeta,
      content: '',
      scan: { fileMtimeMs: 0, fileSize: 0 },
    });
    const good = mk('batch-good-0000-4000-8000-000000000001', '2026-07-01T00:00:00.000Z', goodFile);
    // A NULL timestamp violates `timestamp TEXT NOT NULL`. Before the guard this threw
    // and rolled back the whole batch; now it must skip just this row.
    const bad = mk('batch-bad-00000-4000-8000-000000000002', null as unknown as string, badFile);

    expect(() => upsertSessionsBatch([bad, good])).not.toThrow();

    const ids = querySessions({}).map((s) => s.id);
    expect(ids).toContain('batch-good-0000-4000-8000-000000000001');
    expect(ids).not.toContain('batch-bad-00000-4000-8000-000000000002');
  });
});

describe('closeDB drops the cached prepared statements', () => {
  // Regression for the "statement has been finalized" bug: closeDB() finalizes
  // every prepared statement the connection owns, but the module-level
  // cachedStmts (upsert/FTS) used to survive the close. The next getDB() opened a
  // fresh connection while stmts() handed back the stale, finalized statements —
  // so the first upsertSession() after a closeDB() threw. In host-session
  // registration (which swallows write errors) that silently dropped the row.
  it('lets upsertSession run again after closeDB without throwing a finalized statement', () => {
    const fileA = path.join(SEED_FILES_DIR, 'reopen-a.jsonl');
    const fileB = path.join(SEED_FILES_DIR, 'reopen-b.jsonl');
    fs.writeFileSync(fileA, '');
    fs.writeFileSync(fileB, '');

    // A first upsert POPULATES cachedStmts with statements bound to this
    // connection. Without that priming, stmts() would just rebuild fresh after
    // the close and the bug wouldn't reproduce — the finalized statement only
    // bites when the cache already holds statements from the closed connection.
    upsertSession(
      { id: 'reopen00-0000-4000-8000-00000000000a', shortId: 'reopen00',
        agent: 'claude', timestamp: '2026-07-05T00:00:00.000Z', cwd: '/x',
        filePath: fileA } as SessionMeta,
      '',
    );

    // Close finalizes those cached statements. Pre-fix, cachedStmts survived and
    // pointed at the finalized handles.
    closeDB();

    // The upsert that used to throw "statement has been finalized": getDB() opens
    // a fresh connection, but stmts() must NOT hand back the stale cache.
    const meta: SessionMeta = {
      id: 'reopen00-0000-4000-8000-00000000000b', shortId: 'reopen00',
      agent: 'claude', timestamp: '2026-07-05T00:00:01.000Z', cwd: '/x',
      filePath: fileB,
    } as SessionMeta;
    expect(() => upsertSession(meta, '')).not.toThrow();

    // And the row actually landed against the reopened connection.
    expect(findSessionsById('reopen00-0000-4000-8000-00000000000b')).toHaveLength(1);
  });
});
