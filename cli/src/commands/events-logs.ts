
import type { Command } from 'commander';
import chalk from 'chalk';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { discoverSessions, resolveSessionById } from '../lib/session/discover.js';
import { parseAgentFilter } from '../lib/session/selection.js';
import { renderSessionLog, renderSessionLogJson } from '../lib/session/presentation.js';
import { runSessions } from '../lib/sessions-client.js';
import { showHostTaskLog, hostTaskLogJson } from '../lib/hosts/logs.js';
import { listTasks, type HostTask } from '../lib/hosts/tasks.js';
import { itemPicker } from '../lib/picker.js';
import { sessionHeadline } from '../lib/session/title.js';

interface LogsOptions {
  device?: string;
  agent?: string;
  version?: string;
  session?: string;
  follow?: boolean;
  full?: boolean;
  json?: boolean;
}

type Candidate =
  | { kind: 'task'; task: HostTask }
  | { kind: 'session'; session: SessionMeta };

function candidateLabel(c: Candidate): string {
  if (c.kind === 'task') {
    const t = c.task;
    const status = t.status === 'completed' ? chalk.green(t.status)
      : t.status === 'failed' ? chalk.red(t.status)
      : chalk.yellow(t.status);
    return `${chalk.gray('task')} ${t.id.slice(0, 8).padEnd(9)} ${t.host.padEnd(14)} ${t.agent.padEnd(8)} ${status}  ${t.prompt.slice(0, 40)}`;
  }
  const s = c.session;
  const ver = s.version ? chalk.gray(`@${s.version}`) : '';
  const title = sessionHeadline(s) || '';
  return `${chalk.gray('sess')} ${s.shortId.padEnd(9)} ${(s.agent + ver).padEnd(14)} ${chalk.gray(s.timestamp.slice(0, 16))}  ${title.slice(0, 40)}`;
}

function emitHostTaskJson(id: string): boolean {
  const hj = hostTaskLogJson(id);
  if (!hj.found) return false;
  process.stdout.write(JSON.stringify({ kind: 'task', task: hj.task, log: hj.log ?? null }, null, 2) + '\n');
  return true;
}

async function showSession(session: SessionMeta, follow: boolean, full: boolean, json = false): Promise<void> {
  if (json) {
    await renderSessionLogJson(session);
    return;
  }
  if (follow) {
    process.exitCode = await runSessions(['tail', session.id, ...(full ? ['--json'] : [])]);
    return;
  }
  await renderSessionLog(session, full ? 'markdown' : 'summary');
}

async function showCandidate(c: Candidate, follow: boolean, full: boolean, json = false): Promise<void> {
  if (c.kind === 'task') {
    if (json) {
      emitHostTaskJson(c.task.id);
      return;
    }
    const res = await showHostTaskLog(c.task.id, follow, full);
    if (res.exitCode !== undefined) process.exitCode = res.exitCode;
    return;
  }
  await showSession(c.session, follow, full, json);
}

async function showById(id: string, follow: boolean, full: boolean, json = false): Promise<void> {
  if (json) {
    if (emitHostTaskJson(id)) return;
    const sessions = await discoverSessions({ all: true, limit: 5000 });
    const matches = resolveSessionById(sessions, id);
    if (matches.length === 0) {
      console.error(chalk.red(`No run or session found matching "${id}".`));
      process.exit(1);
    }
    await renderSessionLogJson(matches[0]);
    return;
  }
  const hostRes = await showHostTaskLog(id, follow, full);
  if (hostRes.found) {
    if (hostRes.exitCode !== undefined) process.exitCode = hostRes.exitCode;
    return;
  }
  const sessions = await discoverSessions({ all: true, limit: 5000 });
  const matches = resolveSessionById(sessions, id);
  if (matches.length === 0) {
    console.error(chalk.red(`No run or session found matching "${id}".`));
    process.exit(1);
  }
  await showSession(matches[0], follow, full);
}

async function runLogs(id: string | undefined, opts: LogsOptions): Promise<void> {
  const follow = !!opts.follow;
  const full = !!opts.full;

  const directId = opts.session ?? id;
  if (directId) {
    await showById(directId, follow, full, !!opts.json);
    return;
  }

  const { agent, version } = parseAgentFilter(opts.agent);
  const wantVersion = opts.version ?? version;

  const candidates: Candidate[] = [];

  let tasks = listTasks();
  if (opts.device) tasks = tasks.filter((t) => t.host === opts.device);
  if (agent) tasks = tasks.filter((t) => t.agent === agent);
  for (const t of tasks) candidates.push({ kind: 'task', task: t });

  if (!opts.device) {
    const sessions = await discoverSessions({ agent, version: wantVersion, limit: 50 });
    for (const s of sessions) candidates.push({ kind: 'session', session: s });
  }

  if (candidates.length === 0) {
    console.error(chalk.yellow('No matching runs. Dispatch one: agents run <agent> "<task>" [--device <name>]'));
    process.exit(1);
  }

  if (candidates.length === 1) {
    await showCandidate(candidates[0], follow, full, !!opts.json);
    return;
  }

  if (!process.stdin.isTTY) {
    console.error(chalk.yellow(`${candidates.length} runs match. Pass an id or --session <id>:`));
    for (const c of candidates.slice(0, 30)) console.error('  ' + candidateLabel(c));
    process.exit(1);
  }

  const picked = await itemPicker<Candidate>({
    message: 'Select a run to view its log:',
    items: candidates,
    filter: (query: string) => {
      const q = query.trim().toLowerCase();
      if (!q) return candidates;
      return candidates.filter((c) => candidateLabel(c).toLowerCase().includes(q));
    },
    labelFor: (c: Candidate) => candidateLabel(c),
    shortIdFor: (c: Candidate) => (c.kind === 'task' ? c.task.id : c.session.shortId),
  });
  if (!picked) return;
  await showCandidate(picked.item, follow, full, !!opts.json);
}

export function registerEventsLogsCommand(events: Command): void {
  events
    .command('logs [id]')
    .description('Show the log of a dispatched run or a session')
    .option('--device <name>', 'Scope to runs dispatched to a device')
    .option('-a, --agent <agent>', 'Filter by agent (e.g. claude, codex@0.116.0)')
    .option('--version <version>', 'Filter by agent version')
    .option('--session <id>', 'Select a session/run by id (same as the positional id)')
    .option('-f, --follow', 'Follow live output')
    .option('-m, --full', 'Show the full raw transcript / stdout instead of the concise summary')
    .option('--json', 'Machine-readable JSON: a host task as { kind, task, log }, a session as the redacted { session, events }')
    .action((id: string | undefined, _opts: LogsOptions, command: Command) =>
      runLogs(id, command.optsWithGlobals() as LogsOptions));
}
