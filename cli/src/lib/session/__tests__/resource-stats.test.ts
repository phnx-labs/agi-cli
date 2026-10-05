import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Set HOME before db.js loads so its module-level base dir picks up the
// override — same pattern as db.test.ts. Real SQLite, no mocking.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-resstats-'));
process.env.HOME = TEST_HOME;

const {
  getDB,
  queryResourceUsageStats,
  resourceUsageCoverage,
  backfillResourceUsage,
} = await import('../db.js');
const { diffZeroInvoked } = await import('../../../commands/sessions-stats.js');

const SEED_FILES_DIR = path.join(TEST_HOME, 'seed-files');
fs.mkdirSync(SEED_FILES_DIR, { recursive: true });

function seedSession(
  id: string,
  opts: { agent?: string; machine?: string; project?: string; timestamp?: string; filePath?: string } = {},
): void {
  const filePath = opts.filePath ?? path.join(SEED_FILES_DIR, `${id}.jsonl`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '');
  getDB().prepare(`
    INSERT INTO sessions (
      id, short_id, agent, version, timestamp, project, cwd, machine,
      file_path, file_mtime_ms, file_size, scanned_at, is_team_origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    id,
    id.slice(0, 8),
    opts.agent ?? 'claude',
    null,
    opts.timestamp ?? '2026-06-01T00:00:00.000Z',
    opts.project ?? 'proj',
    SEED_FILES_DIR,
    opts.machine ?? 'boxA',
    filePath,
    0,
    0,
    0,
  );
}

function seedUsage(
  sessionId: string,
  kind: string,
  name: string,
  opts: { plugin?: string; source?: string; count?: number } = {},
): void {
  getDB().prepare(`
    INSERT INTO session_resource_usage (session_id, kind, name, plugin, source, repo_root, snapshot_sha, count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, kind, name, opts.plugin ?? null, opts.source ?? null, null, null, opts.count ?? 1);
}

/** A minimal Claude transcript with two `Skill` calls and two slash commands. */
function backfillTranscript(): string {
  const lines = [
    { type: 'user', timestamp: '2026-06-28T00:00:00.000Z', cwd: '/home/u/repo', message: { role: 'user', content: 'run the teams skill' } },
    { type: 'assistant', timestamp: '2026-06-28T00:00:10.000Z', uuid: 'a-1', message: { id: 'msg_1', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'sk-1', name: 'Skill', input: { skill: 'teams' } }], usage: { input_tokens: 5, output_tokens: 5 } } },
    { type: 'user', timestamp: '2026-06-28T00:00:20.000Z', message: { role: 'user', content: '<command-message>recap</command-message>\n<command-name>/recap</command-name>' } },
    { type: 'assistant', timestamp: '2026-06-28T00:00:30.000Z', uuid: 'a-2', message: { id: 'msg_2', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'sk-2', name: 'Skill', input: { skill: 'teams' } }], usage: { input_tokens: 5, output_tokens: 5 } } },
    { type: 'assistant', timestamp: '2026-06-28T00:00:40.000Z', uuid: 'a-3', message: { id: 'msg_3', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'sc-1', name: 'SlashCommand', input: { command: '/code:commit fix the bug' } }], usage: { input_tokens: 5, output_tokens: 5 } } },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

// Session A + B are on claude/boxA; C on codex/boxB. Same skill 'teams' invoked
// in all three, plus per-session extras — enough to prove DISTINCT-session
// counting, invocation summing, source-merge dedup, ordering, and every filter.
beforeAll(() => {
  seedSession('sessA', { agent: 'claude', machine: 'boxA', timestamp: '2026-06-01T00:00:00.000Z' });
  seedSession('sessB', { agent: 'claude', machine: 'boxA', timestamp: '2026-06-10T00:00:00.000Z' });
  seedSession('sessC', { agent: 'codex', machine: 'boxB', timestamp: '2026-05-01T00:00:00.000Z' });

  seedUsage('sessA', 'skill', 'teams', { source: 'user', count: 2 });
  seedUsage('sessA', 'command', 'recap', { source: 'system', count: 1 });
  seedUsage('sessB', 'skill', 'teams', { source: 'system', count: 3 });
  seedUsage('sessB', 'skill', 'rush:design', { plugin: 'rush', source: 'rush', count: 1 });
  seedUsage('sessC', 'skill', 'teams', { source: 'user', count: 5 });

  // A session whose usage is derived by the backfill, from a real transcript.
  const bfPath = path.join(SEED_FILES_DIR, 'sessD.jsonl');
  fs.writeFileSync(bfPath, backfillTranscript());
  seedSession('sessD', { agent: 'claude', machine: 'boxA', project: 'bftest', timestamp: '2026-06-28T00:00:00.000Z', filePath: bfPath });
});

describe('queryResourceUsageStats — aggregate rollup', () => {
  it('counts DISTINCT sessions and SUMs invocations, merging the same resource across source layers', () => {
    const rows = queryResourceUsageStats({});
    const teams = rows.find(r => r.kind === 'skill' && r.name === 'teams');
    // 'teams' fired in A(2) + B(3) + C(5): one row, 3 distinct sessions, 10 invocations —
    // NOT split into user/system rows despite differing source layers.
    expect(teams).toBeDefined();
    expect(teams!.sessions).toBe(3);
    expect(teams!.invocations).toBe(10);
    // Every distinct resource identity is exactly one row.
    const names = rows.map(r => `${r.kind}:${r.name}`).sort();
    expect(names).toEqual(['command:recap', 'skill:rush:design', 'skill:teams']);
  });

  it('orders most-invoked first by default, least-invoked first with order:bottom', () => {
    const top = queryResourceUsageStats({});
    expect(top[0].name).toBe('teams'); // 10 invocations leads
    const bottom = queryResourceUsageStats({ order: 'bottom' });
    expect(bottom[bottom.length - 1].name).toBe('teams'); // 10 invocations trails
  });

  it('honors --top by returning only the first N ranked rows', () => {
    const rows = queryResourceUsageStats({ limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('teams');
  });

  it('filters to one kind', () => {
    const rows = queryResourceUsageStats({ kind: 'command' });
    expect(rows.map(r => r.name)).toEqual(['recap']);
  });

  it('filters to one plugin via pluginFilter (resource rows, not sessions)', () => {
    const rows = queryResourceUsageStats({ pluginFilter: 'rush' });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('rush:design');
    expect(rows[0].plugin).toBe('rush');
  });

  it('composes attribution filters (agent, machine, since) through buildSessionWhere', () => {
    // agent: exclude codex session C → teams drops to A+B.
    const byAgent = queryResourceUsageStats({ agent: 'claude' });
    expect(byAgent.find(r => r.name === 'teams')!.sessions).toBe(2);
    expect(byAgent.find(r => r.name === 'teams')!.invocations).toBe(5);

    // machine: only boxB (session C) → teams from C alone.
    const byMachine = queryResourceUsageStats({ machine: 'boxB' });
    expect(byMachine.find(r => r.name === 'teams')!.invocations).toBe(5);

    // since: only sessions after 2026-06-05 → just B.
    const bySince = queryResourceUsageStats({ sinceMs: Date.parse('2026-06-05T00:00:00.000Z') });
    expect(bySince.find(r => r.name === 'teams')!.sessions).toBe(1);
    expect(bySince.find(r => r.name === 'teams')!.invocations).toBe(3);
  });
});

describe('resourceUsageCoverage', () => {
  it('reports distinct sessions carrying the signal, sessions scanned, and total indexed', () => {
    const { covered, scanned, total } = resourceUsageCoverage();
    // A, B, C carry seeded usage; D was seeded WITHOUT a usage row (backfill fills it).
    expect(covered).toBe(3);
    expect(total).toBe(4);
    // No backfill has run in THIS describe yet, so no resource_scan_ledger rows —
    // scan coverage is 0 even though 3 sessions carry seeded usage. This is the
    // PHNX-2301 distinction: with-usage is not scan coverage.
    expect(scanned).toBe(0);
  });
});

describe('diffZeroInvoked — the both-ends dead-weight set', () => {
  it('returns installed resources whose identity never appears in the invoked rows, sorted', () => {
    const installed = [
      { kind: 'skill' as const, name: 'teams', plugin: null, source: 'user' },
      { kind: 'skill' as const, name: 'unused-skill', plugin: null, source: 'user' },
      { kind: 'command' as const, name: 'recap', plugin: null, source: 'system' },
      { kind: 'command' as const, name: 'unused-cmd', plugin: null, source: 'system' },
      { kind: 'skill' as const, name: 'rush:design', plugin: 'rush', source: 'rush' },
    ];
    const invoked = queryResourceUsageStats({}); // teams, recap, rush:design
    const zero = diffZeroInvoked(installed, invoked);
    expect(zero.map(r => `${r.kind}:${r.name}`)).toEqual(['command:unused-cmd', 'skill:unused-skill']);
  });
});

describe('backfillResourceUsage — historical one-shot, idempotent + fail-loud on a truncated read', () => {
  function rowsFor(id: string): Array<{ kind: string; name: string; count: number }> {
    return getDB()
      .prepare(`SELECT kind, name, count FROM session_resource_usage WHERE session_id = ? ORDER BY kind, name`)
      .all(id) as Array<{ kind: string; name: string; count: number }>;
  }

  it('derives usage from a real transcript, PRESERVES rows behind empty/truncated files, and skips on rerun', () => {
    // Run over the whole seeded set: D has a real transcript; A/B/C have seeded
    // usage rows but EMPTY on-disk files (parse to zero events).
    const first = backfillResourceUsage({});
    expect(first.scanned).toBe(4);       // A, B, C, D all have a transcript path
    expect(first.updated).toBe(1);       // only D re-parsed to real events
    expect(first.resourceRows).toBe(3);  // teams(skill) + recap + code:commit(commands)
    expect(first.failed).toBe(3);        // A, B, C parse to [] → skipped as failed, NOT wiped

    expect(rowsFor('sessD')).toEqual([
      { kind: 'command', name: 'code:commit', count: 1 },
      { kind: 'command', name: 'recap', count: 1 },
      { kind: 'skill', name: 'teams', count: 2 },
    ]);

    // The guard's whole point: sessA's seeded usage SURVIVED a backfill pass over
    // its empty file — writeResourceUsage would have DELETE'd it to nothing.
    expect(rowsFor('sessA')).toEqual([
      { kind: 'command', name: 'recap', count: 1 },
      { kind: 'skill', name: 'teams', count: 2 },
    ]);

    // Ledger stamped for D (a real parse); NOT for A (skipped) so a later good
    // read of A retries instead of being masked as complete.
    expect(getDB().prepare(`SELECT resource_count FROM resource_scan_ledger WHERE session_id = 'sessD'`).get())
      .toEqual({ resource_count: 3 });
    expect(getDB().prepare(`SELECT resource_count FROM resource_scan_ledger WHERE session_id = 'sessA'`).get())
      .toBeUndefined();

    // Rerun: D unchanged → skipped via the ledger; A/B/C still empty → failed
    // again (never stamped, so never falsely "current").
    const second = backfillResourceUsage({});
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(1); // only D is ledger-current
    expect(second.failed).toBe(3);
  });
});

describe('queryResourceUsageStats — plugin/source provenance never splits a resource (SES-IF-4b)', () => {
  beforeAll(() => {
    // The split the reviewer caught: the same resource `plugdup:widget` recorded with a resolved
    // plugin in one session and a NULL plugin in another. Grouping on plugin would split it into
    // two partial rows.
    seedSession('sessF', { agent: 'claude', timestamp: '2026-06-15T00:00:00.000Z' });
    seedSession('sessG', { agent: 'claude', timestamp: '2026-06-16T00:00:00.000Z' });
    seedUsage('sessF', 'skill', 'plugdup:widget', { plugin: 'plugdup', source: 'plugdup', count: 2 });
    seedUsage('sessG', 'skill', 'plugdup:widget', { plugin: undefined, source: undefined, count: 3 });
  });

  it('merges the same (kind, name) across differing plugin/source into ONE whole row', () => {
    const dup = queryResourceUsageStats({}).filter(r => r.name === 'plugdup:widget');
    expect(dup).toHaveLength(1);
    expect(dup[0].sessions).toBe(2);       // F + G, not split
    expect(dup[0].invocations).toBe(5);    // 2 + 3, whole
    expect(dup[0].plugin).toBe('plugdup'); // MAX surfaces the resolved label over NULL
  });
});
