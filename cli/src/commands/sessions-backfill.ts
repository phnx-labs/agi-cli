import chalk from 'chalk';
import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';
import { gatherRemoteAgentsJson, type RemoteAgentsJsonParseResult } from '../lib/remote-agents-json.js';
import { discoverSessions, parseTimeFilter } from '../lib/session/discover.js';
import { machineId } from '../lib/session/sync/config.js';
import { SESSION_AGENTS, type SessionAgentId } from '../lib/session/types.js';
import { ensureToolIndex, readToolIndexCoverage, type ToolIndexCoverage } from '../lib/session/tool-index.js';
import { NO_FANOUT_ENV } from '../lib/session/remote-active.js';
import { backfillResourceUsage, type QueryOptions } from '../lib/session/db.js';
import { runSessionTitleTick, SESSION_TITLE_MAX_PER_TICK, type SessionTitleRunner } from '../lib/session/title.js';

const BACKFILL_REMOTE_TIMEOUT_MS = 10 * 60_000;

export interface ToolBackfillMachineResult {
  machine: string;
  indexedFiles: number;
  indexedCalls: number;
  coverage: ToolIndexCoverage;
}

export interface ToolBackfillEnvelope {
  schemaVersion: 1;
  kind: 'tools-backfill';
  generatedAt: string;
  complete: boolean;
  machines: ToolBackfillMachineResult[];
}

interface ToolBackfillOptions {
  agent?: string;
  project?: string;
  since?: string;
  until?: string;
  unmanaged?: boolean;
  teams?: boolean;
  json?: boolean;
  local?: boolean;
  fleet?: boolean;
  host?: string[] | string;
  device?: string[] | string;
}

function parseAgent(value: string | undefined): { agent?: SessionAgentId; version?: string } {
  if (!value) return {};
  const separator = value.indexOf('@');
  const name = (separator < 0 ? value : value.slice(0, separator)) as SessionAgentId;
  if (!SESSION_AGENTS.includes(name)) throw new Error(`Unknown session agent: ${name}`);
  return { agent: name, version: separator < 0 ? undefined : value.slice(separator + 1) || undefined };
}

function mergeHosts(options: ToolBackfillOptions): string[] {
  const values = [options.host, options.device].flatMap((value) =>
    value === undefined ? [] : Array.isArray(value) ? value : [value]);
  return [...new Set(values)];
}

export async function backfillToolsLocal(
  options: ToolBackfillOptions,
  oneBatch = false,
): Promise<ToolBackfillMachineResult> {
  const { agent, version } = parseAgent(options.agent);
  const sessions = await discoverSessions({
    agent,
    version,
    project: options.project,
    since: options.since,
    until: options.until,
    all: true,
    unbounded: true,
    skipExistenceCheck: true,
    includeUnmanaged: options.unmanaged,
    excludeTeamOrigin: !options.teams,
  });
  let indexedFiles = 0;
  let indexedCalls = 0;
  for (;;) {
    const batch = await ensureToolIndex(sessions);
    indexedFiles += batch.indexedFiles;
    indexedCalls += batch.indexedCalls;
    if (oneBatch || batch.remainingFiles === 0 || batch.indexedFiles === 0) break;
  }
  return {
    machine: machineId(),
    indexedFiles,
    indexedCalls,
    coverage: readToolIndexCoverage(sessions),
  };
}

function parseRemoteBackfill(
  stdout: string,
  machine: string,
): RemoteAgentsJsonParseResult<ToolBackfillMachineResult> {
  try {
    const envelope = JSON.parse(stdout) as ToolBackfillEnvelope;
    if (envelope.schemaVersion !== 1 || envelope.kind !== 'tools-backfill'
      || !Array.isArray(envelope.machines) || envelope.machines.length !== 1) {
      return { items: [], valid: false };
    }
    const item = envelope.machines[0];
    const coverage = item.coverage;
    const coverageKeys = ['indexedFiles', 'indexedCalls', 'skippedFiles', 'limitedFiles', 'remainingFiles'] as const;
    if (!coverage || typeof coverage.complete !== 'boolean'
      || !Number.isSafeInteger(item.indexedFiles) || item.indexedFiles < 0
      || !Number.isSafeInteger(item.indexedCalls) || item.indexedCalls < 0
      || coverageKeys.some((key) => !Number.isSafeInteger(coverage[key]) || coverage[key] < 0)) {
      return { items: [], valid: false };
    }
    return { items: [{ ...item, machine }], valid: true };
  } catch {
    return { items: [], valid: false };
  }
}

function peerArgs(options: ToolBackfillOptions): string[] {
  const args = ['sessions', 'backfill', 'tools', '--json', '--local'];
  if (options.agent) args.push('--agent', options.agent);
  if (options.project) args.push('--project', options.project);
  if (options.since) args.push('--since', options.since);
  if (options.until) args.push('--until', options.until);
  if (options.unmanaged) args.push('--unmanaged');
  if (options.teams) args.push('--teams');
  return args;
}

export async function runToolsBackfill(options: ToolBackfillOptions): Promise<ToolBackfillEnvelope> {
  const hosts = mergeHosts(options);
  const includeLocal = options.local === true || hosts.length === 0;
  const fanOut = options.local !== true && (options.fleet === true || hosts.length > 0);
  if (!fanOut) {
    const machines = includeLocal
      ? [await backfillToolsLocal(options, process.env[NO_FANOUT_ENV] === '1')]
      : [];
    return {
      schemaVersion: 1,
      kind: 'tools-backfill',
      generatedAt: new Date().toISOString(),
      complete: machines.every((machine) => machine.coverage.complete),
      machines,
    };
  }

  const machineTotals = new Map<string, ToolBackfillMachineResult>();
  let unreachable = false;
  for (;;) {
    const localPromise = includeLocal ? backfillToolsLocal(options, true) : Promise.resolve(undefined);
    const [local, remote] = await Promise.all([localPromise, gatherRemoteAgentsJson<ToolBackfillMachineResult>({
      args: peerArgs(options),
      noFanoutEnv: NO_FANOUT_ENV,
      hosts: hosts.length > 0 ? hosts : undefined,
      timeoutMs: BACKFILL_REMOTE_TIMEOUT_MS,
      parse: parseRemoteBackfill,
    })]);
    const round = [local, ...remote.items].filter((item): item is ToolBackfillMachineResult => item !== undefined);
    for (const item of round) {
      const prior = machineTotals.get(item.machine);
      machineTotals.set(item.machine, {
        ...item,
        indexedFiles: (prior?.indexedFiles ?? 0) + item.indexedFiles,
        indexedCalls: (prior?.indexedCalls ?? 0) + item.indexedCalls,
      });
    }
    unreachable = remote.discoveryFailed || remote.skipped.length > 0 || remote.parseFailed.length > 0;
    const progressed = round.reduce((sum, item) => sum + item.indexedFiles, 0);
    if (unreachable || progressed === 0 || (round.length > 0 && round.every((item) => item.coverage.complete))) break;
  }
  const machines = [...machineTotals.values()];
  return {
    schemaVersion: 1,
    kind: 'tools-backfill',
    generatedAt: new Date().toISOString(),
    complete: !unreachable && machines.every((machine) => machine.coverage.complete),
    machines,
  };
}

interface ResourceBackfillOptions {
  agent?: string;
  project?: string;
  since?: string;
  until?: string;
  teams?: boolean;
  json?: boolean;
}

export interface ResourceBackfillEnvelope {
  schemaVersion: 1;
  kind: 'resources-backfill';
  generatedAt: string;
  machine: string;
  /** Sessions considered (matched the filter, had a real transcript). */
  scanned: number;
  /** Sessions (re)parsed and written this run. */
  updated: number;
  /** Sessions already current at this extractor version, skipped. */
  skipped: number;
  /** Sessions whose transcript could not be stat'd or parsed. */
  failed: number;
  /** Total session_resource_usage rows written across updated sessions. */
  resourceRows: number;
}

/**
 * Populate session_resource_usage for historical sessions on THIS machine.
 * Local-only by design: the resource signal is derived from each machine's own
 * transcripts, and the index is machine-local, so there is no cross-machine
 * merge to do — run it on each box (or over `agents ssh`). Ensures the session
 * index is complete first (discoverSessions), then re-derives usage gated by the
 * resource_scan_ledger so reruns skip completed transcripts.
 */
export async function runResourceBackfill(options: ResourceBackfillOptions): Promise<ResourceBackfillEnvelope> {
  const { agent, version } = parseAgent(options.agent);
  // Make sure every matching transcript is indexed before we re-derive usage.
  await discoverSessions({
    agent,
    version,
    project: options.project,
    since: options.since,
    until: options.until,
    all: true,
    unbounded: true,
    skipExistenceCheck: true,
    excludeTeamOrigin: !options.teams,
  });
  const filter: QueryOptions = { excludeTeamOrigin: !options.teams };
  if (agent) filter.agent = agent;
  if (version) filter.version = version;
  if (options.project) filter.project = options.project;
  if (options.since) filter.sinceMs = parseTimeFilter(options.since);
  if (options.until) filter.untilMs = parseTimeFilter(options.until);
  const result = backfillResourceUsage(filter);
  return {
    schemaVersion: 1,
    kind: 'resources-backfill',
    generatedAt: new Date().toISOString(),
    machine: machineId(),
    ...result,
  };
}

interface TitleBackfillOptions {
  session?: string;
  limit?: string;
  refresh?: boolean;
  json?: boolean;
  /** The injectable model call (`SessionTitleRunner`); not a CLI flag — tests pass it. */
  run?: SessionTitleRunner;
}

export interface TitleBackfillEnvelope {
  schemaVersion: 1;
  kind: 'titles-backfill';
  generatedAt: string;
  machine: string;
  scanned: number;
  cached: number;
  generated: number;
  failed: number;
  titles: Array<{ id: string; title: string }>;
}

/**
 * Generate session headlines NOW instead of waiting for the daemon's sweep — the
 * explicit-refresh half of PHNX-3797. Same code path the `session-title` service
 * ticks, so there is one generator: this only changes when it runs, how many it
 * does, and (with `--refresh`) whether an already-current title is regenerated.
 */
export async function runTitlesBackfill(options: TitleBackfillOptions): Promise<TitleBackfillEnvelope> {
  const parsedLimit = options.limit ? Number.parseInt(options.limit, 10) : undefined;
  if (options.limit !== undefined && (!Number.isFinite(parsedLimit) || (parsedLimit as number) < 1)) {
    throw new Error(`--limit must be a positive integer (got "${options.limit}")`);
  }
  const result = await runSessionTitleTick({
    ...(options.session ? { id: options.session } : {}),
    ...(options.run ? { run: options.run } : {}),
    limit: parsedLimit ?? (options.session ? 1 : SESSION_TITLE_MAX_PER_TICK * 5),
    force: Boolean(options.refresh),
  });
  return {
    schemaVersion: 1,
    kind: 'titles-backfill',
    generatedAt: new Date().toISOString(),
    machine: machineId(),
    ...result,
  };
}

export function registerSessionsBackfillCommand(sessionsCmd: Command): void {
  const backfill = sessionsCmd.command('backfill').description('Populate derived session data explicitly.');
  const tools = backfill.command('tools').description('Parse historical tool calls once into the local SQLite index.');
  setHelpSections(tools, {
    examples: `
      # Backfill this machine once; reruns resume and skip completed transcripts
      agents sessions backfill tools

      # Backfill every online compute device, keeping each index local
      agents sessions backfill tools --fleet --json

      # Narrow the historical work
      agents sessions backfill tools --agent codex --since 7d
    `,
    notes: `
      - This command is the only historical transcript parse for tool indexing. Tool queries never trigger it.
      - New and changed sessions are indexed during their normal incremental scan.
      - No embeddings, vector database, network model, or semantic processing is used.
    `,
  });
  tools.action(async (_options: unknown, command: Command) => {
    const options = command.optsWithGlobals() as ToolBackfillOptions;
    if (options.local && (options.fleet || mergeHosts(options).length > 0)) {
      console.error(chalk.red('--local cannot be combined with --fleet or --device.'));
      process.exitCode = 1;
      return;
    }
    try {
      const envelope = await runToolsBackfill(options);
      if (options.json) process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
      else {
        for (const machine of envelope.machines) {
          console.log(`${machine.machine}: indexed ${machine.indexedFiles.toLocaleString()} transcript${machine.indexedFiles === 1 ? '' : 's'} and ${machine.indexedCalls.toLocaleString()} tool call${machine.indexedCalls === 1 ? '' : 's'}.`);
        }
        if (!envelope.complete) {
          console.log(chalk.yellow('Backfill is partial; rerun the command after resolving skipped or limited transcripts.'));
        }
      }
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    }
  });

  const resources = backfill.command('resources').description('Derive historical skill/slash-command usage once into the local SQLite index.');
  setHelpSections(resources, {
    examples: `
      # Fold every historical session on this machine into the usage index
      agents sessions backfill resources

      # Narrow the historical work
      agents sessions backfill resources --agent claude --since 30d

      # Machine-readable summary
      agents sessions backfill resources --json
    `,
    notes: `
      - Populates session_resource_usage for sessions indexed before the usage signal shipped. New/changed sessions are recorded on their normal scan; this is the one-shot catch-up read by \`agents sessions stats\`.
      - Local-only: the signal is derived per machine from its own transcripts. Run it on each box (or over \`agents ssh <host> agents sessions backfill resources\`).
      - Reruns skip transcripts already current (resource_scan_ledger); bump the extractor version to force a full re-derive.
      - Only slash commands and \`Skill\` tool calls are recorded — auto-triggered skills emit no signal.
    `,
  });
  resources.action(async (_options: unknown, command: Command) => {
    const options = command.optsWithGlobals() as ResourceBackfillOptions;
    try {
      const envelope = await runResourceBackfill(options);
      if (options.json) process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
      else {
        console.log(
          `${envelope.machine}: derived usage for ${envelope.updated.toLocaleString()} session${envelope.updated === 1 ? '' : 's'} ` +
            `(${envelope.resourceRows.toLocaleString()} resource row${envelope.resourceRows === 1 ? '' : 's'}); ` +
            `${envelope.skipped.toLocaleString()} already current, ${envelope.scanned.toLocaleString()} scanned.`,
        );
        if (envelope.failed > 0) {
          console.log(chalk.yellow(`${envelope.failed.toLocaleString()} transcript${envelope.failed === 1 ? '' : 's'} could not be parsed; rerun to retry.`));
        }
      }
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    }
  });

  const titles = backfill
    .command('titles')
    .description('Generate the session-row headline (a short technical title) now, instead of waiting for the daemon.')
    .option('--session <id>', 'Title one session (full or short id), even if it is old or already titled')
    .option('--limit <n>', 'Maximum titles to generate in this run')
    .option('--refresh', 'Regenerate even when the stored title still matches the session\'s first user message')
    .option('--json', 'Emit the machine-readable result');
  setHelpSections(titles, {
    examples: `
      # Catch this machine up now (the daemon otherwise does a couple every 2 min)
      agents sessions backfill titles

      # Re-title one session after correcting its first message
      agents sessions backfill titles --session 6fc1db18 --refresh

      # Machine-readable
      agents sessions backfill titles --limit 20 --json
    `,
    notes: `
      - The headline ladder is: \`/rename\` label > this generated title > the user's first message. It is never the agent's latest turn.
      - One cheap-model call per session (\`--model cheap\`, read-only plan mode), generated ONCE and persisted; a session whose first message has not changed is a pure cache hit.
      - Local-only: each box titles its own sessions and publishes them to the fleet via the session mirror, so a peer's rows already carry their titles.
      - Best-effort. With no signed-in harness nothing is generated and rows keep showing the user's own words.
    `,
  });
  titles.action(async (_options: unknown, command: Command) => {
    const options = command.optsWithGlobals() as TitleBackfillOptions;
    try {
      const envelope = await runTitlesBackfill(options);
      if (options.json) process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
      else {
        console.log(
          `${envelope.machine}: generated ${envelope.generated.toLocaleString()} title${envelope.generated === 1 ? '' : 's'}; ` +
            `${envelope.cached.toLocaleString()} already current, ${envelope.scanned.toLocaleString()} scanned.`,
        );
        for (const { id, title } of envelope.titles) console.log(`  ${chalk.cyan(id.slice(0, 8))}  ${title}`);
        if (envelope.failed > 0) {
          console.log(chalk.yellow(`${envelope.failed.toLocaleString()} session${envelope.failed === 1 ? '' : 's'} produced no usable title; rerun to retry.`));
        }
      }
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    }
  });
}
