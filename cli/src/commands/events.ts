/**
 * `agents events` — read the unified event stream (the one ops/timeline product).
 *
 * One stream over BOTH operational events (`~/.agents/.history/events/YYYY-MM-DD/`:
 * every `agents <module> <cmd>` invocation plus typed events like secrets access,
 * browser/computer, daemon lifecycle, version installs) AND agent-semantic events
 * (per-session activity: plans, PRs, worktrees, sub-agents, artifacts). Run-dispatch
 * outcomes land here as `run.dispatched` (readable via `--include runs`).
 *
 * `agents events audit` and `agents logs` are thin aliases of this command.
 *
 * Filter with sessions-style `--include` / `--exclude` families (ops, activity,
 * commands, runs, security) plus field filters (`--module`, `--event`, …).
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import { getLogsPath, stats, rotate, type EventRecord, type EventType, type EventLevel } from '../lib/feed/events.js';
import { readUnifiedEvents } from '../lib/event-stream.js';
import { parseFamilyList, EVENT_FAMILIES, type EventFamily } from '../lib/event-families.js';
import { ingestBatch } from '../lib/events-ingest.js';
import { setHelpSections } from '../lib/help.js';
import { registerAuditCommands } from './audit.js';

/**
 * Resolve `--limit` into a record cap. `0` means "no cap" — without it there is
 * no way to read the whole stream, and any aggregation (group-by failure, count
 * per module) silently ranks the newest 50 records instead of the real set.
 * A non-numeric or negative value is a usage error, not a quiet fallback.
 */
export function resolveEventsLimit(raw: string | undefined): number | undefined {
  const token = raw ?? '50';
  // Number('') and Number('   ') are both 0, which would read as "no cap" — an
  // empty --limit (an unset "$LIMIT" in a script) must be rejected, not silently
  // turned into the unbounded read.
  const value = token.trim() === '' ? NaN : Number(token);
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`Invalid --limit ${raw} — pass a whole number, or 0 for no cap.`);
  }
  return value === 0 ? undefined : value;
}

/**
 * Cap `fetched` (read with `limit + 1`) to `limit`, reporting whether records
 * were dropped. The caller announces the cap so a truncated read is never
 * mistaken for the complete set.
 */
export function capRecords<T>(fetched: T[], limit: number | undefined): { records: T[]; truncated: boolean } {
  if (limit === undefined || fetched.length <= limit) return { records: fetched, truncated: false };
  return { records: fetched.slice(0, limit), truncated: true };
}

export interface EventsOptions {
  module?: string;
  command?: string;
  event?: string[];
  agent?: string;
  caller?: string;
  level?: string;
  session?: string;
  bundle?: string;
  since?: string;
  limit?: string;
  json?: boolean;
  follow?: boolean;
  include?: string;
  exclude?: string;
}

/** Parse `--since`: relative offsets (30s/5m/2h/7d/4w) or an ISO/absolute date. */
function parseSince(s: string): Date {
  const m = s.match(/^(\d+)([smhdw])$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unitMs: Record<string, number> = {
      s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000,
    };
    return new Date(Date.now() - n * unitMs[m[2]]);
  }
  const ms = Date.parse(s);
  if (isNaN(ms)) throw new Error(`Invalid --since value: ${s} (use e.g. 2h, 7d, or an ISO date)`);
  return new Date(ms);
}

/** How the run reached this host — 'local' or 'ssh 203.0.113.7'. */
function originLabel(r: EventRecord): string {
  if (r.transport === 'ssh') {
    return chalk.yellow(`ssh${r.sshClientIp ? ' ' + r.sshClientIp : ''}`);
  }
  return chalk.gray('local');
}

/** The most useful one-line detail for a record, by event family. */
function detailFor(r: EventRecord): string {
  if (r.command) return r.command;
  const bits: string[] = [];
  // Agent-semantic (activity) events carry detail/url instead of a command.
  if (typeof r.detail === 'string') bits.push(r.detail);
  if (typeof r.url === 'string') bits.push(chalk.gray(r.url));
  if (typeof r.team === 'string') bits.push(`team=${r.team}`);
  if (typeof r.bundle === 'string') bits.push(`bundle=${r.bundle}`);
  if (typeof r.skill === 'string') bits.push(`skill=${r.skill}`);
  if (typeof r.version === 'string') bits.push(`v=${r.version}`);
  // run.dispatched (and similar) — mode / outcome / exit / repo are the audit line.
  if (typeof r.mode === 'string') bits.push(`mode=${r.mode}`);
  if (typeof r.outcome === 'string') bits.push(`outcome=${r.outcome}`);
  if (typeof r.exitCode === 'number') bits.push(`exit=${r.exitCode}`);
  if (typeof r.repo === 'string') bits.push(chalk.gray(r.repo));
  if (typeof r.profile === 'string') bits.push(`profile=${r.profile}`);
  if (typeof r.error === 'string') bits.push(chalk.red(r.error));
  return bits.join(' ');
}

function renderRow(r: EventRecord): string {
  const time = chalk.gray(r.ts.slice(0, 19).replace('T', ' '));
  const user = `${r.osUser ?? '?'}@${r.hostname}`;
  const ev = r.event.startsWith('error') ? chalk.red(r.event) : chalk.cyan(r.event);
  const agent = r.agent ? chalk.gray(` ${r.agent}`) : '';
  return `${time}  ${originLabel(r).padEnd(24)} ${user.padEnd(22)} ${ev.padEnd(26)}${agent}  ${detailFor(r)}`;
}

/** Read all of stdin. Returns '' when nothing is piped. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

function registerEmitSubcommand(events: Command): void {
  const emitCmd = events
    .command('emit')
    .description('Record events produced outside this process (reads JSONL on stdin)')
    .requiredOption('--source <name>', 'Producer name; stamped as `module` so `events --module <name>` filters to it')
    .option('--dry-run', 'Validate and report without writing')
    .option('--json', 'Report {written, rejected} as JSON')
    .action(async (
      opts: { source: string; dryRun?: boolean; json?: boolean },
      cmd?: { parent?: { opts: () => { json?: boolean } } },
    ) => {
      // The parent `events` command also declares `--json` (for its read view).
      // Commander binds a flag declared on BOTH to the parent, so a bare
      // `events emit … --json` lands on parent.opts().json and the child sees
      // undefined — the human string would print where a caller expects JSON.
      // Read both, same as `feed post`.
      const wantJson = Boolean(opts?.json ?? cmd?.parent?.opts?.().json);
      const input = await readStdin();
      if (input.trim() === '') {
        console.error('events emit: nothing on stdin — pipe one JSON object per line.');
        process.exitCode = 1;
        return;
      }

      let result;
      try {
        result = ingestBatch(input, { source: opts.source, dryRun: opts.dryRun });
      } catch (err) {
        console.error(`events emit: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }

      if (wantJson) {
        console.log(JSON.stringify({ written: result.written, rejected: result.rejected, routed: result.routed }, null, 2));
      } else if (result.rejected.length === 0) {
        console.log(`${result.written} event(s) recorded${opts.dryRun ? ' (dry run)' : ''}.`);
      } else {
        console.log(`${result.written} event(s) recorded${opts.dryRun ? ' (dry run)' : ''}.`);
        console.error(`rejected ${result.rejected.length} line(s):`);
        for (const r of result.rejected) console.error(`  line ${r.line}: ${r.reason}`);
      }
      // Valid siblings are already written; a non-zero exit reports that the
      // batch was not fully accepted without pretending nothing landed.
      if (result.rejected.length > 0) process.exitCode = 1;
    });

  setHelpSections(emitCmd, {
    examples: `
      # 1. Produce one JSON object per line (this is the whole input format).
      printf '%s\\n' '{"event":"factory.command","commandId":"agents.newClaude"}' \\
        | agents events emit --source factory

      # 2. Flush a batch and check what landed.
      agents events emit --source factory --json < batch.jsonl

      # 3. Read it back. --limit 0 matters whenever you aggregate.
      agents events --module factory --limit 0 --json
    `,
    notes: `
      \`event\` is required and must be a known kind. \`ts\` (ISO-8601) is optional
      and defaults to now — pass it so a batched producer records when each event
      HAPPENED rather than when it flushed.

      Envelope keys: ts, sessionId, mailboxId, terminalId, launchId, tmuxPane,
      host, runtime, agent, tool, detail, url, project, cwd. Any other key is
      payload and passes through the usual redaction.

      A milestone kind (e.g. factory.launch) REQUIRES a sessionId — the activity
      log is one file per session. Milestones route there; everything else goes
      to the operational log. \`agents events\` reads both.

      Rejection is per line: one bad line never discards the batch. Exit is 1 if
      any line was rejected.
    `,
  });
}

/** Add the one canonical event-reader option surface to a command or alias. */
export function addEventsReadOptions(command: Command): Command {
  command
    .option('--include <families>', `Only these families (comma-sep): ${EVENT_FAMILIES.join(', ')}`)
    .option('--exclude <families>', `Drop these families (comma-sep): ${EVENT_FAMILIES.join(', ')}`)
    .option('--module <name>', 'Only events from this group (e.g. teams, secrets, activity, daemon, routine, watchdog, browser)')
    .option('--command <path>', 'Only this command path — prefix match (e.g. "teams create")')
    .option('--event <type>', 'Only this typed event (repeatable, e.g. secrets.get, run.dispatched, pr.opened)', collect, [])
    .option('--agent <name>', 'Only events tagged with this agent')
    .option('--caller <kind>', 'Only this caller kind (claude-code, codex, cursor, terminal, script)')
    .option('--level <level>', 'Only this level: audit, warn, info, debug')
    .option('--session <id>', 'Only events from this session (the provenance sessionId) — e.g. trace which session read a secret')
    .option('--bundle <name>', 'Only events carrying this bundle in their payload — e.g. `--module secrets --bundle share` for every read of the share bundle')
    .option('--since <time>', 'Only events newer than this (e.g. 2h, 7d, or ISO date)')
    .option('--limit <n>', 'Max records to show; 0 for no cap (default 50)', '50')
    .option('--json', 'Output raw records as JSON')
    .option('-f, --follow', "Tail today's operational log live");
  return command;
}

/** Canonical reader used by `agents events`, `agents events audit`, and `agents logs`. */
export async function runEventsCommand(options: EventsOptions, forceAudit: boolean = false): Promise<void> {
  if (options.follow) {
    await followLog();
    return;
  }

  let limit: number | undefined;
  let startDate: Date | undefined;
  let includeFamilies: EventFamily[] | undefined;
  let excludeFamilies: EventFamily[] | undefined;
  try {
    limit = resolveEventsLimit(options.limit);
    startDate = options.since ? parseSince(options.since) : undefined;
    if (options.include && options.exclude) {
      throw new Error('--include and --exclude are mutually exclusive');
    }
    if (options.include) includeFamilies = parseFamilyList(options.include, '--include');
    if (options.exclude) excludeFamilies = parseFamilyList(options.exclude, '--exclude');
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exitCode = 2;
    return;
  }

  // forceAudit (`events audit` / `logs`) = ops-only when no family flags. Families
  // own the source selection via applyFamilies — never override includeActivity after.
  const includeActivity = (includeFamilies !== undefined || excludeFamilies !== undefined)
    ? true
    : !forceAudit;

  const fetched = readUnifiedEvents({
    startDate,
    eventTypes: options.event && options.event.length ? (options.event as EventType[]) : undefined,
    level: options.level as EventLevel | undefined,
    agent: options.agent,
    sessionId: options.session,
    bundle: options.bundle,
    caller: options.caller,
    command: options.command,
    module: options.module,
    limit: limit === undefined ? undefined : limit + 1,
    includeActivity,
    includeFamilies,
    excludeFamilies,
  });
  const { records, truncated } = capRecords(fetched, limit);
  const capNote = `Showing the newest ${limit} — more events matched. Pass --limit 0 for all.`;

  if (options.json) {
    if (truncated) console.error(chalk.yellow(capNote));
    console.log(JSON.stringify(records, null, 2));
    return;
  }

  if (records.length === 0) {
    console.log(chalk.gray('No matching events.'));
    return;
  }

  for (const r of records.slice().reverse()) console.log(renderRow(r));
  console.log(chalk.gray(`\n${records.length} event(s). Log: ${getLogsPath()}`));
  if (truncated) console.log(chalk.yellow(capNote));
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function levelColor(level: string): string {
  if (level === 'audit') return chalk.magenta(level);
  if (level === 'warn') return chalk.yellow(level);
  if (level === 'debug') return chalk.gray(level);
  return chalk.blue(level);
}

/** Shared by `events stats` and the `logs stats` alias. */
export async function runEventsStats(opts: { since?: string; json?: boolean }): Promise<void> {
  let days = 7;
  if (opts.since) {
    try {
      const d = parseSince(opts.since);
      days = Math.max(1, Math.ceil((Date.now() - d.getTime()) / 86_400_000));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 2;
      return;
    }
  }
  const s = stats({ days });
  if (opts.json) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  console.log(chalk.bold(`Event statistics (last ${days} day${days === 1 ? '' : 's'})\n`));
  console.log(`  Total events:  ${s.totalEvents}`);
  console.log(`  Log files:     ${s.fileCount} (${humanBytes(s.totalBytes)})`);
  console.log(`  Log path:      ${chalk.gray(getLogsPath())}`);
  if (Object.keys(s.byLevel).length) {
    console.log(chalk.bold('\n  By level:'));
    for (const [k, v] of Object.entries(s.byLevel).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${levelColor(k).padEnd(20)} ${v}`);
    }
  }
  if (Object.keys(s.byEvent).length) {
    console.log(chalk.bold('\n  By event (top 15):'));
    for (const [k, v] of Object.entries(s.byEvent).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`    ${chalk.cyan(k).padEnd(30)} ${v}`);
    }
  }
  if (Object.keys(s.byModule).length) {
    console.log(chalk.bold('\n  By module:'));
    for (const [k, v] of Object.entries(s.byModule).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(20)} ${v}`);
    }
  }
  console.log();
}

export function registerEventsCommand(program: Command): void {
  const events = addEventsReadOptions(program
    .command('events')
    .description('Read the unified event stream (ops + activity + run dispatch)'))
    .addHelpText('after', `
Examples:
  agents events                          Everything — ops + agent activity
  agents events --exclude commands       Drop CLI command.start/end noise
  agents events --include runs           Dispatched-run outcomes (was audit list)
  agents events --include activity       Agent milestones only
  agents events --include ops            Operational events only
  agents events --include security       Audit-level (secrets, command.*, daemon, …)
  agents events --module secrets         Every secret accessed or revealed
  agents events --module secrets --bundle share
  agents events --event pr.opened --since 7d
  agents events -f                       Live tail (operational)
  agents events stats
  agents events rotate --days 7
  agents events audit                    Alias of: events --include runs
  agents logs                            Run log viewer (also aliases events audit/stats/rotate)`)
    .action((_options: EventsOptions, command: Command) =>
      runEventsCommand(command.optsWithGlobals() as EventsOptions));

  // `events` both reads (its own action, above) and writes (this subcommand) —
  // the same shape as `feed` / `feed post`.
  registerEmitSubcommand(events);

  events
    .command('stats')
    .description('Show aggregate event statistics')
    .option('--since <time>', 'Window size (e.g. 7d, 30d; default 7d)')
    .option('--json', 'Output stats as JSON')
    .action(async (opts: { since?: string; json?: boolean }) => runEventsStats(opts));

  events
    .command('rotate')
    .description('Apply event retention and the storage ceiling immediately')
    .option('--days <n>', 'Retention period in days (default 7)', '7')
    .option('--max-mb <n>', 'Total event storage ceiling in MiB (default 50)', '50')
    .action((opts: { days?: string; maxMb?: string }) => runEventsRotate(opts));

  registerAuditCommands(events);
}

/** Shared by `events rotate` and the `logs rotate` alias. */
export function runEventsRotate(opts: { days?: string; maxMb?: string }): void {
  const days = Math.max(1, parseInt(opts.days ?? '7', 10) || 7);
  const maxMb = Math.max(1, parseInt(opts.maxMb ?? '50', 10) || 50);
  const result = rotate(days, maxMb * 1024 * 1024);
  const removed = result.removedByAge + result.removedBySize;
  if (removed > 0) {
    console.log(
      `Removed ${removed} event file${removed === 1 ? '' : 's'} ` +
      `(${result.removedByAge} by age, ${result.removedBySize} by size); ` +
      `reclaimed ${humanBytes(result.bytesReclaimed)}.`,
    );
  } else {
    console.log(chalk.gray(`No event files removed (retention ${days} days, ceiling ${maxMb} MiB).`));
  }
}

/** commander repeatable-option collector. */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/** Tail today's event file, printing new lines as they land. */
async function followLog(): Promise<void> {
  let file = getLogsPath();
  let offset = 0;
  try {
    offset = fs.statSync(file).size;
  } catch {
    // File may not exist yet — start at 0 and pick it up on first write.
  }
  console.log(chalk.gray(`Tailing ${file} — Ctrl-C to stop`));
  const drain = () => {
    const nextFile = getLogsPath();
    if (nextFile !== file) {
      file = nextFile;
      offset = 0;
      console.log(chalk.gray(`Tailing ${file}`));
    }
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size <= offset) {
      if (size < offset) offset = 0; // rotated/truncated
      return;
    }
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      for (const line of buf.toString('utf-8').split('\n').filter(Boolean)) {
        try {
          console.log(renderRow(JSON.parse(line) as EventRecord));
        } catch {
          // Skip malformed lines.
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  };
  // Poll — simpler and more portable than fs.watch across platforms/editors.
  await new Promise<void>(() => {
    setInterval(drain, 500);
  });
}
