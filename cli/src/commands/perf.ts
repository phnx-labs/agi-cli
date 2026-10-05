/** `agents insights perf` (moved from top-level `perf`, PHNX-3391): latency rollups over the
 * disposable perf SQLite warehouse at `~/.agents/.cache/perf/perf.db`: summary, `hooks` (p50/p99),
 * `commands`, `run`, `friction`. Soft-joins sessions.db on session_id/agent/machine. */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  aggregateSamples,
  perfDbPath,
  type PerfAggregateRow,
} from '../lib/perf/db.js';
import {
  formatMs,
  formatCacheColumn,
  DEFAULT_SLOW_HOOK_WARN_MS,
  loadHookFireEvents,
  aggregateHookProfile,
  type HookProfileRow,
} from '../lib/hooks/profile.js';
import { query } from '../lib/feed/events.js';
import { detectRepeatedGuardBlocks } from '../lib/friction-heuristics.js';

interface PerfGlobalOpts {
  days?: string;
  warnMs?: string;
  json?: boolean;
  limit?: string;
  project?: string;
}

function parseDays(raw: string | undefined): number {
  const n = parseInt(raw ?? '7', 10);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

function parseWarnMs(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? String(fallback), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseLimit(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? String(fallback), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Map warehouse rows shaped like hook.fire into the existing HookProfileRow UI. */
export function asHookRows(rows: PerfAggregateRow[]): HookProfileRow[] {
  return rows.map((r) => ({
    hook: r.label,
    n: r.n,
    p50Ms: r.p50Ms,
    p95Ms: r.p95Ms,
    p99Ms: r.p99Ms,
    meanMs: r.meanMs,
    maxMs: r.maxMs,
    cacheHitPct: r.cacheHitPct ?? 0,
    cacheStalePct: r.cacheStalePct ?? 0,
    cacheMissPct: r.cacheMissPct ?? 0,
    errorCount: r.errorCount ?? 0,
    errorRate: r.errorRate,
    blockCount: r.blockCount ?? 0,
    blockRate: r.blockRate,
    timeoutRate: r.timeoutRate,
    project: r.project,
  }));
}

function printTable(
  headers: string[],
  widths: number[],
  lines: string[][],
  slowFlags: boolean[],
): void {
  const pad = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length));
  const header = headers.map((h, i) => pad(h, widths[i])).join(' ');
  console.log(chalk.bold(header));
  console.log(chalk.gray('─'.repeat(header.length)));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].map((c, j) => pad(c, widths[j])).join(' ');
    console.log(slowFlags[i] ? chalk.yellow(line) : line);
  }
}

/** `err:12% block:40% to:4%` when any rate is present, else ''. Exit 2 (intentional deny) is
 * `block:`, not `err:`, so a deny-by-design guard doesn't read as a crashing hook. */
export function formatRateColumn(r: { errorRate?: number; blockRate?: number; timeoutRate?: number }): string {
  const parts: string[] = [];
  if (r.errorRate) parts.push(`err:${Math.round(r.errorRate * 100)}%`);
  if (r.blockRate) parts.push(`block:${Math.round(r.blockRate * 100)}%`);
  if (r.timeoutRate) parts.push(`to:${Math.round(r.timeoutRate * 100)}%`);
  return parts.join(' ');
}

export function renderHookTable(rows: HookProfileRow[], warnMs: number): void {
  if (rows.length === 0) {
    console.log(chalk.gray('No hook timing samples yet.'));
    console.log(chalk.gray(`Warehouse: ${perfDbPath()}`));
    console.log(chalk.gray('Hooks write via cache/matches shims into the spool; run a session or resync hooks.'));
    return;
  }
  const widths = { hook: 36, n: 5, p50: 7, p95: 7, p99: 7, mean: 7, max: 7, cache: 22, rate: 22 };
  const pad = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length));
  const header = [
    pad('HOOK', widths.hook),
    pad('N', widths.n),
    pad('P50', widths.p50),
    pad('P95', widths.p95),
    pad('P99', widths.p99),
    pad('MEAN', widths.mean),
    pad('MAX', widths.max),
    pad('CACHE', widths.cache),
    pad('ERR/BLOCK/TO', widths.rate),
  ].join(' ');
  console.log(chalk.bold(header));
  console.log(chalk.gray('─'.repeat(header.length)));
  for (const r of rows) {
    const slow = r.p99Ms > warnMs;
    const cacheCol = formatCacheColumn(r);
    const warning = slow && r.cacheHitPct + r.cacheStalePct === 0 ? '  ← add cache: 5m' : '';
    const line = [
      pad(r.hook, widths.hook),
      pad(String(r.n), widths.n),
      pad(formatMs(r.p50Ms), widths.p50),
      pad(formatMs(r.p95Ms), widths.p95),
      pad(formatMs(r.p99Ms), widths.p99),
      pad(formatMs(r.meanMs), widths.mean),
      pad(formatMs(r.maxMs), widths.max),
      pad(cacheCol, widths.cache),
      pad(formatRateColumn(r), widths.rate),
    ].join(' ') + warning;
    console.log(slow ? chalk.yellow(line) : line);
  }
}

function renderLabelTable(title: string, rows: PerfAggregateRow[], warnMs: number, limit: number): void {
  const sliced = rows.slice(0, limit);
  if (sliced.length === 0) {
    console.log(chalk.gray(`No ${title} samples yet.`));
    return;
  }
  const widths = [40, 5, 7, 7, 7, 7, 7, 22];
  printTable(
    ['LABEL', 'N', 'P50', 'P95', 'P99', 'MEAN', 'MAX', 'ERR/BLOCK/TO'],
    widths,
    sliced.map((r) => [
      r.label,
      String(r.n),
      formatMs(r.p50Ms),
      formatMs(r.p95Ms),
      formatMs(r.p99Ms),
      formatMs(r.meanMs),
      formatMs(r.maxMs),
      formatRateColumn(r),
    ]),
    sliced.map((r) => r.p99Ms > warnMs),
  );
  // Sub-phase break-out (agent.run's `startup` = spawn overhead before the child
  // runs, PHNX-3468). Indented under the row so a slow boot is visible next to
  // the total without adding columns that are empty for phaseless labels.
  for (const r of sliced) {
    if (!r.phases) continue;
    for (const [name, ph] of Object.entries(r.phases)) {
      console.log(chalk.gray(`  └ ${name}: p50 ${formatMs(ph.p50Ms)}  p90 ${formatMs(ph.p90Ms)}  (n=${ph.n})`));
    }
  }
}

/** Prefer SQLite samples; fall back to the legacy daily JSONL until shims are resynced. `project`
 * narrows only the SQLite path: the legacy log has no cwd, so a fallback hit ignores it. */
export function loadHookProfile(days: number, project?: string): HookProfileRow[] {
  const fromDb = asHookRows(aggregateSamples({ days, kinds: ['hook.fire'], project }));
  if (fromDb.length > 0 || project) return fromDb;
  return aggregateHookProfile(loadHookFireEvents(days));
}

function hooksAction(opts: PerfGlobalOpts): void {
  const days = parseDays(opts.days);
  const warnMs = parseWarnMs(opts.warnMs, DEFAULT_SLOW_HOOK_WARN_MS);
  const rows = loadHookProfile(days, opts.project);
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  renderHookTable(rows, warnMs);
}

function commandsAction(opts: PerfGlobalOpts): void {
  const days = parseDays(opts.days);
  const warnMs = parseWarnMs(opts.warnMs, 500);
  const limit = parseLimit(opts.limit, 40);
  const rows = aggregateSamples({ days, kinds: ['command.end'], project: opts.project });
  if (opts.json) {
    console.log(JSON.stringify(rows.slice(0, limit), null, 2));
    return;
  }
  renderLabelTable('command', rows, warnMs, limit);
}

function runAction(opts: PerfGlobalOpts): void {
  const days = parseDays(opts.days);
  const warnMs = parseWarnMs(opts.warnMs, 60_000);
  const limit = parseLimit(opts.limit, 40);
  const rows = aggregateSamples({ days, kinds: ['perf.timing'], project: opts.project });
  if (opts.json) {
    console.log(JSON.stringify(rows.slice(0, limit), null, 2));
    return;
  }
  renderLabelTable('run/timing', rows, warnMs, limit);
}

/** Sessions repeatedly hitting the same guard block (git-guard, rm-guard, git-require-clean-tree,
 * ...) instead of adapting after the first denial. Reads the `friction` sink guards self-report to
 * via `agents _internal friction` before exit 2; grouping is in lib/friction-heuristics.ts. */
export function frictionAction(opts: PerfGlobalOpts): void {
  // --project is declared on the shared `perf` parent for subcommands whose samples carry a cwd;
  // friction events carry none (`_internal friction` has no --cwd), so silently accepting it would
  // look filtered when it did nothing. Fail loud.
  if (opts.project) {
    console.error(chalk.red("agents insights perf friction does not support --project yet — friction events carry no cwd to filter on."));
    process.exitCode = 1;
    return;
  }
  const days = parseDays(opts.days);
  const startDate = new Date(Date.now() - days * 86_400_000);
  const events = query({ eventTypes: ['friction'], startDate });
  const findings = detectRepeatedGuardBlocks(events);

  if (opts.json) {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }

  if (findings.length === 0) {
    console.log(chalk.gray(`No repeated guard blocks in the last ${days} day${days === 1 ? '' : 's'}.`));
    return;
  }

  console.log(chalk.bold(`Repeated guard blocks — last ${days} day${days === 1 ? '' : 's'}\n`));
  const widths = [14, 10, 24, 5, 22, 22];
  printTable(
    ['SESSION', 'SURFACE', 'FAILURE ID', 'N', 'FIRST', 'LAST'],
    widths,
    findings.map((f) => [f.session, f.surface, f.failureId, String(f.count), f.firstTs, f.lastTs]),
    findings.map(() => false),
  );
}

function summaryAction(opts: PerfGlobalOpts): void {
  const days = parseDays(opts.days);
  const project = opts.project;
  if (opts.json) {
    console.log(JSON.stringify({
      days,
      project: project ?? null,
      warehouse: perfDbPath(),
      hooks: loadHookProfile(days, project),
      commands: aggregateSamples({ days, kinds: ['command.end'], project }).slice(0, 20),
      run: aggregateSamples({ days, kinds: ['perf.timing'], project }).slice(0, 20),
    }, null, 2));
    return;
  }

  console.log(chalk.bold(`agents insights perf — last ${days} day${days === 1 ? '' : 's'}${project ? ` — project ${project}` : ''}`));
  console.log(chalk.gray(`warehouse: ${perfDbPath()}  (disposable; soft-join sessions via session_id/agent/machine)`));
  console.log('');

  console.log(chalk.bold('Commands (slowest by p99)'));
  renderLabelTable('command', aggregateSamples({ days, kinds: ['command.end'], project }), parseWarnMs(opts.warnMs, 500), 12);
  console.log('');

  console.log(chalk.bold('Hooks'));
  renderHookTable(loadHookProfile(days, project), parseWarnMs(opts.warnMs, DEFAULT_SLOW_HOOK_WARN_MS));
  console.log('');

  console.log(chalk.bold('Runs (perf.timing)'));
  renderLabelTable('run/timing', aggregateSamples({ days, kinds: ['perf.timing'], project }), parseWarnMs(opts.warnMs, 60_000), 12);
}

function attachSharedOptions(cmd: Command): Command {
  return cmd
    .option('--days <n>', 'Days of samples to include', '7')
    .option('--warn-ms <n>', 'p99 above this is highlighted')
    .option('--limit <n>', 'Max rows in the table', '40')
    .option('--project <key>', 'Scope to one project (the repo directory name a sample\'s cwd resolves to — see project-key.ts)')
    .option('--json', 'Emit JSON instead of a table');
}

/** Commander binds a flag declared on parent and child to the parent. Merge so `insights perf
 * commands --json` still sees json:true on the leaf. */
function leafOpts(cmd: Command): PerfGlobalOpts {
  const parent = cmd.parent && typeof cmd.parent.opts === 'function'
    ? (cmd.parent.opts() as PerfGlobalOpts)
    : {};
  return { ...parent, ...(cmd.opts() as PerfGlobalOpts) };
}

/** Attach the `perf` rollup under the top-level `insights` group (not `sessions insights`), beside
 * `cost` and `output`. Performance is an insight, not a top-level noun: `agents perf` was retired
 * (PHNX-3391). */
export function registerPerfSubcommand(parent: Command): void {
  const perf = parent
    .command('perf')
    .description('Latency rollups from the disposable perf warehouse (hooks, commands, runs)')
    .addHelpText('after', `
The warehouse is SQLite at ~/.agents/.cache/perf/perf.db — safe to delete.
Identity columns reuse sessions/events string shapes (session_id, agent, machine)
for soft cross-reference; there are no foreign keys.

Examples:
  agents insights perf                        # summary: commands + hooks + runs
  agents insights perf hooks                  # per-hook p50/p95/p99 + cache hit rate
  agents insights perf commands --days 30     # slowest CLI entrypoints
  agents insights perf run --json             # agent.run timings as JSON
  agents insights perf hooks --warn-ms 500
  agents insights perf hooks --project agents-cli  # scope to one repo's samples
  agents insights perf friction               # sessions stuck retrying the same guard block
`);

  // Options live on the parent so `agents insights perf --json` and
  // `agents insights perf commands --json` both work (see leafOpts).
  attachSharedOptions(perf).action(function summary(this: Command) {
    summaryAction(this.opts() as PerfGlobalOpts);
  });

  perf.command('hooks').description('Per-hook timing + cache stats')
    .action(function hooks(this: Command) {
      hooksAction(leafOpts(this));
    });

  perf.command('commands').description('Slowest CLI command paths (command.end samples)')
    .action(function commands(this: Command) {
      commandsAction(leafOpts(this));
    });

  perf.command('run').description('agent.run / perf.timing label rollups')
    .action(function run(this: Command) {
      runAction(leafOpts(this));
    });

  perf.command('friction').description('Sessions stuck repeatedly hitting the same guard block')
    .action(function friction(this: Command) {
      frictionAction(leafOpts(this));
    });
}
