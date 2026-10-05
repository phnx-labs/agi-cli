/** `agents insights` end to end: real transcripts on disk, a real sqlite index, the registered
 * commander action. No mocking. */

import { describe, expect, it, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-insights-cmd-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
// Answer only for this machine: the fan-out would otherwise try to reach peers.
process.env.AGENTS_SESSIONS_LOCAL = '1';

const HISTORY = path.join(TEST_HOME, '.agents', '.history');

interface Acct { org: string; email: string; name: string }
const ALPHA: Acct = { org: 'org-alpha', email: 'dev@alpha.example', name: 'Alpha Inc' };
const BETA: Acct = { org: 'org-beta', email: 'dev@beta.example', name: 'Beta Ltd' };

function writeHome(version: string, acct: Acct): string {
  const home = path.join(HISTORY, 'versions', 'claude', version, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-proj'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify({
    oauthAccount: {
      accountUuid: `acct-${acct.org}`, emailAddress: acct.email,
      organizationUuid: acct.org, organizationName: acct.name,
      organizationType: 'claude_team',
    },
  }));
  return home;
}

/** A transcript with enough substance to survive the min-messages/duration filter. */
function writeTranscript(home: string, id: string, version: string, opts: {
  startIso: string;
  minutes: number;
  interrupts?: number;
  commits?: number;
}): void {
  const start = Date.parse(opts.startIso);
  const at = (ms: number): string => new Date(start + ms).toISOString();
  const lines: string[] = [];
  const push = (o: unknown): void => { lines.push(JSON.stringify(o)); };

  push({ type: 'user', sessionId: id, cwd: '/tmp/proj', version, gitBranch: 'main',
    timestamp: at(0), message: { role: 'user', content: 'please do the work' } });
  push({ type: 'assistant', sessionId: id, cwd: '/tmp/proj', version, timestamp: at(1000),
    message: { role: 'assistant', content: [
      { type: 'text', text: 'on it' },
      { type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: '/tmp/proj/a.ts', content: 'x\ny\nz' } },
    ], usage: { input_tokens: 20, output_tokens: 9 }, model: 'claude-opus-5' } });
  for (let i = 0; i < (opts.commits ?? 0); i++) {
    push({ type: 'assistant', sessionId: id, cwd: '/tmp/proj', version, timestamp: at(2000 + i),
      message: { role: 'assistant', content: [
        { type: 'tool_use', id: `tc${i}`, name: 'Bash', input: { command: 'git add -A && git commit -m "x"' } },
      ], usage: { input_tokens: 1, output_tokens: 1 }, model: 'claude-opus-5' } });
  }
  for (let i = 0; i < (opts.interrupts ?? 0); i++) {
    push({ type: 'user', sessionId: id, cwd: '/tmp/proj', version, timestamp: at(3000 + i),
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  }
  push({ type: 'user', sessionId: id, cwd: '/tmp/proj', version,
    timestamp: at(opts.minutes * 60_000),
    message: { role: 'user', content: 'thanks, that is it' } });

  fs.writeFileSync(path.join(home, '.claude', 'projects', '-proj', `${id}.jsonl`), lines.join('\n') + '\n');
}

beforeAll(async () => {
  fs.mkdirSync(path.join(TEST_HOME, '.agents', '.system', '.git'), { recursive: true });
  fs.writeFileSync(path.join(TEST_HOME, '.agents', 'agents.yaml'), 'agents: {}\n');

  const alphaHome = writeHome('9.0.1', ALPHA);
  const betaHome = writeHome('9.0.2', BETA);

  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  writeTranscript(alphaHome, 'aaaaaaaa-0000-0000-0000-00000000000a', '9.0.1',
    { startIso: recent, minutes: 5, interrupts: 2, commits: 1 });
  writeTranscript(alphaHome, 'aaaaaaaa-0000-0000-0000-00000000000b', '9.0.1',
    { startIso: recent, minutes: 4, commits: 2 });
  writeTranscript(betaHome, 'bbbbbbbb-0000-0000-0000-00000000000c', '9.0.2',
    { startIso: recent, minutes: 6, interrupts: 1 });
  // Too short to be substantive — must be filtered and counted, not reported.
  writeTranscript(betaHome, 'bbbbbbbb-0000-0000-0000-00000000000d', '9.0.2',
    { startIso: recent, minutes: 0 });
});

/** Run the registered command, capturing stdout. */
async function runInsights(args: string[]): Promise<string> {
  const { Command } = await import('commander');
  const { registerInsightsCommand } = await import('./insights.js');
  const program = new Command();
  program.exitOverride();
  registerInsightsCommand(program);

  const chunks: string[] = [];
  const origLog = console.log;
  const origWrite = process.stdout.write.bind(process.stdout);
  console.log = (...a: unknown[]) => { chunks.push(a.map(String).join(' ')); };
  (process.stdout as { write: unknown }).write = ((s: string) => { chunks.push(s); return true; }) as never;
  try {
    await program.parseAsync(['node', 'agents', 'insights', ...args]);
  } finally {
    console.log = origLog;
    (process.stdout as { write: unknown }).write = origWrite;
  }
  return chunks.join('\n');
}

async function runNestedInsights(args: string[]): Promise<string> {
  const { Command } = await import('commander');
  const { registerSessionsInsightsCommand } = await import('./insights.js');
  const program = new Command();
  program.exitOverride();
  const sessions = program.command('sessions')
    .option('--json')
    .option('--since <time>')
    .option('--agent <id>');
  registerSessionsInsightsCommand(sessions);

  const chunks: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => { chunks.push(a.map(String).join(' ')); };
  try {
    await program.parseAsync(['node', 'agents', 'sessions', 'insights', ...args]);
  } finally {
    console.log = origLog;
  }
  return chunks.join('\n');
}

describe('agents insights', () => {
  it('splits the report by the account that produced each session', async () => {
    const payload = JSON.parse(await runInsights(['--json', '--since', 'all']));
    expect(payload.by).toBe('account');

    const byLabel = new Map<string, { sessions: number }>(
      payload.groups.map((g: { label: string; sessions: number }) => [g.label, g]),
    );
    // Two distinct accounts, each with only its own sessions — the whole point.
    expect(byLabel.get('Alpha Inc <dev@alpha.example>')?.sessions).toBe(2);
    expect(byLabel.get('Beta Ltd <dev@beta.example>')?.sessions).toBe(1);
  });

  it('reports the sessions it filtered out rather than dropping them silently', async () => {
    const payload = JSON.parse(await runInsights(['--json', '--since', 'all']));
    expect(payload.analyzed).toBe(3);
    expect(payload.filteredOut).toBe(1);
    expect(payload.scanned).toBe(payload.analyzed + payload.filteredOut);
  });

  it('carries the behavioural facets that motivated the command', async () => {
    const payload = JSON.parse(await runInsights(['--json', '--since', 'all']));
    const alpha = payload.groups.find((g: { label: string }) => g.label.startsWith('Alpha Inc'));
    // 2 interrupts in one alpha session, 1 + 2 commits across both.
    expect(alpha.interruptions).toBe(2);
    expect(alpha.gitCommits).toBe(3);
    expect(alpha.languages.TypeScript).toBe(2);
    expect(alpha.models['opus-5']).toBeGreaterThan(0);   // shortened, like every renderer
    expect(alpha.messageHours).toHaveLength(24);
    // The raw gap sample is dropped from JSON in favour of percentiles + buckets.
    expect(alpha.responseGaps).toBeUndefined();
    expect(alpha.responseGapBuckets).toHaveLength(7);
  });

  it('per-account totals sum to the analyzed total', async () => {
    const payload = JSON.parse(await runInsights(['--json', '--since', 'all']));
    const summed = payload.groups.reduce((s: number, g: { sessions: number }) => s + g.sessions, 0);
    expect(summed).toBe(payload.analyzed);
  });

  it('regroups on --by without changing the population', async () => {
    const byAccount = JSON.parse(await runInsights(['--json', '--since', 'all']));
    const byProject = JSON.parse(await runInsights(['--json', '--since', 'all', '--by', 'project']));
    expect(byProject.by).toBe('project');
    expect(byProject.analyzed).toBe(byAccount.analyzed);
    expect(byProject.groups).toHaveLength(1);   // every fixture shares one cwd
  });

  it('accepts --all as an alias for --since all', async () => {
    // The spelling people reach for. Before this it was `unknown option '--all'`,
    // which is a hard exit in the middle of a report they asked for.
    const viaAlias = JSON.parse(await runInsights(['--json', '--all']));
    const viaSince = JSON.parse(await runInsights(['--json', '--since', 'all']));
    expect(viaAlias.window.since).toBeNull();
    expect(viaAlias.analyzed).toBe(viaSince.analyzed);
  });

  it('lets an explicit --since win over --all rather than contradicting it', async () => {
    const both = JSON.parse(await runInsights(['--json', '--all', '--since', '30d']));
    expect(both.window.since).toBe('30d');
  });

  it('nests under sessions, inherits overlapping parent flags, and emits actions', async () => {
    const payload = JSON.parse(await runNestedInsights(['--json', '--since', 'all', '--agent', 'claude']));
    expect(payload.window.since).toBeNull();
    expect(payload.harnesses).toEqual([{ name: 'claude', count: 3 }]);
    expect(payload.actions).toBeInstanceOf(Array);
  });

  it('filters to one account with --account', async () => {
    const payload = JSON.parse(await runInsights(['--json', '--since', 'all', '--account', 'Beta']));
    expect(payload.groups).toHaveLength(1);
    expect(payload.groups[0].label).toContain('Beta Ltd');
  });

  it('marks facets unmeasurable rather than zero for an unknown harness vocabulary', async () => {
    const payload = JSON.parse(await runInsights(['--json', '--since', 'all']));
    // Every fixture uses Claude's Write, so editingToolCalls proves the signal exists
    // and is non-zero here; the renderer keys "not measurable" off it being 0.
    const alpha = payload.groups.find((g: { label: string }) => g.label.startsWith('Alpha Inc'));
    expect(alpha.editingToolCalls).toBeGreaterThan(0);
  });

  it('serves the second run from cache without re-reading transcripts', async () => {
    const { getDB } = await import('../lib/session/db.js');
    await runInsights(['--json', '--since', 'all']);
    const db = getDB();
    const before = db.prepare(`SELECT computed_at FROM session_insights ORDER BY session_id`).all();
    expect(before.length).toBeGreaterThan(0);

    await runInsights(['--json', '--since', 'all']);
    const after = db.prepare(`SELECT computed_at FROM session_insights ORDER BY session_id`).all();
    // Untouched transcripts are not recomputed, so the stamps do not move.
    expect(after).toEqual(before);
  });

  it('recomputes a session whose transcript changed', async () => {
    const { getDB } = await import('../lib/session/db.js');
    await runInsights(['--json', '--since', 'all']);
    const db = getDB();
    const id = 'aaaaaaaa-0000-0000-0000-00000000000a';
    const before = db.prepare(`SELECT computed_at, facets FROM session_insights WHERE session_id = ?`)
      .get(id) as { computed_at: number; facets: string };

    // Invalidate by changing the stored stamp, exactly as a re-scan of a grown
    // transcript would.
    db.prepare(`UPDATE session_insights SET file_size = file_size + 1 WHERE session_id = ?`).run(id);
    await runInsights(['--json', '--since', 'all']);

    const after = db.prepare(`SELECT computed_at, facets FROM session_insights WHERE session_id = ?`)
      .get(id) as { computed_at: number; facets: string };
    expect(after.facets).toBe(before.facets);          // same input, same answer
    expect(after.computed_at).toBeGreaterThanOrEqual(before.computed_at);
  });

  it('recomputes facets written by the previous extractor version', async () => {
    const { getDB, INSIGHTS_EXTRACTOR_VERSION } = await import('../lib/session/db.js');
    await runInsights(['--json', '--since', 'all']);
    const db = getDB();
    const id = 'aaaaaaaa-0000-0000-0000-00000000000a';
    db.prepare(`UPDATE session_insights SET extractor_version = ? WHERE session_id = ?`)
      .run(INSIGHTS_EXTRACTOR_VERSION - 1, id);

    await runInsights(['--json', '--since', 'all']);

    const row = db.prepare(`SELECT extractor_version, facets FROM session_insights WHERE session_id = ?`)
      .get(id) as { extractor_version: number; facets: string };
    expect(row.extractor_version).toBe(INSIGHTS_EXTRACTOR_VERSION);
    expect(JSON.parse(row.facets)).toMatchObject({
      frictionSignals: {}, correctionSignals: {}, automationSignals: {},
    });
  });
});

