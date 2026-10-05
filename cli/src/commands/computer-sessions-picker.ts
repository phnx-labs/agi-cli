/** Interactive, task-first `agents computer sessions` / `agents sessions --computer` view
 * (RUSH-2432), the counterpart of browser-sessions-picker.ts. TTY path only; non-TTY, `--json` and
 * `--no-interactive` fall through to the flat printer in `lib/computer/sessions-list.ts`. */
import chalk from 'chalk';
import { buildPreview } from './sessions-picker.js';
import { createSessionsPickerCommand } from './sessions-picker-factory.js';
import {
  runComputerSessions,
  printComputerSessionRows,
  buildComputerSessionRows,
  matchesComputerSessionRow,
  formatRowActions,
  type ComputerRunRow,
  type ComputerAction,
} from '../lib/computer/sessions-list.js';
import { formatRelativeTime } from '../lib/session/relative-time.js';
import { sessionHeadline } from '../lib/session/title.js';

interface ComputerSessionsCommandOpts {
  machine?: string;
  limit?: number;
  json?: boolean;
  interactive?: boolean;
  rows?: ComputerRunRow[];
}

function rowLinkSummary(row: ComputerRunRow): string {
  if (row.linkStatus === 'linked' && row.linkedSession) {
    const s = row.linkedSession;
    return chalk.cyan(s.agent) + ' — ' + (sessionHeadline(s) || s.shortId);
  }
  if (row.linkStatus === 'unresolved') {
    return chalk.yellow(`owner ${row.agent ?? 'unknown'} (session not indexed here)`);
  }
  return chalk.gray('unlinked');
}

function formatRowLabel(row: ComputerRunRow): string {
  const rawName = row.task ?? row.bundle ?? (row.pid ? `pid ${row.pid}` : 'recovered run');
  const name = rawName.slice(0, 40).padEnd(40);
  const coloredName = row.task ? name : chalk.gray(name);
  const where = (row.remoteHost ? `${row.machine} -> ${row.remoteHost}` : row.machine).padEnd(24);
  const age = formatRelativeTime(new Date(row.endMs).toISOString());
  const counts = formatRowActions(row);
  return [coloredName, where, age.padEnd(11), counts.padEnd(24), rowLinkSummary(row)].join(' ');
}

const PREVIEW_ACTION_LIMIT = 12;

function buildRowPreview(row: ComputerRunRow): string {
  const parts: string[] = [];
  if (row.linkStatus === 'linked' && row.linkedSession) {
    parts.push(buildPreview(row.linkedSession));
  } else if (row.linkStatus === 'unresolved') {
    parts.push(chalk.yellow(
      `owner ${row.agent ?? 'unknown'} — session ${row.sessionId ?? row.launchId} has no indexed session on this machine.`
    ));
  } else {
    parts.push(chalk.gray('Unlinked — no owning agent session is known for this run (no session/launch identity recorded).'));
  }

  if (row.task) {
    parts.push('');
    parts.push(chalk.bold('Task:') + ` ${row.task}`);
  }

  parts.push('');
  parts.push(chalk.bold(`Actions (${row.recoveredActionCount ?? row.actions.length})`) + `  ${formatRowActions(row)}`);
  for (const a of row.actions.slice(0, PREVIEW_ACTION_LIMIT)) {
    parts.push(`  ${formatActionLabel(a)}`);
  }
  const more = row.actions.length - PREVIEW_ACTION_LIMIT;
  if (more > 0) parts.push(chalk.gray(`  … (${more} more)`));

  return parts.join('\n');
}

function formatActionLabel(a: ComputerAction): string {
  const age = formatRelativeTime(new Date(a.tsMs).toISOString());
  const target = a.bundle ?? (a.targetPid != null ? `pid ${a.targetPid}` : '-');
  return `${age.padEnd(11)}  ${a.verb.padEnd(14)}  ${target}`;
}

function printRunDetail(row: ComputerRunRow): void {
  console.log('');
  console.log(chalk.bold(row.task ?? row.bundle ?? `pid ${row.pid}`));
  console.log(row.remoteHost ? `${row.machine} -> ${row.remoteHost}` : row.machine);
  console.log('');
  for (const a of row.actions) console.log(formatActionLabel(a));
  if (row.actions.length === 0) console.log('(no driving actions recorded)');
  console.log('');
}

const computerSessionsPicker = createSessionsPickerCommand<ComputerRunRow, ComputerSessionsCommandOpts>({
  runFlat: (opts) => {
    if (opts.rows) printComputerSessionRows(opts.rows, { limit: opts.limit, json: opts.json });
    else runComputerSessions({ machine: opts.machine, limit: opts.limit, json: opts.json });
  },
  buildRows: (opts) => opts.rows ?? buildComputerSessionRows({ machine: opts.machine }),
  emptyMessage: (opts) => `No computer actions recorded${opts.machine ? ` for machine "${opts.machine}"` : ''}.`,
  message: 'Computer sessions:',
  matches: matchesComputerSessionRow,
  labelFor: formatRowLabel,
  buildPreview: buildRowPreview,
  emptyFilterMessage: 'No computer sessions match.',
  enterHint: 'view actions',
  onOpen: printRunDetail,
});

export function shouldOpenInteractiveComputerSessions(opts: ComputerSessionsCommandOpts, isTTY: boolean): boolean {
  return computerSessionsPicker.shouldOpen(opts, isTTY);
}

/** Shared entry point for `agents computer sessions` and `agents sessions --computer`, mirroring
 * `runBrowserSessionsCommand`'s interactive-routing split so both stay in lockstep. */
export async function runComputerSessionsCommand(opts: ComputerSessionsCommandOpts): Promise<void> {
  await computerSessionsPicker.run(opts);
}
