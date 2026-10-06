import type { Command } from 'commander';
import chalk from 'chalk';

import { discoverSessions, parseTimeFilter } from '../lib/session/discover.js';
import {
  queryResourceUsageStats,
  resourceUsageCoverage,
  type QueryOptions,
  type ResourceStatRow,
} from '../lib/session/db.js';
import { listResources } from '../lib/resources.js';
import { discoverPlugins } from '../lib/plugins/plugins.js';
import { setHelpSections } from '../lib/help.js';
import { terminalWidth, truncateToWidth, padToWidth, stringWidth } from '../lib/session/width.js';

interface StatsOpts {
  kind?: string;
  plugin?: string;
  agent?: string;
  project?: string;
  since?: string;
  machine?: string;
  top?: string;
  bottom?: boolean;
  zero?: boolean;
  json?: boolean;
}

const DEFAULT_TOP = 20;

const RECORDING_SKILL_HARNESSES = ['claude', 'kimi'] as const;
const RECORDING_COMMAND_HARNESSES = ['claude'] as const;

interface InstalledResource {
  kind: 'skill' | 'command';
  name: string;
  plugin: string | null;
  source: string | null;
}

export function diffZeroInvoked(
  installed: InstalledResource[],
  invoked: Array<{ kind: string; name: string }>,
): InstalledResource[] {
  const invokedKeys = new Set(invoked.map(r => `${r.kind}:${r.name}`));
  return installed
    .filter(r => !invokedKeys.has(`${r.kind}:${r.name}`))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)));
}

function installedResources(
  kindFilter: 'skill' | 'command' | undefined,
  pluginFilter: string | undefined,
  cwd: string | undefined,
): InstalledResource[] {
  const kinds: Array<'skill' | 'command'> = kindFilter ? [kindFilter] : ['skill', 'command'];
  const byKey = new Map<string, InstalledResource>();
  const plugins = discoverPlugins({ cwd });
  for (const kind of kinds) {
    const listKind = kind === 'skill' ? 'skills' : 'commands';
    if (!pluginFilter) {
      for (const r of listResources(listKind, cwd)) {
        byKey.set(`${kind}:${r.name}`, { kind, name: r.name, plugin: null, source: r.source });
      }
    }
    for (const p of plugins) {
      if (pluginFilter && p.name !== pluginFilter) continue;
      const names = kind === 'skill' ? p.skills : p.commands;
      for (const short of names) {
        const name = `${p.name}:${short}`;
        byKey.set(`${kind}:${name}`, { kind, name, plugin: p.name, source: p.marketplace ?? null });
      }
    }
  }
  return [...byKey.values()];
}

export function registerSessionsStatsCommand(sessionsCmd: Command): void {
  configureStatsCommand(sessionsCmd.command('stats'), 'agents sessions stats');
}

export function registerInsightsResourcesCommand(insightsCmd: Command): void {
  configureStatsCommand(insightsCmd.command('resources'), 'agents insights resources');
}

function configureStatsCommand(stats: Command, spelling: string): void {
  stats
    .description('Which skills/commands you actually invoke, and which installed ones are dead weight.')
    .option('--kind <kind>', 'Limit to one kind: skill or command')
    .option('--plugin <name>', "Only this plugin's resources (r.plugin), not every resource a plugin-touching session used")
    .option('-a, --agent <agent>', 'Only sessions from this agent (e.g. claude)')
    .option('-p, --project <name>', 'Only sessions in this project')
    .option('--machine <name>', 'Only sessions recorded on this machine (host)')
    .option('--since <time>', 'Only sessions newer than this (e.g. 7d, 30d, or ISO date)')
    .option('--top <n>', `How many ranked rows to show (default ${DEFAULT_TOP})`)
    .option('--bottom', 'Rank the least-invoked resources first instead of the most-invoked')
    .option('--zero', 'Show only installed-but-never-invoked resources (the dead weight)')
    .option('--json', 'Output the stats as JSON')
    .action(async (_opts, cmd: Command) => {
      await statsAction(cmd);
    });

  setHelpSections(stats, {
    examples: `
      # Most-invoked skills and commands, plus the installed ones you never invoke
      ${spelling}

      # Just the dead weight — installed but never explicitly invoked
      ${spelling} --zero

      # Skills only, last 30 days, machine-readable
      ${spelling} --kind skill --since 30d --json

      # One plugin's resources, least-used first
      ${spelling} --plugin rush --bottom

      # Backfill historical sessions first if coverage is low
      agents sessions backfill resources
    `,
    notes: `
      - The signal captures EXPLICIT invocations only: slash commands and \`Skill\` tool calls. An auto-triggered skill (loaded by description match) emits no event, so it reads as 0 — that means "never explicitly invoked", not "never loaded".
      - Skill invocations are recorded for Claude and Kimi; slash-commands for Claude only. Other harnesses contribute nothing to these counts.
      - Counts come from the SQLite index. New/changed sessions are recorded on their normal scan; run \`agents sessions backfill resources\` once to fold in historical sessions (a low coverage line means it hasn't run).
      - --plugin filters the resource rows (this plugin's skills/commands), distinct from the top-level \`agents sessions --plugin\` which filters SESSIONS.
      - The window is all time unless --since narrows it. \`agents insights resources\` and \`agents sessions stats\` are the same report; --json keeps \`kind: "sessions-stats"\` under either spelling.
    `,
  });
}

/**
 * Both parents also declare --agent: `sessions` as one string, `insights` as a
 * repeatable list defaulting to []. Commander hands a flag written after the
 * subcommand to whichever ancestor knows it, so the value can sit on any level.
 * An empty list is unset; more than one distinct agent is rejected because the
 * index query filters on exactly one.
 */
export function resolveStatsAgent(values: unknown[]): string | undefined {
  const agents = [...new Set(values.flatMap(v => (Array.isArray(v) ? v : v === undefined ? [] : [v])).map(String))];
  if (agents.length > 1) {
    console.error(chalk.red(`error: resource usage filters on one --agent; got ${agents.join(', ')}`));
    process.exit(1);
  }
  return agents[0];
}

async function statsAction(cmd: Command): Promise<void> {
  const agentValues: unknown[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) agentValues.push(c.opts().agent);
  const opts: StatsOpts = { ...(cmd.optsWithGlobals() as StatsOpts), agent: resolveStatsAgent(agentValues) };

  const kind = normalizeKind(opts.kind);
  const sinceMs = opts.since ? parseTimeFilter(opts.since) : undefined;
  const top = resolveTop(opts.top);

  await discoverSessions({ all: true, since: opts.since, limit: 1 });

  const filter: QueryOptions = {};
  if (opts.agent) filter.agent = opts.agent as QueryOptions['agent'];
  if (opts.project) filter.project = opts.project;
  if (opts.machine) filter.machine = opts.machine;
  if (typeof sinceMs === 'number') filter.sinceMs = sinceMs;

  const statsOpts = {
    ...filter,
    kind,
    pluginFilter: opts.plugin,
    order: opts.bottom ? ('bottom' as const) : ('top' as const),
  };

  const allInvoked = queryResourceUsageStats(statsOpts);
  const ranked = top > 0 ? allInvoked.slice(0, top) : allInvoked;

  const installed = installedResources(kind, opts.plugin, process.cwd());
  const zeroInvoked = diffZeroInvoked(installed, allInvoked);

  const coverage = resourceUsageCoverage();
  const totalInvocations = allInvoked.reduce((s, r) => s + r.invocations, 0);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          schemaVersion: 2,
          kind: 'sessions-stats',
          generatedAt: new Date().toISOString(),
          filters: {
            kind: kind ?? null,
            plugin: opts.plugin ?? null,
            agent: opts.agent ?? null,
            project: opts.project ?? null,
            machine: opts.machine ?? null,
            since: opts.since ?? null,
          },
          signal: {
            explicitOnly: true,
            note: 'Explicit invocations only (slash commands + Skill tool calls). Auto-triggered skills emit no event and read as 0. Skill invocations are recorded for Claude and Kimi; slash-commands for Claude only.',
            recording: {
              skills: RECORDING_SKILL_HARNESSES,
              commands: RECORDING_COMMAND_HARNESSES,
            },
          },
          coverage: {
            sessionsWithUsage: coverage.covered,
            sessionsScanned: coverage.scanned,
            sessionsIndexed: coverage.total,
          },
          totals: {
            invokedResources: allInvoked.length,
            invocations: totalInvocations,
            zeroInvoked: zeroInvoked.length,
          },
          order: opts.bottom ? 'bottom' : 'top',
          ranked: ranked.map(serializeRow),
          zeroInvoked: zeroInvoked.map(r => ({
            kind: r.kind,
            name: r.name,
            plugin: r.plugin,
            source: r.source,
          })),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  renderHuman({ opts, kind, ranked, zeroInvoked, coverage, totalInvocations, allInvokedCount: allInvoked.length, top });
}

function serializeRow(r: ResourceStatRow): {
  kind: string;
  name: string;
  plugin: string | null;
  source: string | null;
  sessions: number;
  invocations: number;
} {
  return {
    kind: r.kind,
    name: r.name,
    plugin: r.plugin,
    source: r.source,
    sessions: r.sessions,
    invocations: r.invocations,
  };
}

function normalizeKind(raw: string | undefined): 'skill' | 'command' | undefined {
  if (raw === undefined) return undefined;
  const k = raw.toLowerCase();
  if (k === 'skill' || k === 'skills') return 'skill';
  if (k === 'command' || k === 'commands') return 'command';
  console.error(chalk.red('error: --kind must be one of: skill, command'));
  process.exit(1);
}

function resolveTop(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TOP;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    console.error(chalk.red('error: --top must be a non-negative integer'));
    process.exit(1);
  }
  return n;
}

function renderHuman(args: {
  opts: StatsOpts;
  kind: 'skill' | 'command' | undefined;
  ranked: ResourceStatRow[];
  zeroInvoked: InstalledResource[];
  coverage: { covered: number; scanned: number; total: number };
  totalInvocations: number;
  allInvokedCount: number;
  top: number;
}): void {
  const { opts, kind, ranked, zeroInvoked, coverage, totalInvocations, allInvokedCount } = args;
  const out: string[] = [];

  const scopeBits = [
    kind ? kind : null,
    opts.plugin ? `plugin ${opts.plugin}` : null,
    opts.agent ? opts.agent : null,
    opts.project ? `project ${opts.project}` : null,
    opts.machine ? opts.machine : null,
    opts.since ? `since ${opts.since}` : null,
  ].filter(Boolean);
  out.push(
    chalk.bold('Resource usage') +
      chalk.gray(`  ·  ${allInvokedCount} invoked · ${totalInvocations} invocation${totalInvocations !== 1 ? 's' : ''}` +
        (scopeBits.length ? `  ·  ${scopeBits.join(' · ')}` : '')),
  );
  out.push(
    chalk.gray(`  coverage: ${coverage.scanned}/${coverage.total} sessions scanned · ${coverage.covered} carry an explicit invocation`) +
      (coverage.total > 0 && coverage.scanned / coverage.total < 0.5
        ? chalk.yellow('  — run `agents sessions backfill resources` to fold in history')
        : ''),
  );
  out.push(chalk.gray('  signal: explicit invocations only (slash commands + Skill tool); auto-triggered skills read as 0; skills from Claude+Kimi, slash-commands Claude-only'));
  out.push('');

  if (!opts.zero) {
    const heading = opts.bottom ? 'Least invoked' : 'Most invoked';
    out.push(chalk.bold(heading));
    if (ranked.length === 0) {
      out.push(chalk.gray('  (no explicit invocations recorded — run the backfill, or nothing has been invoked yet)'));
    } else {
      out.push(...renderRankedTable(ranked));
    }
    out.push('');
  }

  out.push(chalk.bold('Installed but never explicitly invoked') + chalk.gray(`  (${zeroInvoked.length})`));
  if (zeroInvoked.length === 0) {
    out.push(chalk.gray('  (every installed resource has at least one explicit invocation in this window)'));
  } else {
    const cols = terminalWidth();
    for (const r of zeroInvoked) {
      const tag = chalk.gray(`[${r.kind}]`);
      const owner = r.plugin ? chalk.gray(`  ${r.plugin}`) : r.source ? chalk.gray(`  ${r.source}`) : '';
      const nameW = Math.max(12, cols - 12 - stringWidth(owner));
      out.push(`  ${tag} ${truncateToWidth(r.name, nameW)}${owner}`);
    }
  }

  console.log(out.join('\n'));
}

function renderRankedTable(rows: ResourceStatRow[]): string[] {
  const cols = terminalWidth();
  const invW = Math.max(...rows.map(r => String(r.invocations).length), 3);
  const sessW = Math.max(...rows.map(r => `${r.sessions} sess`.length), 6);
  const lines: string[] = [];
  for (const r of rows) {
    const inv = String(r.invocations).padStart(invW);
    const sess = padToWidth(`${r.sessions} sess`, sessW);
    const tag = chalk.gray(`[${r.kind}]`);
    const owner = r.plugin ? chalk.gray(`  ${r.plugin}`) : r.source ? chalk.gray(`  ${r.source}`) : '';
    const prefix = `  ${chalk.green(inv)}  ${chalk.gray(sess)}  ${tag} `;
    const suffix = owner;
    const nameW = Math.max(12, cols - stringWidth(prefix) - stringWidth(suffix));
    lines.push(prefix + truncateToWidth(r.name, nameW) + suffix);
  }
  return lines;
}
