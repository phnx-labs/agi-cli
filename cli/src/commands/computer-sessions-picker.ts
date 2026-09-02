/**
 * Interactive, task-first `agents computer sessions` / `agents sessions
 * --computer` view (RUSH-2432) — the computer counterpart of
 * `browser-sessions-picker.ts` (RUSH-2407). Backs the TTY path only —
 * non-TTY, `--json`, and `--no-interactive` all fall straight through to the
 * flat printer in `lib/computer/sessions-list.ts` (unchanged, so `--json`
 * stays a stable surface).
 *
 * Reuses the same `itemPicker` + `buildPreview` primitives as the ordinary
 * session picker (`sessions-picker.ts`) and the browser task picker — same
 * search/filter/quit help, and the preview pane for a linked run IS the
 * canonical session digest, not a second renderer. Unlike a browser task, a
 * computer run has no on-disk artifact of its own to open (see
 * `lib/computer/sessions-list.ts`'s module docblock), so `enter` prints the
 * run's full action list rather than opening a file, and the picker keeps
 * browsing afterward instead of exiting. Interactive routing and the browse
 * loop live in `sessions-picker-factory.ts` (shared with the browser twin).
 */
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

export interface ComputerSessionsCommandOpts {
  machine?: string;
  /** Row cap for the flat table only — the interactive picker is searchable
   *  and shows every row regardless (see `runComputerSessions`). */
  limit?: number;
  json?: boolean;
  /** Commander's `--no-interactive` convention: `false` opts out. */
  interactive?: boolean;
  /** Pre-collected fleet rows. Omitted for the local ledger path. */
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
  // Pad the raw text first, THEN colorize — padEnd on an already-chalked
  // string counts the ANSI escape bytes as width and misaligns the column.
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

/** Print one run's full action list (no truncation) — the `enter` action,
 *  since a computer run has no on-disk artifact to open. */
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

/** True when the interactive picker should open instead of the printed table:
 *  a real TTY, no `--json`, and `--no-interactive` not set. */
export function shouldOpenInteractiveComputerSessions(opts: ComputerSessionsCommandOpts, isTTY: boolean): boolean {
  return computerSessionsPicker.shouldOpen(opts, isTTY);
}

/**
 * Shared entry point for `agents computer sessions` and `agents sessions
 * --computer`. Mirrors `runBrowserSessionsCommand`'s interactive-routing
 * split so both call sites stay in lockstep.
 */
export async function runComputerSessionsCommand(opts: ComputerSessionsCommandOpts): Promise<void> {
  await computerSessionsPicker.run(opts);
}
