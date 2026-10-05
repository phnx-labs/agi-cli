import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDB, readSessionTopics, INSIGHTS_EXTRACTOR_VERSION } from '../session/db.js';
import * as sessionDb from '../session/db.js';
import { getRuntimeStateDir } from '../state.js';
import type { ClassifiedTopic } from './classify.js';
import { buildIndexShard, buildSessionDetail, buildSessionShard, classifySessionKind, readSyncLedger, syncTraces, type SyncRow } from './sync.js';

const id = 'trace-rich-fixture';
const transcript = path.join(import.meta.dirname, '../session/testdata/codex-fixture.jsonl');

function row(mtime: number, size: number): SyncRow {
  return {
    id, short_id: 'trace-ri', agent: 'codex', origin: 'cli', routine_name: null,
    routine_run_id: null, version: null, account: null, account_key: null,
    account_org: null, mode: 'auto', timestamp: '2026-08-25T00:00:00.000Z',
    last_activity: null, project: 'agents-cli', cwd: '/redacted/agents-cli',
    git_branch: 'feat/trace-sync', topic: null, label: 'Fix trace sync',
    message_count: null, token_count: null, output_tokens: null, input_tokens: null,
    cache_read_tokens: null, cache_write_tokens: null, cost_usd: null,
    cost_usd_nocache: null, duration_ms: 9000, model: 'gpt-test',
    tool_call_count: 3, file_path: transcript, file_mtime_ms: mtime,
    file_size: size, machine: 'test-device',
  };
}

describe('rich traces index shard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'));
    const db = getDB();
    db.prepare('DELETE FROM tool_calls WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM session_topics WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM session_insights WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('matches the committed console fixture, self-heals topics, and preserves the ledger', async () => {
    const stat = fs.statSync(transcript);
    const first = row(stat.mtimeMs, stat.size);
    const db = getDB();
    db.prepare(`
      INSERT INTO sessions
        (id, short_id, agent, timestamp, project, cwd, git_branch, label, duration_ms,
         model, file_path, file_mtime_ms, file_size, machine)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      first.id, first.short_id, first.agent, first.timestamp, first.project, first.cwd,
      first.git_branch, first.label, first.duration_ms, first.model, first.file_path,
      first.file_mtime_ms, first.file_size, first.machine,
    );
    const insertCall = db.prepare(`
      INSERT INTO tool_calls
        (call_key, session_id, ordinal, timestamp, tool, input, outcome, exit_code,
         error, evidence_bytes)
      VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, 0)
    `);
    insertCall.run('trace-call-1', id, 1, first.timestamp, 'exec_command', 'error', 1, 'command failed');
    insertCall.run('trace-call-2', id, 2, first.timestamp, 'exec_command', 'error', 1, 'git-guard blocked');
    insertCall.run('trace-call-3', id, 3, first.timestamp, 'Read', 'ok', null, null);
    db.prepare(`
      INSERT INTO session_insights
        (session_id, file_mtime_ms, file_size, extractor_version, computed_at, facets)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      first.file_mtime_ms,
      first.file_size,
      INSIGHTS_EXTRACTOR_VERSION,
      Date.now(),
      JSON.stringify({ frictionSignals: { 'failed tool loop: exec_command': 1 }, correctionSignals: {} }),
    );

    const shard = buildIndexShard([first], 'test-device', 'owner-1');
    const expected = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'testdata/rich-index.json'), 'utf8'));
    expect(shard).toEqual(expected);

    expect(readSessionTopics<ClassifiedTopic>([id]).get(id)?.key).toBe('bugfix');
    db.prepare('UPDATE sessions SET file_size = file_size + 1 WHERE id = ?').run(id);
    expect(readSessionTopics<ClassifiedTopic>([id]).has(id)).toBe(false);
    buildIndexShard([{ ...first, file_size: first.file_size! + 1 }], 'test-device', 'owner-1');
    expect(readSessionTopics<ClassifiedTopic>([id]).get(id)?.key).toBe('bugfix');
    db.prepare('UPDATE sessions SET file_mtime_ms = file_mtime_ms + 1 WHERE id = ?').run(id);
    expect(readSessionTopics<ClassifiedTopic>([id]).has(id)).toBe(false);
    buildIndexShard([{
      ...first,
      file_mtime_ms: first.file_mtime_ms! + 1,
      file_size: first.file_size! + 1,
    }], 'test-device', 'owner-1');
    expect(readSessionTopics<ClassifiedTopic>([id]).get(id)?.key).toBe('bugfix');
    db.prepare(`
      UPDATE session_insights
      SET file_mtime_ms = ?, file_size = ?,
          facets = '{"frictionSignals":{"failed tool loop: exec_command":1},"correctionSignals":{}}'
      WHERE session_id = ?
    `).run(first.file_mtime_ms! + 1, first.file_size! + 1, id);
    process.env.AGENTS_TRACE_FIXTURE_SECRET = 'phoenix-secret-value';
    try {
      const redacted = buildIndexShard([{
        ...first,
        label: 'Fix phoenix-secret-value',
        file_mtime_ms: first.file_mtime_ms! + 1,
        file_size: first.file_size! + 1,
      }], 'test-device', 'owner-1');
      expect(redacted.needsAttention[0].title).not.toContain('phoenix-secret-value');
    } finally {
      delete process.env.AGENTS_TRACE_FIXTURE_SECRET;
    }

    const seededShard = JSON.stringify({
      schema: 1, device: 'test-device', syncedAt: 0, owner: 'owner-1',
      stats: { sessionsImported: 1, medianMs: 0, p90Ms: 0, needAttention: 0, toolErrorRate: 0.1 },
      needsAttention: [],
      topics: [{ key: 'bugfix', label: 'Bug fixes', count: 10, group: 'code' }],
      failures: { byToolError: [], byCause: { real: 0, guard: 0, hook: 0 } },
      bucketHistory: Array.from({ length: 7 }, (_, i) => [
        { key: 'bugfix', date: `2026-08-${String(i + 18).padStart(2, '0')}`, count: 10, errorRate: 0.1, stallRate: 0 },
      ]),
      driftSignals: [],
    });
    const requests: string[] = [];
    const reqLog: string[] = [];
    const indexPutBodies: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      reqLog.push(`${req.method} ${req.url ?? ''}`);
      if (req.method === 'GET' && req.url?.endsWith('/index.json')) {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' }).end(seededShard);
      } else if (req.method === 'PUT' && req.url?.endsWith('/index.json')) {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => { indexPutBodies.push(Buffer.concat(chunks).toString()); res.writeHead(200).end('ok'); });
      } else {
        req.resume();
        res.writeHead(200).end('ok');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
    process.env.AGENTS_TRACES_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.AGENTS_TRACES_WRITE_TOKEN = 'test-token';
    process.env.AGENTS_SYNC_MACHINE_ID = 'test-device';
    fs.rmSync(path.join(getRuntimeStateDir(), 'traces-sync.json'), { force: true });
    const realFetch = globalThis.fetch;
    const outboundUrls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      outboundUrls.push(typeof input === 'string' ? input : input.toString());
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      expect(await syncTraces()).toMatchObject({ uploaded: 1, errors: 0 });
      expect(await syncTraces()).toMatchObject({ uploaded: 0, errors: 0 });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.AGENTS_TRACES_BASE_URL;
      delete process.env.AGENTS_TRACES_WRITE_TOKEN;
      delete process.env.AGENTS_SYNC_MACHINE_ID;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    expect(outboundUrls.some((u) => u.includes('api.prix.dev'))).toBe(false);
    expect(requests.filter((url) => url.includes(`/sessions/${id}.json`))).toHaveLength(1);
    expect(reqLog.filter((r) => r.startsWith('GET') && r.includes('/index.json'))).toHaveLength(2);
    const indexBody = JSON.parse(indexPutBodies[0]);
    expect(indexBody.driftSignals).toHaveLength(1);
    expect(indexBody.driftSignals[0].bucket).toBe('bugfix');
    expect(indexBody.driftSignals[0].severity).toBe('degrading');
  });

  it('still builds a complete shard when the cache write-back is locked (PHNX-3401)', () => {
    const stat = fs.statSync(transcript);
    const first = row(stat.mtimeMs, stat.size);
    const db = getDB();
    db.prepare(`
      INSERT INTO sessions
        (id, short_id, agent, timestamp, project, cwd, git_branch, label, duration_ms,
         model, file_path, file_mtime_ms, file_size, machine)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      first.id, first.short_id, first.agent, first.timestamp, first.project, first.cwd,
      first.git_branch, first.label, first.duration_ms, first.model, first.file_path,
      first.file_mtime_ms, first.file_size, first.machine,
    );
    db.prepare(`
      INSERT INTO tool_calls
        (call_key, session_id, ordinal, timestamp, tool, input, outcome, exit_code, error, evidence_bytes)
      VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, 0)
    `).run('lock-call-1', id, 1, first.timestamp, 'exec_command', 'error', 1, 'command failed');
    db.prepare(`
      INSERT INTO session_insights
        (session_id, file_mtime_ms, file_size, extractor_version, computed_at, facets)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id, first.file_mtime_ms, first.file_size, INSIGHTS_EXTRACTOR_VERSION, Date.now(),
      JSON.stringify({ frictionSignals: { 'failed tool loop: exec_command': 1 }, correctionSignals: {} }),
    );

    const write = vi.spyOn(sessionDb, 'writeSessionTopics').mockImplementation(() => {
      throw new Error('database is locked');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let shard!: ReturnType<typeof buildIndexShard>;
      expect(() => {
        shard = buildIndexShard([first], 'test-device', 'owner-1');
      }).not.toThrow();

      expect(shard.wastedMsTotal).toBeTypeOf('number');
      expect(Array.isArray(shard.failurePatterns)).toBe(true);
      expect(shard.latency).toBeDefined();
      expect(shard.needsAttention.length).toBeGreaterThan(0);
      expect(shard.stats.sessionsImported).toBe(1);

      expect(write).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('session-topics cache warm-up skipped'),
      );
    } finally {
      write.mockRestore();
      warn.mockRestore();
    }
  });

  it('surfaces SyncResult.indexError when the index upload fails, without failing the session upload', async () => {
    const stat = fs.statSync(transcript);
    const first = row(stat.mtimeMs, stat.size);
    const db = getDB();
    db.prepare(`
      INSERT INTO sessions
        (id, short_id, agent, timestamp, project, cwd, git_branch, label, duration_ms,
         model, file_path, file_mtime_ms, file_size, machine)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      first.id, first.short_id, first.agent, first.timestamp, first.project, first.cwd,
      first.git_branch, first.label, first.duration_ms, first.model, first.file_path,
      first.file_mtime_ms, first.file_size, first.machine,
    );

    const server = http.createServer((req, res) => {
      if (req.method === 'PUT' && req.url?.endsWith('/index.json')) {
        req.resume();
        res.writeHead(500).end('boom');
      } else {
        req.resume();
        res.writeHead(200).end('ok');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
    process.env.AGENTS_TRACES_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.AGENTS_TRACES_WRITE_TOKEN = 'test-token';
    process.env.AGENTS_SYNC_MACHINE_ID = 'test-device';
    fs.rmSync(path.join(getRuntimeStateDir(), 'traces-sync.json'), { force: true });
    try {
      const result = await syncTraces();
      expect(result.uploaded).toBe(1);
      expect(result.errors).toBe(0);
      expect(result.indexError).toBeDefined();
      expect(result.indexError).toContain('500');
    } finally {
      delete process.env.AGENTS_TRACES_BASE_URL;
      delete process.env.AGENTS_TRACES_WRITE_TOKEN;
      delete process.env.AGENTS_SYNC_MACHINE_ID;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe('buildSessionDetail (per-session drill-down shape)', () => {
  const baseTraj = {
    session: { id: 's1', agent: 'claude', model: 'opus-4-8', cwd: '/home/x/repo', costUsd: 1.5 },
    spanMs: 60_000,
    steps: [
      { ordinal: 1, lane: 'Bash', tool: 'Bash', startMs: 0, durationMs: 100, outcome: 'error', label: 'git rebase' },
      { ordinal: 2, lane: 'Read', tool: 'Read', startMs: 200, durationMs: 50, outcome: 'ok', label: 'read file' },
    ],
    gaps: [{ startMs: 300, durationMs: 130_000, afterOrdinal: 2 }],
    programTimeShare: {},
    errorCount: 1,
    redacted: true,
    stats: { userTurns: 3, assistantTurns: 4, toolCount: 2, outputTokens: 1000 },
    truncatedSteps: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  it('buildSessionShard emits schema 2 by default — no env var, no operator knob', () => {
    const emptyTraj = { ...baseTraj, steps: [], gaps: [], errorCount: 0 };
    delete process.env['AGENTS_TRACES_SCHEMA2'];
    const shard = buildSessionShard(emptyTraj, [], undefined);
    expect(shard.schema).toBe(2);
  });

  it('emits the console meta summary from real trajectory fields', () => {
    const d = buildSessionDetail(baseTraj);
    expect(d.schema).toBe(1);
    expect(d.id).toBe('s1');
    expect(d.meta.spanMs).toBe(60_000);
    expect(d.meta.activeMs).toBe(0);
    expect(d.meta.turns).toBe(7);
    expect(d.meta.tools).toBe(2);
    expect(d.meta.errorCount).toBe(1);
    expect(d.meta.tokens).toBe(1000);
    expect(d.meta.costUsd).toBe(1.5);
    expect(d.meta.outcome).toBe('errored');
    expect(d.meta.repo).toBe('repo');
    expect(d.meta.agent).toBe('claude');
    expect(d.steps).toHaveLength(2);
  });

  it('synthesizes a whereItWentWrong narrative from error steps + stalls', () => {
    const d = buildSessionDetail(baseTraj);
    expect(d.whereItWentWrong).toContain('1 tool error');
    expect(d.whereItWentWrong).toContain('Bash');
    expect(d.whereItWentWrong).toContain('stalled 2m');
  });

  it('returns whereItWentWrong=null for a clean run', () => {
    const clean = buildSessionDetail({
      ...baseTraj,
      steps: [baseTraj.steps[1]],
      gaps: [],
      errorCount: 0,
    });
    expect(clean.whereItWentWrong).toBeNull();
    expect(clean.meta.outcome).toBe('completed');
  });

  it('surfaces every failed step so a run-level view never hides a tool failure', () => {
    const d = buildSessionDetail(baseTraj);
    expect(d.surfacedToolFailures).toEqual([{ tool: 'Bash', label: 'git rebase', detail: undefined }]);

    const clean = buildSessionDetail({ ...baseTraj, steps: [baseTraj.steps[1]], gaps: [], errorCount: 0 });
    expect(clean.surfacedToolFailures).toEqual([]);
  });
});

describe('buildSessionDetail truthful run outcome (PHNX-3387)', () => {
  const step = (ordinal: number, tool: string, outcome: 'ok' | 'error', label: string, program?: string) => ({
    ordinal, kind: 'tool' as const, lane: tool, tool, startMs: ordinal * 10, durationMs: 5, outcome, label,
    ...(program ? { program } : {}),
  });
  const traj = (steps: ReturnType<typeof step>[]) => ({
    session: { id: 's', agent: 'claude', model: 'opus-4-8', cwd: '/home/x/repo', costUsd: 0 },
    spanMs: 1_000, steps, gaps: [], programTimeShare: {},
    errorCount: steps.filter((s) => s.outcome === 'error').length, redacted: true,
    stats: { userTurns: 1, assistantTurns: 1, toolCount: steps.length, outputTokens: 0 },
    truncatedSteps: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  it('recover-then-succeed → completed, and still surfaces the recovered-from failure', () => {
    const d = buildSessionDetail(traj([
      step(1, 'Bash', 'error', 'bun test'),
      step(2, 'Edit', 'ok', 'fix the bug'),
      step(3, 'Bash', 'ok', 'bun test'),
    ]));
    expect(d.meta.errorCount).toBe(1);
    expect(d.meta.outcome).toBe('completed');
    expect(d.surfacedToolFailures).toEqual([{ tool: 'Bash', label: 'bun test', detail: undefined }]);
  });

  it('human-takeover (punt to AskUserQuestion after a failure) → errored, not completed', () => {
    const d = buildSessionDetail(traj([
      step(1, 'Bash', 'error', 'bun test'),
      step(2, 'AskUserQuestion', 'ok', 'which fix do you want?'),
    ]));
    expect(d.meta.outcome).toBe('errored');
  });

  it('an incidental success does not rescue a run that ends unresolved → errored', () => {
    const d = buildSessionDetail(traj([
      step(1, 'Bash', 'ok', 'ls'),
      step(2, 'Bash', 'error', 'bun test'),
    ]));
    expect(d.meta.outcome).toBe('errored');
  });

  it('an incidental later success of unrelated work does not rescue the failure → errored', () => {
    const d = buildSessionDetail(traj([
      step(1, 'Bash', 'error', 'bun test', 'bun'),
      step(2, 'Bash', 'ok', 'ls', 'ls'),
    ]));
    expect(d.meta.errorCount).toBe(1);
    expect(d.meta.outcome).toBe('errored');
  });

  it('a genuine retry of the failed work after the error → completed', () => {
    const d = buildSessionDetail(traj([
      step(1, 'Bash', 'error', 'bun test', 'bun'),
      step(2, 'Edit', 'ok', 'fix the bug'),
      step(3, 'Bash', 'ok', 'bun test', 'bun'),
    ]));
    expect(d.meta.outcome).toBe('completed');
  });

  it('a failed non-shell tool resolved by the same tool → completed', () => {
    const d = buildSessionDetail(traj([
      step(1, 'Edit', 'error', 'old string not found'),
      step(2, 'Read', 'ok', 'read the file to find the real string'),
      step(3, 'Edit', 'ok', 'apply the corrected edit'),
    ]));
    expect(d.meta.outcome).toBe('completed');
  });

  it('a failed tool followed only by an unrelated different tool → errored', () => {
    const d = buildSessionDetail(traj([
      step(1, 'Edit', 'error', 'old string not found'),
      step(2, 'Read', 'ok', 'read the file'),
    ]));
    expect(d.meta.outcome).toBe('errored');
  });

  it('a clean run with zero errors is completed', () => {
    const d = buildSessionDetail(traj([step(1, 'Read', 'ok', 'read'), step(2, 'Edit', 'ok', 'write')]));
    expect(d.meta.outcome).toBe('completed');
    expect(d.surfacedToolFailures).toEqual([]);
  });
});

describe('phenotype grouping across the incremental boundary (PHNX-3327)', () => {
  const transcriptA = path.join(import.meta.dirname, '../session/testdata/codex-fixture.jsonl');
  const sessA = 'phenotype-boundary-a';
  const sessB = 'phenotype-boundary-b';

  function insertSessionRow(sessionId: string, mtimeMs: number, size: number): SyncRow {
    const db = getDB();
    db.prepare(`
      INSERT INTO sessions
        (id, short_id, agent, timestamp, project, cwd, git_branch, label, duration_ms,
         model, file_path, file_mtime_ms, file_size, machine)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId, sessionId.slice(0, 8), 'codex', '2026-08-25T00:00:00.000Z', 'agents-cli',
      '/redacted/agents-cli', 'main', 'Boundary test', 9000, 'gpt-test',
      transcriptA, mtimeMs, size, 'test-device',
    );
    db.prepare(`
      INSERT INTO tool_calls
        (call_key, session_id, ordinal, timestamp, tool, input, outcome, exit_code, error, evidence_bytes)
      VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, 0)
    `).run(`${sessionId}-call`, sessionId, 1, '2026-08-25T00:00:00.000Z', 'exec_command', 'error', 1, 'command failed');
    return { ...row(mtimeMs, size), id: sessionId, short_id: sessionId.slice(0, 8), file_path: transcriptA };
  }

  beforeEach(() => {
    const db = getDB();
    for (const sessionId of [sessA, sessB]) {
      for (const table of ['tool_calls', 'session_topics', 'session_insights', 'session_phenotypes']) {
        db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
      }
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    }
  });

  it('folds two identically-signatured sessions into ONE cluster across separate syncs', async () => {
    const { readSessionPhenotypes } = await import('../session/db.js');
    const stat = fs.statSync(transcriptA);
    const rowA = insertSessionRow(sessA, stat.mtimeMs, stat.size);
    const rowB = insertSessionRow(sessB, stat.mtimeMs, stat.size);

    const first = buildIndexShard([rowA], 'test-device', 'owner-1');
    expect(first.failurePatterns).toHaveLength(1);
    const cachedA = readSessionPhenotypes<string | null>([sessA]);
    expect(cachedA.has(sessA)).toBe(true);

    const rowAUnreadable: SyncRow = { ...rowA, file_path: '/nonexistent/gone.jsonl' };
    const second = buildIndexShard([rowAUnreadable, rowB], 'test-device', 'owner-1');

    const shared = second.failurePatterns.filter(
      (p) => p.signature.tool === 'exec_command' && p.signature.key === 'command failed',
    );
    expect(shared).toHaveLength(1);
    expect(shared[0].sessions).toBe(2);
    expect(shared[0].occurrences).toBe(2);
    expect(shared[0].phenotype).toBe(cachedA.get(sessA));
  });
});

describe('index.sessions roster (PHNX-3483)', () => {
  const percentile = (values: number[], ratio: number): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
  };

  type Fixture = {
    id: string;
    durationMs: number | null;
    messageCount: number;
    okCalls: number;
    errorCalls: number;
    label?: string;
    project?: string;
    cwd?: string;
    agent?: string;
    model?: string;
  };

  const FIX_MTIME = 4242;
  const FIX_SIZE = 424;

  function seed(fx: Fixture): SyncRow {
    const db = getDB();
    const agent = fx.agent ?? 'codex';
    const project = fx.project ?? 'agents-cli';
    const cwd = fx.cwd ?? '/redacted/agents-cli';
    const label = fx.label ?? `Session ${fx.id}`;
    const model = fx.model ?? 'gpt-test';
    const ts = '2026-08-25T00:00:00.000Z';
    db.prepare(`
      INSERT INTO sessions
        (id, short_id, agent, timestamp, project, cwd, git_branch, label, duration_ms,
         model, file_path, file_mtime_ms, file_size, machine)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fx.id, fx.id.slice(0, 8), agent, ts, project, cwd, 'main', label, fx.durationMs,
      model, '/nonexistent/roster.jsonl', FIX_MTIME, FIX_SIZE, 'test-device',
    );
    const insertCall = db.prepare(`
      INSERT INTO tool_calls
        (call_key, session_id, ordinal, timestamp, tool, input, outcome, exit_code, error, evidence_bytes)
      VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, 0)
    `);
    let ordinal = 0;
    for (let i = 0; i < fx.okCalls; i++) {
      ordinal++;
      insertCall.run(`${fx.id}-ok-${i}`, fx.id, ordinal, ts, 'Read', 'ok', null, null);
    }
    for (let i = 0; i < fx.errorCalls; i++) {
      ordinal++;
      insertCall.run(`${fx.id}-err-${i}`, fx.id, ordinal, ts, 'exec_command', 'error', 1, 'command failed');
    }
    db.prepare(`
      INSERT INTO session_insights
        (session_id, file_mtime_ms, file_size, extractor_version, computed_at, facets)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(fx.id, FIX_MTIME, FIX_SIZE, INSIGHTS_EXTRACTOR_VERSION, Date.now(),
      JSON.stringify({ frictionSignals: {}, correctionSignals: {} }));
    return {
      id: fx.id, short_id: fx.id.slice(0, 8), agent, origin: 'cli', routine_name: null,
      routine_run_id: null, version: null, account: null, account_key: null,
      account_org: null, mode: 'auto', timestamp: ts, last_activity: null,
      project, cwd, git_branch: 'main', topic: null, label,
      message_count: fx.messageCount, token_count: null, output_tokens: null,
      input_tokens: null, cache_read_tokens: null, cache_write_tokens: null,
      cost_usd: null, cost_usd_nocache: null, duration_ms: fx.durationMs, model,
      tool_call_count: fx.okCalls + fx.errorCalls, file_path: '/nonexistent/roster.jsonl',
      file_mtime_ms: FIX_MTIME, file_size: FIX_SIZE, machine: 'test-device',
    };
  }

  const FIXTURES: Fixture[] = [
    { id: 'roster-h1', durationMs: 10_000, messageCount: 3, okCalls: 1, errorCalls: 0 },
    { id: 'roster-h2', durationMs: 30_000, messageCount: 3, okCalls: 0, errorCalls: 1 },
    { id: 'roster-h3', durationMs: 20_000, messageCount: 3, okCalls: 2, errorCalls: 0 },
    { id: 'roster-i1', durationMs: 4_000, messageCount: 5, okCalls: 0, errorCalls: 0 },
    { id: 'roster-i2', durationMs: 8_000, messageCount: 5, okCalls: 0, errorCalls: 0 },
  ];

  const NULL_FIX: Fixture = { id: 'roster-null', durationMs: null, messageCount: 3, okCalls: 1, errorCalls: 0 };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'));
    const db = getDB();
    for (const fx of [...FIXTURES, NULL_FIX]) {
      for (const table of ['tool_calls', 'session_topics', 'session_insights', 'session_phenotypes']) {
        db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(fx.id);
      }
      db.prepare('DELETE FROM sessions WHERE id = ?').run(fx.id);
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits one flat scalar row per agent session with the contracted fields', () => {
    const rows = FIXTURES.map(seed);
    const shard = buildIndexShard(rows, 'test-device', 'owner-1');

    expect(shard.sessions).toBeDefined();
    expect(shard.sessions).toHaveLength(rows.length);
    expect(shard.sessions).toHaveLength(shard.stats.sessionsImported);

    for (const s of shard.sessions!) {
      expect(typeof s.id).toBe('string');
      expect(typeof s.title).toBe('string');
      expect(typeof s.harness).toBe('string');
      expect(typeof s.model).toBe('string');
      expect(typeof s.repo).toBe('string');
      expect(['interactive', 'headless']).toContain(s.mode);
      expect(['code', 'research', 'review', 'content', 'ops']).toContain(s.projectType);
      expect(typeof s.startedAt).toBe('number');
      expect(typeof s.durationMs).toBe('number');
      expect(typeof s.toolCount).toBe('number');
      expect(typeof s.errorCount).toBe('number');
      expect(typeof s.needsAttention).toBe('boolean');
    }

    const h2 = shard.sessions!.find((s) => s.id === 'roster-h2')!;
    expect(h2.harness).toBe('codex');
    expect(h2.model).toBe('gpt-test');
    expect(h2.repo).toBe('agents-cli');
    expect(h2.mode).toBe('headless');
    expect(h2.errorCount).toBe(1);
    expect(h2.toolCount).toBe(1);
  });

  it('mode-split medians of the roster reproduce agentMedianMs (headless) and interactiveMedianMs', () => {
    const rows = FIXTURES.map(seed);
    const shard = buildIndexShard(rows, 'test-device', 'owner-1');

    const headless = shard.sessions!.filter((s) => s.mode === 'headless').map((s) => s.durationMs);
    const interactive = shard.sessions!.filter((s) => s.mode === 'interactive').map((s) => s.durationMs);

    expect(headless).toHaveLength(3);
    expect(interactive).toHaveLength(2);

    expect(percentile(headless, 0.5)).toBe(shard.stats.agentMedianMs);
    expect(percentile(interactive, 0.5)).toBe(shard.stats.interactiveMedianMs);
  });

  it('needsAttention booleans match the ids in the shard needsAttention set', () => {
    const rows = FIXTURES.map(seed);
    const shard = buildIndexShard(rows, 'test-device', 'owner-1');

    const flagged = new Set(shard.needsAttention.map((s) => s.id));
    for (const s of shard.sessions!) {
      expect(s.needsAttention).toBe(flagged.has(s.id));
    }
    expect(shard.sessions!.find((s) => s.id === 'roster-h2')!.needsAttention).toBe(true);
    expect(shard.sessions!.find((s) => s.id === 'roster-h1')!.needsAttention).toBe(false);
  });

  it('carries an unmeasured (null-duration) session at durationMs 0, excluded from the segmented medians', () => {
    const rows = [...FIXTURES, NULL_FIX].map(seed);
    const shard = buildIndexShard(rows, 'test-device', 'owner-1');

    expect(shard.sessions).toHaveLength(rows.length);
    expect(shard.sessions).toHaveLength(shard.stats.sessionsImported);
    const nullRow = shard.sessions!.find((s) => s.id === 'roster-null')!;
    expect(nullRow.durationMs).toBe(0);
    expect(nullRow.mode).toBe('headless');

    expect(shard.stats.agentMedianMs).toBe(percentile([10_000, 30_000, 20_000], 0.5));
    const rawHeadless = shard.sessions!.filter((s) => s.mode === 'headless').map((s) => s.durationMs);
    expect(rawHeadless).toContain(0);
    expect(percentile(rawHeadless, 0.5)).not.toBe(shard.stats.agentMedianMs);
    expect(percentile(rawHeadless.filter((d) => d > 0), 0.5)).toBe(shard.stats.agentMedianMs);
  });

  it('promotes a real silent-stall friction facet into a behavioral failurePattern (RUSH-2988)', () => {
    const row = seed({ id: 'roster-h1', durationMs: 10_000, messageCount: 3, okCalls: 1, errorCalls: 0 });
    getDB().prepare('UPDATE session_insights SET facets = ? WHERE session_id = ?')
      .run(JSON.stringify({ frictionSignals: { 'silent stall: 15-60m': 1 }, correctionSignals: {} }), 'roster-h1');

    const shard = buildIndexShard([row], 'test-device', 'owner-1');
    const behavioral = shard.failurePatterns.find((p) => p.signature.cause === 'behavioral');
    expect(behavioral).toBeDefined();
    expect(behavioral!.signature).toEqual({ tool: 'silent-stall', cause: 'behavioral', key: '15-60m' });
    expect(behavioral!.sessions).toBe(1);
    expect(behavioral!.occurrences).toBe(1);
    expect(behavioral!.wastedMs).toBe(30 * 60_000);
    expect(shard.wastedMsTotal).toBeGreaterThanOrEqual(behavioral!.wastedMs);
    expect(shard.failures.byCause.behavioral).toBe(0);
  });
});

describe('traces sync --dry-run local export', () => {
  const dryId = 'trace-dryrun-fixture';
  const dryTranscript = path.join(import.meta.dirname, '../session/testdata/codex-fixture.jsonl');

  beforeEach(() => {
    const db = getDB();
    for (const table of ['tool_calls', 'session_topics', 'session_insights']) {
      db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(dryId);
    }
    db.prepare('DELETE FROM sessions WHERE id = ?').run(dryId);
  });

  it('requires --out', async () => {
    await expect(syncTraces({ dryRun: true })).rejects.toThrow(/--out/);
  });

  it('writes shards locally with no backend and never touches the ledger', async () => {
    const stat = fs.statSync(dryTranscript);
    const db = getDB();
    db.prepare(`
      INSERT INTO sessions
        (id, short_id, agent, timestamp, project, cwd, git_branch, label, duration_ms,
         model, file_path, file_mtime_ms, file_size, machine)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      dryId, 'trace-dr', 'codex', '2026-08-25T00:00:00.000Z', 'agents-cli',
      '/home/x/agents-cli', 'main', 'Fix dry run', 9000, 'gpt-test',
      dryTranscript, stat.mtimeMs, stat.size, 'dry-device',
    );
    db.prepare(`
      INSERT INTO tool_calls
        (call_key, session_id, ordinal, timestamp, tool, input, outcome, exit_code, error, evidence_bytes)
      VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, 0)
    `).run('dry-call-1', dryId, 1, '2026-08-25T00:00:00.000Z', 'exec_command', 'error', 1, 'command failed');

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traces-dry-'));
    const ledgerPath = path.join(getRuntimeStateDir(), 'traces-sync.json');
    fs.rmSync(ledgerPath, { force: true });
    delete process.env.AGENTS_TRACES_BASE_URL;
    delete process.env.AGENTS_TRACES_WRITE_TOKEN;
    process.env.AGENTS_SYNC_MACHINE_ID = 'dry-device';
    try {
      const result = await syncTraces({ dryRun: true, outDir });
      expect(result.uploaded).toBeGreaterThan(0);

      const index = JSON.parse(fs.readFileSync(path.join(outDir, 'index.json'), 'utf8'));
      expect(index.schema).toBe(1);
      expect(index.owner).toBe('local');
      expect(index.stats.sessionsImported).toBeGreaterThan(0);

      const detail = JSON.parse(fs.readFileSync(path.join(outDir, 'sessions', `${dryId}.json`), 'utf8'));
      expect(detail.schema).toBe(2);
      expect(detail.meta).toHaveProperty('spanMs');
      expect(detail).toHaveProperty('whereItWentWrong');
      expect(detail.meta.repo).toBe('agents-cli');

      expect(fs.existsSync(ledgerPath)).toBe(false);
    } finally {
      delete process.env.AGENTS_SYNC_MACHINE_ID;
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('traces sync failure retry ledger (PHNX-3267)', () => {
  const realTranscript = path.join(import.meta.dirname, '../session/testdata/codex-fixture.jsonl');
  const ids = ['retry-a', 'retry-b', 'retry-c-gone', 'retry-d-ok'];
  const ledgerPath = path.join(getRuntimeStateDir(), 'traces-sync.json');

  function insertSession(sessionId: string, mtimeMs: number, filePath: string): void {
    const db = getDB();
    db.prepare(`
      INSERT INTO sessions
        (id, short_id, agent, timestamp, project, cwd, git_branch, label, duration_ms,
         model, file_path, file_mtime_ms, file_size, machine)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId, sessionId.slice(0, 8), 'codex', '2026-08-25T00:00:00.000Z', 'agents-cli',
      '/home/x/agents-cli', 'main', 'Retry test', 9000, 'gpt-test',
      filePath, mtimeMs, 100, 'retry-device',
    );
  }

  beforeEach(() => {
    const db = getDB();
    for (const table of ['tool_calls', 'session_topics', 'session_insights']) {
      for (const sessionId of ids) db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
    }
    for (const sessionId of ids) db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    fs.rmSync(ledgerPath, { force: true });
  });

  afterEach(() => {
    delete process.env.AGENTS_TRACES_BASE_URL;
    delete process.env.AGENTS_TRACES_WRITE_TOKEN;
    delete process.env.AGENTS_SYNC_MACHINE_ID;
  });

  it('retries an upload-failed session stranded below the watermark, then a stable sync uploads zero', async () => {
    insertSession('retry-a', 1000, realTranscript);
    insertSession('retry-b', 2000, realTranscript);

    let failA = true;
    const puts: string[] = [];
    const server = http.createServer((req, res) => {
      if (req.method === 'PUT') puts.push(req.url ?? '');
      req.resume();
      if (req.method === 'PUT' && failA && req.url?.includes('/sessions/retry-a.json')) {
        res.writeHead(500).end('boom');
      } else {
        res.writeHead(200).end('ok');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no TCP address');
    process.env.AGENTS_TRACES_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.AGENTS_TRACES_WRITE_TOKEN = 'test-token';
    process.env.AGENTS_SYNC_MACHINE_ID = 'retry-device';
    try {
      const first = await syncTraces({ skipIndex: true });
      expect(first.uploaded).toBe(1);
      expect(first.uploadFailed).toBe(1);
      expect(first.errors).toBe(1);
      const afterFirst = readSyncLedger();
      expect(afterFirst.lastSyncMtime).toBe(2000);
      const stranded = (afterFirst.failures ?? []).find((f) => f.id === 'retry-a');
      expect(stranded?.kind).toBe('upload-failed');
      expect(stranded?.detail).toContain('500');

      failA = false;
      puts.length = 0;
      const second = await syncTraces({ skipIndex: true });
      expect(puts.some((u) => u.includes('/sessions/retry-a.json'))).toBe(true);
      expect(second.uploaded).toBe(1);
      expect(second.uploadFailed).toBe(0);
      expect((readSyncLedger().failures ?? [])).toHaveLength(0);

      puts.length = 0;
      const third = await syncTraces({ skipIndex: true });
      expect(third.uploaded).toBe(0);
      expect(third.errors).toBe(0);
      expect(puts).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it('classifies a missing transcript as unavailable and does not re-query it once past the watermark', async () => {
    insertSession('retry-c-gone', 1000, '/nonexistent/path/gone.jsonl');
    insertSession('retry-d-ok', 2000, realTranscript);

    const puts: string[] = [];
    const server = http.createServer((req, res) => {
      if (req.method === 'PUT') puts.push(req.url ?? '');
      req.resume();
      res.writeHead(200).end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no TCP address');
    process.env.AGENTS_TRACES_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.AGENTS_TRACES_WRITE_TOKEN = 'test-token';
    process.env.AGENTS_SYNC_MACHINE_ID = 'retry-device';
    try {
      const first = await syncTraces({ skipIndex: true });
      expect(first.transcriptUnavailable).toBe(1);
      expect(first.uploadFailed).toBe(0);
      expect(first.parseFailed).toBe(0);
      expect(first.uploaded).toBe(1);
      const recorded = (readSyncLedger().failures ?? []).find((f) => f.id === 'retry-c-gone');
      expect(recorded?.kind).toBe('transcript-unavailable');

      puts.length = 0;
      const second = await syncTraces({ skipIndex: true });
      expect(second.uploaded).toBe(0);
      expect(second.transcriptUnavailable).toBe(0);
      expect(puts).toHaveLength(0);
      expect((readSyncLedger().failures ?? []).some((f) => f.id === 'retry-c-gone')).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });
});

describe('active-time duration stats (PHNX-3457)', () => {
  const IDS = ['dur-idle', 'dur-busy', 'dur-abandoned', 'dur-nocalls'];

  function durRow(rowId: string, durationMs: number, extra: Partial<SyncRow> = {}): SyncRow {
    return {
      id: rowId, short_id: rowId.slice(0, 8), agent: 'rush', origin: 'cli', routine_name: null,
      routine_run_id: null, version: null, account: null, account_key: null, account_org: null,
      mode: 'auto', timestamp: '2026-08-25T00:00:00.000Z', last_activity: '2026-08-25T00:10:00.000Z',
      project: 'agents-cli', cwd: '/redacted/agents-cli', git_branch: 'main', topic: 'fix a bug',
      label: null, message_count: null, token_count: null, output_tokens: null, input_tokens: null,
      cache_read_tokens: null, cache_write_tokens: null, cost_usd: null, cost_usd_nocache: null,
      duration_ms: durationMs, model: 'rush-test', tool_call_count: 2,
      file_path: '/nonexistent/no-transcript.jsonl', file_mtime_ms: 1, file_size: 1,
      machine: 'test-device', ...extra,
    };
  }

  function insertCall(sid: string, ordinal: number, ts: string, endTs: string | null) {
    getDB().prepare(`
      INSERT INTO tool_calls (call_key, session_id, ordinal, timestamp, end_timestamp, tool, input, outcome, exit_code, error, evidence_bytes)
      VALUES (?, ?, ?, ?, ?, 'Bash', '{}', 'ok', 0, null, 0)
    `).run(`${sid}-${ordinal}`, sid, ordinal, ts, endTs);
  }

  beforeEach(() => {
    const db = getDB();
    for (const rid of IDS) {
      db.prepare('DELETE FROM tool_calls WHERE session_id = ?').run(rid);
      db.prepare('DELETE FROM session_topics WHERE session_id = ?').run(rid);
      db.prepare('DELETE FROM session_phenotypes WHERE session_id = ?').run(rid);
    }
  });

  it('strips an idle gap between two tool calls from the duration median', () => {
    insertCall('dur-idle', 1, '2026-08-25T00:00:00.000Z', null);
    insertCall('dur-idle', 2, '2026-08-25T00:06:40.000Z', '2026-08-25T00:10:00.000Z');
    const shard = buildIndexShard([durRow('dur-idle', 600_000)], 'test-device', 'owner-1');
    expect(shard.stats.medianMs).toBe(200_000);
    expect(shard.stats.p90Ms).toBe(200_000);
  });

  it('leaves a busy session (no gap > 120s, last call ends at span end) with active == span', () => {
    insertCall('dur-busy', 1, '2026-08-25T00:00:00.000Z', null);
    insertCall('dur-busy', 2, '2026-08-25T00:00:30.000Z', '2026-08-25T00:03:20.000Z');
    const shard = buildIndexShard([durRow('dur-busy', 200_000)], 'test-device', 'owner-1');
    expect(shard.stats.medianMs).toBe(200_000);
  });

  it('measures an idle gap from a call END, not its start, when end_timestamp is known', () => {
    insertCall('dur-idle', 1, '2026-08-25T00:00:00.000Z', '2026-08-25T00:05:00.000Z');
    insertCall('dur-idle', 2, '2026-08-25T00:08:00.000Z', '2026-08-25T00:10:00.000Z');
    const shard = buildIndexShard([durRow('dur-idle', 600_000)], 'test-device', 'owner-1');
    expect(shard.stats.medianMs).toBe(420_000);
  });

  it('strips TRAILING idle: a lone call then a 10h abandonment (the case a between-calls-only measure missed)', () => {
    insertCall('dur-abandoned', 1, '2026-08-25T00:00:30.000Z', '2026-08-25T00:00:30.000Z');
    const tenHours = 10 * 60 * 60_000;
    const shard = buildIndexShard([durRow('dur-abandoned', tenHours)], 'test-device', 'owner-1');
    expect(shard.stats.medianMs).toBe(30_000);
  });

  it('returns the full span for a session with NO tool calls (never a fabricated zero)', () => {
    const shard = buildIndexShard([durRow('dur-nocalls', 600_000)], 'test-device', 'owner-1');
    expect(shard.stats.medianMs).toBe(600_000);
  });
});

describe('segmented agent vs interactive duration stats (PHNX-3472)', () => {
  const IDS = ['seg-agent-1', 'seg-agent-2', 'seg-agent-msgs', 'seg-int-1', 'seg-int-2', 'seg-nodur'];

  function segRow(rowId: string, durationMs: number | null, extra: Partial<SyncRow> = {}): SyncRow {
    return {
      id: rowId, short_id: rowId.slice(0, 8), agent: 'rush', origin: 'cli', routine_name: null,
      routine_run_id: null, version: null, account: null, account_key: null, account_org: null,
      mode: 'auto', timestamp: '2026-08-25T00:00:00.000Z', last_activity: '2026-08-25T00:15:00.000Z',
      project: 'agents-cli', cwd: '/redacted/agents-cli', git_branch: 'main', topic: 'fix a bug',
      label: null, message_count: null, token_count: null, output_tokens: null, input_tokens: null,
      cache_read_tokens: null, cache_write_tokens: null, cost_usd: null, cost_usd_nocache: null,
      duration_ms: durationMs, model: 'rush-test', tool_call_count: null,
      file_path: '/nonexistent/no-transcript.jsonl', file_mtime_ms: 1, file_size: 1,
      machine: 'test-device', ...extra,
    };
  }

  function insertSpanningCall(sid: string, endTs: string) {
    getDB().prepare(`
      INSERT INTO tool_calls (call_key, session_id, ordinal, timestamp, end_timestamp, tool, input, outcome, exit_code, error, evidence_bytes)
      VALUES (?, ?, 1, '2026-08-25T00:00:00.000Z', ?, 'Bash', '{}', 'ok', 0, null, 0)
    `).run(`${sid}-1`, sid, endTs);
  }

  beforeEach(() => {
    const db = getDB();
    for (const rid of IDS) {
      db.prepare('DELETE FROM tool_calls WHERE session_id = ?').run(rid);
      db.prepare('DELETE FROM session_topics WHERE session_id = ?').run(rid);
      db.prepare('DELETE FROM session_phenotypes WHERE session_id = ?').run(rid);
    }
  });

  it('segments agent runs (tool calls or >8 msgs) from one-shot interactive queries, and reports coverage', () => {
    insertSpanningCall('seg-agent-1', '2026-08-25T00:15:00.000Z');
    insertSpanningCall('seg-agent-2', '2026-08-25T00:15:00.000Z');
    const shard = buildIndexShard([
      segRow('seg-agent-1', 900_000, { message_count: 2 }),
      segRow('seg-agent-2', 900_000, { message_count: 3 }),
      segRow('seg-agent-msgs', 600_000, { message_count: 12, last_activity: '2026-08-25T00:10:00.000Z' }),
      segRow('seg-int-1', 15_000, { message_count: 4, last_activity: '2026-08-25T00:00:15.000Z' }),
      segRow('seg-int-2', 15_000, { message_count: 5, last_activity: '2026-08-25T00:00:15.000Z' }),
      segRow('seg-nodur', null, { message_count: 12 }),
    ], 'test-device', 'owner-1');

    expect(shard.stats.agentMedianMs).toBe(900_000);
    expect(shard.stats.interactiveMedianMs).toBe(15_000);
    expect(shard.stats.agentMedianMs).toBeGreaterThan(shard.stats.interactiveMedianMs * 10);
    expect(shard.stats.agentP90Ms).toBe(900_000);
    expect(shard.stats.measuredFraction).toBeCloseTo(5 / 6, 10);
  });
});

describe('topic session refs for treemap drill-down (PHNX-3408)', () => {
  function topicRow(rowId: string, label: string, recency: string): SyncRow {
    return {
      id: rowId, short_id: rowId.slice(0, 8), agent: 'rush', origin: 'cli', routine_name: null,
      routine_run_id: null, version: null, account: null, account_key: null, account_org: null,
      mode: 'auto', timestamp: '2026-08-25T00:00:00.000Z', last_activity: recency,
      project: 'agents-cli', cwd: '/redacted/agents-cli', git_branch: 'fix/bug', topic: 'fix the bug',
      label, message_count: null, token_count: null, output_tokens: null, input_tokens: null,
      cache_read_tokens: null, cache_write_tokens: null, cost_usd: null, cost_usd_nocache: null,
      duration_ms: 1000, model: 'rush-test', tool_call_count: 2,
      file_path: '/nonexistent/no-transcript.jsonl', file_mtime_ms: 1, file_size: 1,
      machine: 'test-device',
    };
  }

  beforeEach(() => {
    const db = getDB();
    for (const rid of ['topic-a', 'topic-b']) {
      db.prepare('DELETE FROM session_topics WHERE session_id = ?').run(rid);
      db.prepare('DELETE FROM session_phenotypes WHERE session_id = ?').run(rid);
    }
  });

  it('emits {id,title} refs per topic, most-recent first, titled by label', () => {
    const shard = buildIndexShard([
      topicRow('topic-a', 'Older fix', '2026-08-25T00:01:00.000Z'),
      topicRow('topic-b', 'Newer fix', '2026-08-25T00:09:00.000Z'),
    ], 'test-device', 'owner-1');

    const withRefs = shard.topics.find((t) => t.sessions.length > 0);
    expect(withRefs).toBeDefined();
    expect(withRefs!.count).toBe(2);
    expect(withRefs!.sessions).toEqual([
      { id: 'topic-b', title: 'Newer fix', kind: 'agent', harness: 'rush' },
      { id: 'topic-a', title: 'Older fix', kind: 'agent', harness: 'rush' },
    ]);
  });

  it('caps the ref list at 30 while keeping the true count', () => {
    const rows: SyncRow[] = [];
    for (let i = 0; i < 45; i++) {
      const mm = String(i).padStart(2, '0');
      rows.push(topicRow(`topic-${i}`, `fix ${i}`, `2026-08-25T00:${mm}:00.000Z`));
    }
    const db = getDB();
    for (let i = 0; i < 45; i++) db.prepare('DELETE FROM session_topics WHERE session_id = ?').run(`topic-${i}`);

    const shard = buildIndexShard(rows, 'test-device', 'owner-1');
    const bucket = shard.topics.find((t) => t.sessions.length > 0)!;
    expect(bucket.count).toBe(45);
    expect(bucket.sessions).toHaveLength(30);
    expect(bucket.sessions[0].id).toBe('topic-44');
  });
});

describe('utility-call classification excludes internal plumbing (PHNX-3474)', () => {
  const IDS = ['u-title', 'u-watch', 'u-commit', 'u-shape', 'a-real'];

  function kindRow(rowId: string, agent: string, extra: Partial<SyncRow>): SyncRow {
    return {
      id: rowId, short_id: rowId.slice(0, 8), agent, origin: 'cli', routine_name: null,
      routine_run_id: null, version: null, account: null, account_key: null, account_org: null,
      mode: 'auto', timestamp: '2026-08-25T00:00:00.000Z', last_activity: '2026-08-25T00:10:00.000Z',
      project: 'agents-cli', cwd: '/redacted/agents-cli', git_branch: 'main', topic: null,
      label: null, message_count: null, token_count: null, output_tokens: null, input_tokens: null,
      cache_read_tokens: null, cache_write_tokens: null, cost_usd: null, cost_usd_nocache: null,
      duration_ms: 5_000, model: 'test-model', tool_call_count: null,
      file_path: '/nonexistent/no-transcript.jsonl', file_mtime_ms: 1, file_size: 1,
      machine: 'test-device', ...extra,
    };
  }

  beforeEach(() => {
    const db = getDB();
    for (const rid of IDS) {
      db.prepare('DELETE FROM tool_calls WHERE session_id = ?').run(rid);
      db.prepare('DELETE FROM session_topics WHERE session_id = ?').run(rid);
      db.prepare('DELETE FROM session_phenotypes WHERE session_id = ?').run(rid);
      db.prepare('DELETE FROM session_insights WHERE session_id = ?').run(rid);
    }
  });

  it('classifies the single-shot and signature rows utility, and the tool-using row agent', () => {
    expect(classifySessionKind({ topic: 'Generate a 3-4 word title for this chat', label: null, message_count: 2, tool_call_count: null }, 0)).toBe('utility');
    expect(classifySessionKind({ topic: null, label: 'You are a watchdog monitoring agent sessions', message_count: 1, tool_call_count: null }, 0)).toBe('utility');
    expect(classifySessionKind({ topic: 'Write a conventional-commit message', label: null, message_count: 1, tool_call_count: null }, 0)).toBe('utility');
    expect(classifySessionKind({ topic: 'quick question', label: null, message_count: 2, tool_call_count: null }, 0)).toBe('utility');
    expect(classifySessionKind({ topic: 'FACTORY WORKER: build the widget', label: null, message_count: 40, tool_call_count: 12 }, 12)).toBe('utility');
    expect(classifySessionKind({ topic: 'fix the bug', label: null, message_count: 20, tool_call_count: 3 }, 3)).toBe('agent');
    expect(classifySessionKind({ topic: 'discuss the design', label: null, message_count: 4, tool_call_count: null }, 0)).toBe('agent');
  });

  it('excludes utility rows from sessionsImported, the medians, and the topic buckets; reports utilityCount', () => {
    const db = getDB();
    db.prepare(`
      INSERT INTO tool_calls (call_key, session_id, ordinal, timestamp, end_timestamp, tool, input, outcome, exit_code, error, evidence_bytes)
      VALUES (?, ?, 1, '2026-08-25T00:00:00.000Z', '2026-08-25T00:10:00.000Z', 'Bash', '{}', 'ok', 0, null, 0)
    `).run('a-real-1', 'a-real');

    const shard = buildIndexShard([
      kindRow('u-title', 'claude', { topic: 'Generate a 3-4 word title for this conversation', message_count: 2 }),
      kindRow('u-watch', 'claude', { label: 'You are a watchdog monitoring stalled agents', message_count: 1 }),
      kindRow('u-commit', 'claude', { topic: 'Draft a conventional-commit subject line', message_count: 1 }),
      kindRow('u-shape', 'claude', { topic: 'single-shot machine call', message_count: 2 }),
      kindRow('a-real', 'codex', { topic: 'fix the bug', git_branch: 'fix/bug', message_count: 20, tool_call_count: 3, duration_ms: 600_000 }),
    ], 'test-device', 'owner-1');

    expect(shard.stats.sessionsImported).toBe(1);
    expect(shard.utilityCount).toBe(4);
    expect(shard.stats.medianMs).toBe(600_000);
    expect(shard.stats.agentMedianMs).toBe(600_000);
    expect(shard.stats.measuredFraction).toBe(1);

    const bucket = shard.topics.find((t) => t.sessions.length > 0)!;
    expect(bucket.sessions).toEqual([{ id: 'a-real', title: 'fix the bug', kind: 'agent', harness: 'codex' }]);
    expect(shard.topics.flatMap((t) => t.sessions.map((s) => s.id))).not.toContain('u-title');
  });
});
