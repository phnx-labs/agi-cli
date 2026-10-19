import type { Command } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import { writeStdoutFlushed } from '../lib/stdout.js';
import { connectHost, ensureHost, requireProjectDef, sendRequest } from '../lib/lead/client.js';
import { runConfirm } from '../lib/lead/act.js';
import { ConfirmError } from '../lib/lead/confirm.js';
import { leadModel } from '../lib/lead/harness.js';
import { LeadSpeaker } from '../lib/lead/speak.js';
import { statusFromFiles, type LeadStatus } from '../lib/lead/host.js';
import { leadPaths, listLeadProjects } from '../lib/lead/paths.js';
import { readHistory } from '../lib/lead/store.js';
import type { LeadEvent } from '../lib/lead/events.js';
import {
  LINEAR_STATUSES, LeadToolError, MAX_TASKS_LIMIT, PR_VERBS, leadToolContext, parseEditorContext, toolAnswer, toolAttention,
  toolDispatch, toolLinearCreate, toolLinearTasks, toolLinearView, toolPrAct, toolPrsList, toolRemember, toolRoster, toolSend,
  toolStart, toolStop, type EditorContext,
} from '../lib/lead/tools.js';

function toolAction<A extends unknown[]>(fn: (...args: A) => Promise<string> | string): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      const out = await fn(...args);
      await writeStdoutFlushed(`${out}\n`);
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  };
}

export function registerLeadToolCommands(lead: Command): void {
  const tool = lead
    .command('tool')
    .description('The fixed-shape commands a Lead may run (only inside a Lead; the harness allows nothing else)');
  setHelpSections(tool, {
    notes: `
      - These run inside the Lead's Claude process, which sets AGENTS_LEAD_PROJECT. Each has one fixed shape:
        no --mode, --secrets, --device, --lease, --cloud or pass-through arguments exist on any of them.
      - answer, send, start, dispatch, stop and prs merge|comment|ready|rerun|close never act: each mints a
        confirm token (10 minutes) the owner runs with agents lead confirm <token>.
      - roster, attention and prs list read the Lead host's live feed or GitHub; linear reads or creates tickets.
    `,
  });
  const strict = (c: Command) => c.allowExcessArguments(false).allowUnknownOption(false);

  strict(tool.command('roster'))
    .description('List live sessions for this project (or --project) from the Lead host\'s live feed')
    .option('--project <name>', 'Another project')
    .action(toolAction(async (opts: { project?: string }) => toolRoster(leadToolContext(), opts.project)));

  strict(tool.command('attention'))
    .description('List every open ask across the fleet from the Lead host\'s live feed: key, session, host, project, age, question, choices')
    .action(toolAction(async () => toolAttention(leadToolContext())));

  strict(tool.command('answer'))
    .description('Queue an answer to one open ask for the owner\'s Confirm (feed answer runs on confirm)')
    .requiredOption('--key <key>', 'The attention key from the attention tool')
    .option('--choice <id>', 'A choice id of that ask')
    .option('--text <answer>', 'A free-text answer (one line)')
    .action(toolAction(async (opts: { key: string; choice?: string; text?: string }) => {
      if ((opts.choice === undefined) === (opts.text === undefined)) throw new LeadToolError('Pass exactly one of --choice <id> or --text <answer>.');
      return toolAnswer(leadToolContext(), opts.key, opts.choice !== undefined ? { choice: opts.choice } : { text: opts.text! });
    }));

  strict(tool.command('dispatch'))
    .description('Queue for Confirm: move a ticket to In Progress, delegate it, and start the agent on it in edit mode')
    .requiredOption('--ticket <id>', 'Ticket id, e.g. PHNX-4365')
    .option('--agent <agent>', 'Agent to run', 'claude')
    .action(toolAction(async (opts: { ticket: string; agent: string }) => toolDispatch(leadToolContext(), opts.ticket, opts.agent)));

  strict(tool.command('start'))
    .description('Queue for Confirm: start an agent in edit mode on a task with no ticket')
    .requiredOption('--agent <agent>', 'Agent to run')
    .argument('<task...>', 'The task (after --)')
    .action(toolAction(async (task: string[], opts: { agent: string }) => toolStart(leadToolContext(), opts.agent, task.join(' '))));

  strict(tool.command('send'))
    .description('Queue for Confirm: type a message into a running session of this project (slash commands are refused)')
    .requiredOption('--session <id>', 'Session id or 8+ character prefix')
    .argument('<text...>', 'The message (after --)')
    .action(toolAction(async (text: string[], opts: { session: string }) => toolSend(leadToolContext(), opts.session, text.join(' '))));

  strict(tool.command('stop'))
    .description('Queue for Confirm: stop a session; mints a confirm token, never stops anything')
    .requiredOption('--session <id>', 'Session id or 8+ character prefix')
    .action(toolAction(async (opts: { session: string }) => toolStop(leadToolContext(), opts.session)));

  const prs = tool.command('prs').description('This project\'s open PRs: list them, or queue one action on one for Confirm');
  strict(prs.command('list'))
    .description('List this project\'s open PRs (repo#number, draft, title)')
    .option('--repo <owner/repo>', 'Only this attached repo')
    .action(toolAction(async (opts: { repo?: string }) => toolPrsList(leadToolContext(), opts.repo)));
  for (const verb of PR_VERBS) {
    const cmd = strict(prs.command(verb))
      .description(`Queue for Confirm: agents projects prs ${verb} on one PR of this project`)
      .requiredOption('--repo <owner/repo>', 'An attached repo of this project')
      .requiredOption('--number <n>', 'The PR number');
    if (verb === 'merge' || verb === 'ready') cmd.option('--sha <head>', 'The head commit to pin (merge reads the live head when omitted)');
    if (verb === 'comment') cmd.requiredOption('--body <text>', 'The comment');
    if (verb === 'rerun') cmd.option('--run-id <id>', 'Which failing run, when the head has several');
    cmd.action(toolAction(async (opts: { repo: string; number: string; sha?: string; body?: string; runId?: string }) =>
      toolPrAct(leadToolContext(), verb, opts)));
  }

  const linear = tool.command('linear').description('Read this project\'s Linear tickets, or create one');
  strict(linear.command('tasks'))
    .description('List tickets of this project')
    .option('--status <status>', LINEAR_STATUSES.join('|'), 'open')
    .option('--limit <n>', `1-${MAX_TASKS_LIMIT}`, '20')
    .action(toolAction(async (opts: { status: string; limit: string }) =>
      toolLinearTasks(leadToolContext(), opts.status, Number.parseInt(opts.limit, 10))));
  strict(linear.command('view'))
    .description('Show one ticket')
    .argument('<id>', 'Ticket id')
    .action(toolAction(async (id: string) => { leadToolContext(); return toolLinearView(id); }));
  strict(linear.command('create'))
    .description('Create a ticket in this project')
    .requiredOption('--title <title>', 'Title')
    .option('--description <text>', 'Description')
    .action(toolAction(async (opts: { title: string; description?: string }) =>
      toolLinearCreate(leadToolContext(), opts.title, opts.description)));

  strict(tool.command('remember'))
    .description('Save one short note to the Lead\'s memory.md')
    .argument('<note...>', 'The note (after --)')
    .action(toolAction(async (note: string[]) => toolRemember(leadToolContext(), note.join(' '))));
}

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
        if (e.detail) process.stdout.write(chalk.gray(`  ${e.detail.split('\n').join('\n  ')}\n`));
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

      # Pass what the editor shows so "this one" resolves, and hear the answer as it streams
      agents lead ask --project rush --context '{"front":{"sessionId":"4b2f1a9c-…","title":"Fix login","tab":3}}' -- what is this one stuck on?
      agents lead ask --project rush --speak -- what needs me?

      # Anything that acts (answer, send, start, dispatch, stop, a PR action) is held; run the token it printed
      agents lead confirm c_0123456789abcdef

      # What it said before, its state, and shutting it down
      agents lead history --project rush --limit 20 --json
      agents lead status --json
      agents lead stop --project rush
    `,
    notes: `
      - One host process per project owns the Claude child and survives the caller exiting.
        Its files live in ~/.agents/lead/<project>/ (session.json, memory.md, history.ndjson, host.log).
      - The Lead runs with isolated settings and may only run the fixed-shape agents lead tool commands.
      - Every action goes through a confirm token, which expires after 10 minutes; confirm runs the exact
        agents argv the Lead queued (agents feed answer, agents send, agents run, agents ps stop, agents projects prs …).
      - The model is the lead.model setting (default sonnet): agents config set lead.model <model>.
      - --speak reads ELEVENLABS_API_KEY from the secrets bundle lead.voice.bundle (default elevenlabs) and plays
        each finished sentence with afplay (macOS) or ffplay; a voice failure is one stderr line, never a failed turn.
    `,
  });

  lead
    .command('ask')
    .description('Send one message to the project Lead and stream its reply')
    .requiredOption('--project <name>', 'Project name from agents projects list')
    .option('--voice <secs>', 'The text is a voice transcript of this many seconds')
    .option('--context <json>', 'Editor context as a JSON object, e.g. {"front":{"sessionId":"…","title":"…","tab":3},"tabs":[…]}')
    .option('--speak', 'Speak the answer on this machine as it streams (ElevenLabs; see notes)')
    .option('--json', 'Stream NDJSON events (turn, status, tool, text, confirm, done, error)')
    .argument('<text...>', 'What to ask (put it after --)')
    .action(async (words: string[], opts: { project: string; voice?: string; context?: string; speak?: boolean; json?: boolean }) => {
      const render = opts.json ? (e: LeadEvent) => printJsonLine(e) : humanRenderer();
      let speaker: LeadSpeaker | null = null;
      const emit = (e: LeadEvent) => { render(e); speaker?.onEvent(e); };
      let failed = false;
      try {
        const voice = parseVoice(opts.voice);
        const context: EditorContext | undefined = opts.context === undefined ? undefined : parseEditorContext(opts.context);
        requireProjectDef(opts.project);
        const text = words.join(' ').trim();
        if (!text) throw new Error('Nothing to ask: pass the text after --.');
        if (opts.speak) speaker = LeadSpeaker.start();
        const socket = await ensureHost(opts.project);
        let finished = false;
        await sendRequest(socket, { op: 'ask', text, ...(voice !== undefined ? { voice } : {}), ...(context ? { context } : {}) }, (obj) => {
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
      await speaker?.drain();
    });
  lead
    .command('confirm')
    .description('Run an action the Lead held for confirmation (answer, send, start, dispatch, stop or a PR action), by its token')
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

  registerLeadToolCommands(lead);

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
