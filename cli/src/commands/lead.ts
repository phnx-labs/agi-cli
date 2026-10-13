import type { Command } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import { writeStdoutFlushed } from '../lib/stdout.js';
import { connectHost, ensureHost, requireProjectDef, runConfirm, sendRequest } from '../lib/lead/client.js';
import { ConfirmError } from '../lib/lead/confirm.js';
import { leadModel } from '../lib/lead/harness.js';
import { statusFromFiles, type LeadStatus } from '../lib/lead/host.js';
import { leadPaths, listLeadProjects } from '../lib/lead/paths.js';
import { readHistory } from '../lib/lead/store.js';
import type { LeadEvent } from '../lib/lead/events.js';

function printJsonLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function humanRenderer(): (e: LeadEvent) => void {
  let sawText = false;
  return (e) => {
    switch (e.type) {
      case 'turn':
        if (e.engine === 'cold') process.stderr.write(chalk.gray(`starting the Lead for ${e.project}…\n`));
        return;
      case 'tool':
        if (e.state === 'run') process.stderr.write(chalk.gray(`  $ ${e.cmd}\n`));
        else process.stderr.write(chalk.gray(`  ${e.state === 'ok' ? '✓' : '✗'} ${e.label} ${e.secs}s\n`));
        return;
      case 'text':
        sawText = true;
        process.stdout.write(e.delta);
        return;
      case 'confirm':
        process.stdout.write(`\n${chalk.yellow(`Confirm: ${e.label}`)} → agents lead confirm ${e.token}\n`);
        return;
      case 'done':
        if (!sawText) process.stdout.write(e.text);
        process.stdout.write('\n');
        return;
      case 'error':
        process.stderr.write(chalk.red(`error: ${e.message}\n`));
        return;
      default:
        return;
    }
  };
}

function parseVoice(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--voice expects seconds as a number, got '${raw}'.`);
  return n;
}

async function liveStatus(project: string): Promise<LeadStatus> {
  const socket = await connectHost(project);
  if (!socket) return statusFromFiles(project, leadPaths(project), leadModel());
  let status: LeadStatus | null = null;
  await sendRequest(socket, { op: 'status' }, (obj) => { status = obj as unknown as LeadStatus; });
  if (!status) throw new Error(`The Lead host for '${project}' closed without a status.`);
  return status;
}

function renderStatus(s: LeadStatus): string {
  const ctx = s.contextPct === null ? '' : ` · context ${s.contextPct}%`;
  const session = s.session ? s.session.slice(0, 8) : 'none';
  return `${chalk.bold(s.project)}  ${s.state}  session ${session}  ${s.turns} turns  model ${s.model}${ctx}${s.busy ? '  (busy)' : ''}`;
}

export function registerLeadCommand(program: Command): void {
  const lead = program
    .command('lead')
    .description('Talk to the per-project Lead: one warm headless Claude that dispatches and manages your agents');

  setHelpSections(lead, {
    examples: `
      # Ask the Lead (starts its warm host on first use; later turns reuse it)
      agents lead ask --project rush -- what is running?
      agents lead ask --project rush --json -- put Claude on PHNX-4365

      # A stop is held for you; run the token it printed
      agents lead confirm c_0123456789abcdef

      # What it said before, its state, and shutting it down
      agents lead history --project rush --limit 20 --json
      agents lead status --json
      agents lead stop --project rush
    `,
    notes: `
      - One host process per project owns the Claude child and survives the caller exiting.
        Its files live in ~/.agents/lead/<project>/ (session.json, memory.md, history.ndjson, host.log).
      - The Lead may only run agents ps|send|run|feed, sessions, artifacts list and linear. It cannot edit files.
      - Stops go through confirm tokens, which expire after 10 minutes.
      - The model is the lead.model setting (default sonnet): agents config set lead.model <model>.
    `,
  });

  lead
    .command('ask')
    .description('Send one message to the project Lead and stream its reply')
    .requiredOption('--project <name>', 'Project name from agents projects list')
    .option('--voice <secs>', 'The text is a voice transcript of this many seconds')
    .option('--json', 'Stream NDJSON events (turn, status, tool, text, confirm, done, error)')
    .argument('<text...>', 'What to ask (put it after --)')
    .action(async (words: string[], opts: { project: string; voice?: string; json?: boolean }) => {
      const emit = opts.json ? (e: LeadEvent) => printJsonLine(e) : humanRenderer();
      let failed = false;
      try {
        const voice = parseVoice(opts.voice);
        requireProjectDef(opts.project);
        const text = words.join(' ').trim();
        if (!text) throw new Error('Nothing to ask: pass the text after --.');
        const socket = await ensureHost(opts.project);
        let finished = false;
        await sendRequest(socket, { op: 'ask', text, ...(voice !== undefined ? { voice } : {}) }, (obj) => {
          const e = obj as unknown as LeadEvent;
          if (e.type === 'done') finished = true;
          if (e.type === 'error') failed = true;
          emit(e);
        });
        if (!finished && !failed) {
          failed = true;
          emit({ type: 'error', message: `The Lead host for '${opts.project}' closed the stream before the turn finished; see ${leadPaths(opts.project).log}` });
        }
      } catch (err) {
        failed = true;
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
      await writeStdoutFlushed('');
      if (failed) process.exitCode = 1;
    });
  lead
    .command('confirm')
    .description('Run an action the Lead held for confirmation (a stop), by its token')
    .argument('<token>', 'The c_… token from the confirm event')
    .option('--json', 'Stream NDJSON events (tool, done, error)')
    .action(async (token: string, opts: { json?: boolean }) => {
      const emit = opts.json ? (e: LeadEvent) => printJsonLine(e) : humanRenderer();
      let ok = false;
      try {
        ok = await runConfirm(token, emit);
      } catch (err) {
        emit({ type: 'error', message: err instanceof ConfirmError || err instanceof Error ? err.message : String(err) });
      }
      await writeStdoutFlushed('');
      if (!ok) process.exitCode = 1;
    });

  lead
    .command('history')
    .description('Print finished Lead turns for a project, oldest first')
    .requiredOption('--project <name>', 'Project name')
    .option('--limit <n>', 'Only the last N turns')
    .option('--json', 'Print a JSON array of turns')
    .action(async (opts: { project: string; limit?: string; json?: boolean }) => {
      const limit = opts.limit === undefined ? undefined : Number.parseInt(opts.limit, 10);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error(`--limit expects a positive integer, got '${opts.limit}'.`);
      const turns = readHistory(leadPaths(opts.project), limit);
      if (opts.json) {
        await writeStdoutFlushed(`${JSON.stringify(turns, null, 2)}\n`);
        return;
      }
      if (turns.length === 0) {
        console.log(chalk.gray(`No Lead turns for ${opts.project} yet.`));
        return;
      }
      for (const t of turns) {
        console.log(`${chalk.gray(t.at)}  ${chalk.cyan('>')} ${t.ask}`);
        console.log(`  ${t.text.split('\n').join('\n  ')}\n`);
      }
    });

  lead
    .command('status')
    .description('Show whether each project Lead is warm, cold or stopped, with its session and context use')
    .option('--project <name>', 'Only this project')
    .option('--json', 'Print JSON (an object with --project, else an array)')
    .action(async (opts: { project?: string; json?: boolean }) => {
      const projects = opts.project ? [opts.project] : listLeadProjects();
      const statuses = await Promise.all(projects.map((p) => liveStatus(p)));
      if (opts.json) {
        await writeStdoutFlushed(`${JSON.stringify(opts.project ? statuses[0] : statuses, null, 2)}\n`);
        return;
      }
      if (statuses.length === 0) {
        console.log(chalk.gray('No Lead has run on this machine yet. Start one with: agents lead ask --project <name> -- <text>'));
        return;
      }
      for (const s of statuses) console.log(renderStatus(s));
    });

  lead
    .command('stop')
    .description('Stop a project Lead host and its Claude process (its session stays resumable)')
    .requiredOption('--project <name>', 'Project name')
    .option('--json', 'Print {project, stopped}')
    .action(async (opts: { project: string; json?: boolean }) => {
      const socket = await connectHost(opts.project);
      let stopped = false;
      if (socket) await sendRequest(socket, { op: 'stop' }, () => { stopped = true; });
      if (opts.json) printJsonLine({ project: opts.project, stopped });
      else console.log(stopped ? `Stopped the Lead for ${opts.project}.` : `The Lead for ${opts.project} was not running.`);
    });
}
