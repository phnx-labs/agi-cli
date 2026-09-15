/**
 * Output command — productivity: token *burn* vs shipped *output*.
 *
 * Nested as `agents insights output`. `agents insights cost` answers "what did
 * we burn?" (dollars + duration). This joins that burn to what actually shipped —
 * real generated (output) tokens plus PRs and commits across every git identity —
 * so you can see burn-vs-output and ratios like $/PR and output-tokens/$. Pure
 * SQLite + local git/gh, no server, no telemetry — the same offline spirit as cost.
 *
 * Why not just show `token_count`? Because that number sums cache-read/-write
 * context re-counted every turn and is dominated by cheap re-reads (often ~100x
 * the real generation). `output_tokens` (scanned per-agent into the session DB)
 * is the honest "work produced" signal, and it is what this command leads with.
 *
 * `--all-hosts` fans the same rollup across every online device (`ag devices`)
 * over SSH and merges — one fleet-wide burn-vs-output view.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { addHostOption } from '../lib/hosts/option.js';
import { discoverSessions, parseTimeFilter } from '../lib/session/discover.js';
import { queryUsageRollup, type UsageRollupGroup, type QueryOptions } from '../lib/session/db.js';
import { formatUsd, PRICING_VERSION } from '../lib/pricing/index.js';
import { formatDuration } from '@phnx-labs/sessions-cli/reader';
import { terminalWidth, truncateToWidth, padToWidth } from '../lib/session/width.js';
import { collectGitOutput } from '../lib/output/git-output.js';
import { loadDevices } from '../lib/devices/registry.js';
import { machineId } from '../lib/session/sync/config.js';
import { stripClixml } from '../lib/hosts/remote-cmd.js';

const execFileAsync = promisify(execFile);

interface OutputOptions {
  json?: boolean;
  since?: string;
  by?: string;
  reposDir?: string;
  author?: string[];
  login?: string[];
  prs?: boolean; // commander sets `prs: false` for --no-prs
  allHosts?: boolean;
  pricing?: string;
}

interface RollupRow {
  key: string;
  /** Human label when the key is an identity rather than display text (--by account). */
  label?: string;
  costUsd: number;
  /** USD cost with cache read/write repriced at the input rate (RUSH-2287). */
  costUsdNoCache: number;
  durationMs: number;
  sessionCount: number;
  tokenCount: number;
  outputTokens: number;
  /** Burn split — 0 for harnesses that record no cache split (RUSH-2287). */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface BurnTotals {
  costUsd: number;
  /** USD cost priced as if caching were off (cache read/write at the input rate). */
  costUsdNoCache: number;
  outputTokens: number;
  tokenCount: number;
  /** Burn split summed across the window. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  sessionCount: number;
  durationMs: number;
}

interface GitOut {
  commits: number;
  /** Deduped commit SHAs — unioned across machines under --all-hosts. */
  commitShas: string[];
  prsOpened: number;
  prsMerged: number;
  reposScanned: number;
  ghAvailable: boolean;
  authors: string[];
  logins: string[];
}

/** One machine's productivity payload — the `--json` shape, reused across the fleet. */
interface OutputPayload {
  machine: string;
  pricingVersion: string;
  since: string;
  burn: BurnTotals;
  output: GitOut;
  breakdown: { by: string; rows: RollupRow[] };
  uncostedAgents: string[];
  /** Set when a remote machine could not be reached / did not support the command. */
  error?: string;
}

/** Register `agents insights output` under the insights parent. */
export function registerOutputCommand(insightsCmd: Command): void {
  addHostOption(insightsCmd.command('output'))
    .description('Productivity rollup — token burn vs shipped output (PRs, commits) across agents')
    .option('--json', 'Output the rollup as JSON')
    .option('--since <time>', 'Only sessions/commits newer than this: 1h, 24h, 7d, 4w, 1mo, 1y, or ISO date (default 7d)')
    .option('--by <dimension>', 'Group the burn/output breakdown by: agent (default), project, day, or account (the Claude org that produced each session)')
    .option('--repos-dir <dir>', 'Root scanned for git repos (default ~/src)')
    .option('--author <email...>', 'Count commits by these author emails (default: your git identities)')
    .option('--login <login...>', 'Count PRs for these GitHub logins (default: current gh user)')
    .option('--no-prs', 'Skip the GitHub PR lookup (commits only)')
    .option('--all-hosts', 'Aggregate across every online device (ag devices) over SSH')
    .option('--pricing <scenario>', 'Cost scenario: actual (default, cache-discounted) or no-cache (cache read/write billed at the full input rate)')
    .addHelpText('after', `
Examples:
  agents insights output                       Last 7 days: burn, output tokens, PRs, commits, ratios
  agents insights output --since 24h           Last 24 hours
  agents insights output --since 1mo           Last month  (units: 1h 24h 7d 4w 1mo 1y, or ISO date)
  agents insights output --pricing no-cache    Model the burn as if prompt caching were off
  agents insights output --all-hosts           Fleet-wide, folding in every online machine
  agents insights output --by day --json       Machine-readable daily burn/output rollup

Burn (cost) is computed offline from a versioned per-model price table (${PRICING_VERSION}).
Output tokens are the real generated tokens — NOT the cache-inflated total token count.
The burn is split into input / cache-read / cache-write where the harness records it
(Claude/Codex/Gemini/Droid). --pricing no-cache reprices cached tokens at the input rate,
so you can see what caching is saving. --json always carries both actual and no-cache costs.
`)
    // Read opts via optsWithGlobals(): `--json`/`--since`/`--by` collide by name
    // with the `insights` parent's own options, so commander binds them to the
    // parent at parse time and the leaf's plain opts() never sees them. Merging
    // ancestor opts is what the sibling `insights mix` recipes already do
    // (mix-commands.ts) — without it every flag on this command is silently
    // dropped (e.g. `agents insights output --json` printed the human table).
    .action(async (_options: OutputOptions, command: Command) => {
      await outputAction(command.optsWithGlobals() as OutputOptions);
    });
}

function resolveGroup(by: string | undefined): UsageRollupGroup {
  if (by === undefined) return 'agent';
  if (by === 'agent' || by === 'project' || by === 'day' || by === 'account') return by;
  console.error(chalk.red('error: --by must be one of: agent, project, day, account'));
  process.exit(1);
}

type PricingScenario = 'actual' | 'no-cache';

function resolvePricing(pricing: string | undefined): PricingScenario {
  if (pricing === undefined || pricing === 'actual') return 'actual';
  if (pricing === 'no-cache') return 'no-cache';
  console.error(chalk.red('error: --pricing must be one of: actual, no-cache'));
  process.exit(1);
}

/** Compact token formatter: 38.6M, 4.1K, 10.6B. */
function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function emptyBurn(): BurnTotals {
  return {
    costUsd: 0,
    costUsdNoCache: 0,
    outputTokens: 0,
    tokenCount: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    sessionCount: 0,
    durationMs: 0,
  };
}

function sumBurn(rows: RollupRow[]): BurnTotals {
  return rows.reduce((acc, r) => {
    acc.costUsd += r.costUsd;
    acc.costUsdNoCache += r.costUsdNoCache;
    acc.outputTokens += r.outputTokens;
    acc.tokenCount += r.tokenCount;
    acc.inputTokens += r.inputTokens;
    acc.cacheReadTokens += r.cacheReadTokens;
    acc.cacheWriteTokens += r.cacheWriteTokens;
    acc.sessionCount += r.sessionCount;
    acc.durationMs += r.durationMs;
    return acc;
  }, emptyBurn());
}

/** Compute this machine's payload from the local session DB + git. */
async function computeLocalPayload(options: OutputOptions, includePrs: boolean): Promise<OutputPayload> {
  const since = options.since ?? '7d';
  const sinceMs = parseTimeFilter(since);

  // Ensure the index is fresh (and migrated to v12 so output_tokens is populated).
  await discoverSessions({ all: true, since, limit: 1 });

  const filter: QueryOptions = { sinceMs };
  const groupBy = resolveGroup(options.by);
  const breakdown = queryUsageRollup({ ...filter, groupBy }) as RollupRow[];
  const burn = sumBurn(breakdown);

  const reposDir = options.reposDir ?? path.join(os.homedir(), 'src');
  const git = await collectGitOutput({
    reposDir,
    sinceMs,
    authors: options.author,
    logins: options.login,
    includePrs,
  });

  return {
    machine: machineId(),
    pricingVersion: PRICING_VERSION,
    since,
    burn,
    output: {
      commits: git.commits,
      commitShas: git.commitShas,
      prsOpened: git.prsOpened,
      prsMerged: git.prsMerged,
      reposScanned: git.reposScanned,
      ghAvailable: git.ghAvailable,
      authors: git.authors,
      logins: git.logins,
    },
    breakdown: { by: groupBy, rows: breakdown },
    uncostedAgents: groupBy === 'agent' ? breakdown.filter(r => r.costUsd === 0).map(r => r.key) : [],
  };
}

/** Fetch one remote device's payload by re-invoking `agents insights output --json --device <name>`. */
async function fetchRemotePayload(device: string, options: OutputOptions): Promise<OutputPayload> {
  const args = ['insights', 'output', '--json', '--no-prs', '--device', device, '--since', options.since ?? '7d'];
  if (options.by) args.push('--by', options.by);
  if (options.reposDir) args.push('--repos-dir', options.reposDir);
  for (const a of options.author ?? []) args.push('--author', a);
  try {
    const { stdout } = await execFileAsync('agents', args, {
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    // A Windows device relays its payload through PowerShell, which can prefix a
    // CLIXML banner ahead of the JSON — strip it before parsing (RUSH-2286).
    const parsed = JSON.parse(stripClixml(stdout)) as OutputPayload;
    parsed.machine = parsed.machine || device;
    return parsed;
  } catch (err: any) {
    return {
      machine: device,
      pricingVersion: PRICING_VERSION,
      since: options.since ?? '7d',
      burn: emptyBurn(),
      output: { commits: 0, commitShas: [], prsOpened: 0, prsMerged: 0, reposScanned: 0, ghAvailable: false, authors: [], logins: [] },
      breakdown: { by: resolveGroup(options.by), rows: [] },
      uncostedAgents: [],
      error: (err?.stderr || err?.message || 'unreachable').toString().split('\n')[0].slice(0, 120),
    };
  }
}

async function outputAction(options: OutputOptions): Promise<void> {
  const includePrs = options.prs !== false;
  // Validate --pricing up front so a bad value errors even under --json. The JSON
  // payload always carries BOTH costs regardless of the scenario — the flag only
  // chooses which one the text renderer leads with.
  const scenario = resolvePricing(options.pricing);

  if (!options.allHosts) {
    const payload = await computeLocalPayload(options, includePrs);
    if (options.json) {
      process.stdout.write(JSON.stringify(withRatios(payload, [payload]), null, 2) + '\n');
      return;
    }
    renderSingle(payload, scenario);
    return;
  }

  // Fleet: local payload + every online device, folded in over SSH.
  const self = machineId();
  const registry = await loadDevices();
  const remotes = Object.values(registry)
    .filter(d => d.tailscale?.online && d.name !== self)
    .map(d => d.name);

  if (!options.json) console.error(chalk.gray(`Folding in ${remotes.length} online device${remotes.length !== 1 ? 's' : ''}…`));

  // PRs are global (gh search by author, not machine-bound) — compute once, locally.
  const local = await computeLocalPayload(options, includePrs);
  const remotePayloads = await Promise.all(remotes.map(d => fetchRemotePayload(d, options)));
  const machines = [local, ...remotePayloads];

  if (options.json) {
    process.stdout.write(JSON.stringify(withRatios(mergeMachines(machines, options), machines), null, 2) + '\n');
    return;
  }
  renderFleet(machines, options, scenario);
}

/** Merge per-machine payloads into a combined one (burn + commits summed; PRs local-only). */
function mergeMachines(machines: OutputPayload[], options: OutputOptions): OutputPayload {
  const burn = emptyBurn();
  const byKey = new Map<string, RollupRow>();
  // Union commit SHAs across machines: shared repos (cloned on several boxes)
  // expose the same commits to `git log` on each, so summing counts would
  // multi-count. A commit's SHA is its global identity — union, don't add.
  const allShas = new Set<string>();
  const uncosted = new Set<string>();
  for (const m of machines) {
    burn.costUsd += m.burn.costUsd;
    burn.costUsdNoCache += m.burn.costUsdNoCache;
    burn.outputTokens += m.burn.outputTokens;
    burn.tokenCount += m.burn.tokenCount;
    burn.inputTokens += m.burn.inputTokens;
    burn.cacheReadTokens += m.burn.cacheReadTokens;
    burn.cacheWriteTokens += m.burn.cacheWriteTokens;
    burn.sessionCount += m.burn.sessionCount;
    burn.durationMs += m.burn.durationMs;
    for (const s of m.output.commitShas) allShas.add(s);
    for (const a of m.uncostedAgents) uncosted.add(a);
    for (const r of m.breakdown.rows) {
      const cur = byKey.get(r.key) ?? {
        key: r.key, label: r.label, costUsd: 0, costUsdNoCache: 0, durationMs: 0,
        sessionCount: 0, tokenCount: 0, outputTokens: 0,
        inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      };
      // Peers resolve their own labels; keep the first non-empty one so a machine that
      // has not indexed an account yet does not blank a label another machine supplied.
      cur.label ??= r.label;
      cur.costUsd += r.costUsd;
      cur.costUsdNoCache += r.costUsdNoCache;
      cur.durationMs += r.durationMs;
      cur.sessionCount += r.sessionCount;
      cur.tokenCount += r.tokenCount;
      cur.outputTokens += r.outputTokens;
      cur.inputTokens += r.inputTokens;
      cur.cacheReadTokens += r.cacheReadTokens;
      cur.cacheWriteTokens += r.cacheWriteTokens;
      byKey.set(r.key, cur);
    }
  }
  const rows = [...byKey.values()].sort((a, b) => b.costUsd - a.costUsd);
  // PRs from the local machine only (machines[0]) — gh search is not machine-scoped.
  const localGit = machines[0].output;
  return {
    machine: 'fleet',
    pricingVersion: PRICING_VERSION,
    since: options.since ?? '7d',
    burn,
    output: { ...localGit, commits: allShas.size, commitShas: [...allShas] },
    breakdown: { by: resolveGroup(options.by), rows },
    uncostedAgents: [...uncosted],
  };
}

/** Attach burn-vs-output ratios to a payload for JSON output. */
function withRatios(payload: OutputPayload, machines: OutputPayload[]): unknown {
  const prsTotal = payload.output.prsOpened + payload.output.prsMerged;
  return {
    ...payload,
    ratios: {
      costPerPr: prsTotal > 0 ? payload.burn.costUsd / prsTotal : null,
      costPerCommit: payload.output.commits > 0 ? payload.burn.costUsd / payload.output.commits : null,
      outputTokensPerUsd: payload.burn.costUsd > 0 ? payload.burn.outputTokens / payload.burn.costUsd : null,
    },
    machines: machines.length > 1 ? machines.map(m => ({ machine: m.machine, burn: m.burn, commits: m.output.commits, error: m.error })) : undefined,
  };
}

/** The cost the text renderer leads with for the chosen scenario. */
function scenarioCost(x: { costUsd: number; costUsdNoCache: number }, scenario: PricingScenario): number {
  return scenario === 'no-cache' ? x.costUsdNoCache : x.costUsd;
}

/** Shared header line: burned · output tokens · PRs · commits, plus ratios + burn split. */
function headerLines(payload: OutputPayload, scenario: PricingScenario): string[] {
  const prsTotal = payload.output.prsOpened + payload.output.prsMerged;
  const burn = payload.burn;
  const cost = scenarioCost(burn, scenario);
  const out: string[] = [];
  out.push(
    '  ' +
      `${chalk.green(formatUsd(cost))} burned${scenario === 'no-cache' ? chalk.gray(' (no-cache)') : ''}` +
      chalk.gray('  ·  ') +
      `${chalk.cyan(formatCompact(burn.outputTokens))} output tokens` +
      chalk.gray('  ·  ') +
      `${chalk.yellow(String(prsTotal))} PRs ${chalk.gray(`(${payload.output.prsMerged} merged)`)}` +
      chalk.gray('  ·  ') +
      `${chalk.yellow(String(payload.output.commits))} commits`,
  );
  const ratios: string[] = [];
  if (prsTotal > 0) ratios.push(`${formatUsd(cost / prsTotal)}/PR`);
  if (payload.output.commits > 0) ratios.push(`${formatUsd(cost / payload.output.commits)}/commit`);
  if (cost > 0) ratios.push(`${formatCompact(Math.round(burn.outputTokens / cost))} out-tok/$`);
  if (ratios.length > 0) out.push(chalk.gray('  ' + ratios.join('  ·  ')));

  // Burn split — only for harnesses that recorded one (input/cache totals > 0).
  const splitTotal = burn.inputTokens + burn.cacheReadTokens + burn.cacheWriteTokens;
  if (splitTotal > 0) {
    out.push(
      chalk.gray('  burn split: ') +
        `${chalk.cyan(formatCompact(burn.inputTokens))} input` +
        chalk.gray('  ·  ') +
        `${chalk.cyan(formatCompact(burn.cacheReadTokens))} cache-read` +
        chalk.gray('  ·  ') +
        `${chalk.cyan(formatCompact(burn.cacheWriteTokens))} cache-write`,
    );
  }

  // No-cache comparison — shown whenever caching actually moved the number, so an
  // operator sees the saving in `actual` mode too (RUSH-2287: "both if useful").
  if (burn.costUsdNoCache > burn.costUsd && burn.costUsd > 0) {
    const saved = burn.costUsdNoCache - burn.costUsd;
    const pct = Math.round((saved / burn.costUsdNoCache) * 100);
    out.push(
      chalk.gray('  caching: ') +
        `actual ${chalk.green(formatUsd(burn.costUsd))}` +
        chalk.gray('  vs  ') +
        `no-cache ${chalk.yellow(formatUsd(burn.costUsdNoCache))}` +
        chalk.gray(`  (saved ${formatUsd(saved)}, ${pct}%)`),
    );
  }
  return out;
}

/** Render the per-group burn/output table. */
function renderBreakdown(rows: RollupRow[], groupBy: string, scenario: PricingScenario): string[] {
  const out: string[] = [chalk.bold(`By ${groupBy}`)];
  if (rows.length === 0) return out;
  const rowCost = (r: RollupRow): number => scenarioCost(r, scenario);
  const cols = terminalWidth();
  const burnHeader = scenario === 'no-cache' ? 'burn(nc)' : 'burn';
  const burnW = Math.max(...rows.map(r => formatUsd(rowCost(r)).length), burnHeader.length);
  const outW = Math.max(...rows.map(r => formatCompact(r.outputTokens).length), 6);
  const sessW = Math.max(...rows.map(r => String(r.sessionCount).length), 3);
  const fixedW = 2 + 2 + burnW + 2 + outW + 2 + sessW + 8;
  const display = (r: RollupRow): string => r.label ?? r.key;
  const keyW = Math.max(8, Math.min(Math.max(...rows.map(r => display(r).length), groupBy.length), cols - fixedW));
  out.push('  ' + chalk.gray(padToWidth('', keyW)) + '  ' + chalk.gray(padToWidth(burnHeader, burnW)) + '  ' + chalk.gray(padToWidth('output', outW)) + '  ' + chalk.gray('sessions'));
  for (const r of rows) {
    out.push(
      '  ' +
        padToWidth(truncateToWidth(display(r), keyW), keyW) +
        '  ' +
        chalk.green(padToWidth(formatUsd(rowCost(r)), burnW)) +
        '  ' +
        chalk.cyan(padToWidth(formatCompact(r.outputTokens), outW)) +
        '  ' +
        chalk.gray(padToWidth(String(r.sessionCount), sessW)),
    );
  }
  return out;
}

function renderSingle(payload: OutputPayload, scenario: PricingScenario): void {
  const out: string[] = [];
  out.push(chalk.bold('Output') + chalk.gray(`  ·  pricing ${payload.pricingVersion}  ·  since ${payload.since}`));
  out.push(...headerLines(payload, scenario));
  out.push('');
  if (payload.burn.sessionCount === 0) {
    out.push(chalk.gray('No sessions with cost data found. Run `agents sessions --all` to index, then retry.'));
    console.log(out.join('\n'));
    return;
  }
  out.push(...renderBreakdown(payload.breakdown.rows, payload.breakdown.by, scenario));
  out.push('');
  out.push(chalk.bold('Shipped'));
  out.push(`  ${chalk.yellow(String(payload.output.commits))} commits across ${payload.output.reposScanned} repos` + chalk.gray(`  (authors: ${payload.output.authors.length > 0 ? payload.output.authors.join(', ') : 'none detected'})`));
  if (payload.output.ghAvailable) {
    out.push(`  ${chalk.yellow(String(payload.output.prsOpened))} PRs opened, ${chalk.yellow(String(payload.output.prsMerged))} merged` + chalk.gray(`  (logins: ${payload.output.logins.join(', ')})`));
  } else {
    out.push(chalk.gray('  PRs: gh unavailable or unauthed — not counted'));
  }
  out.push('');
  out.push(chalk.gray(notCountedLine(payload.uncostedAgents)));
  if (payload.burn.durationMs > 0) out.push(chalk.gray(`agent wall-clock: ${formatDuration(payload.burn.durationMs)}`));
  console.log(out.join('\n'));
}

function renderFleet(machines: OutputPayload[], options: OutputOptions, scenario: PricingScenario): void {
  const merged = mergeMachines(machines, options);
  const out: string[] = [];
  out.push(chalk.bold('Output') + chalk.gray(`  ·  fleet (${machines.length} machines)  ·  pricing ${merged.pricingVersion}  ·  since ${merged.since}`));
  out.push(...headerLines(merged, scenario));
  out.push('');

  // By machine.
  out.push(chalk.bold('By machine'));
  const nameW = Math.max(...machines.map(m => m.machine.length), 7);
  const burnW = Math.max(...machines.map(m => formatUsd(scenarioCost(m.burn, scenario)).length), 4);
  for (const m of machines) {
    const note = m.error ? chalk.red(`  (${m.error})`) : '';
    out.push(
      '  ' +
        padToWidth(m.machine, nameW) +
        '  ' +
        chalk.green(padToWidth(formatUsd(scenarioCost(m.burn, scenario)), burnW)) +
        '  ' +
        chalk.cyan(padToWidth(formatCompact(m.burn.outputTokens), 7)) +
        '  ' +
        chalk.gray(`${m.burn.sessionCount} sessions, ${m.output.commits} commits`) +
        note,
    );
  }
  out.push('');
  out.push(...renderBreakdown(merged.breakdown.rows, merged.breakdown.by, scenario));
  out.push('');
  out.push(chalk.gray(notCountedLine(merged.uncostedAgents)));
  console.log(out.join('\n'));
}

function notCountedLine(uncosted: string[]): string {
  const notes: string[] = [];
  if (uncosted.length > 0) notes.push(`no price table for: ${[...new Set(uncosted)].join(', ')} (burn undercounts)`);
  notes.push('cloud runs (Rush/Codex/Factory) not counted');
  return 'not counted: ' + notes.join('  ·  ');
}
