import type { Command } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import { runLiveRoster, type LiveStatusFilter, type LiveStatusFlags } from './ps-roster.js';
import { registerSessionsStopCommand } from './sessions-stop.js';
import { registerFocusCommand } from './focus.js';
import { registerDetachCommand } from './detach.js';
import { registerSessionsMigrateCommand, registerSessionsMigrationsCommand } from './sessions-migrate.js';

export const PS_STATUSES: readonly LiveStatusFilter[] = [
  'working',
  'idle',
  'waiting',
  'orphaned',
  'crashed',
  'closed',
  'abandoned',
  'queued',
  'unknown',
];

interface PsOptions {
  json?: boolean;
  local?: boolean;
  device?: string[];
  status?: string[];
  interactive?: boolean;
  bookmarks?: boolean;
  routine?: boolean | string;
}

export function statusFlags(values: string[] | undefined): LiveStatusFlags {
  const flags: LiveStatusFlags = {};
  for (const raw of values ?? []) {
    for (const value of raw.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)) {
      const status = value === 'orphan' ? 'orphaned' : value;
      if (!PS_STATUSES.includes(status as LiveStatusFilter)) {
        throw new Error(`Unknown --status "${value}". Choose from: ${PS_STATUSES.join(', ')}.`);
      }
      flags[status as keyof LiveStatusFlags] = true;
    }
  }
  return flags;
}

export function deviceScope(devices: string[] | undefined): string[] | undefined {
  const hosts = (devices ?? []).filter((d) => !['all', 'fleet'].includes(d.toLowerCase()));
  return hosts.length > 0 ? hosts : undefined;
}

export function registerPsCommand(program: Command): void {
  const ps = program
    .command('ps')
    .enablePositionalOptions()
    .description('List running agents on this machine and across the fleet; stop, focus, detach, or migrate one')
    .option('--json', 'Print the roster as JSON (one row per live session)')
    .option('--local', 'Only this machine; skip the fleet fan-out')
    .option('-D, --device <target...>', 'Only these devices (alias from `agents devices`, user@host, or `all`; repeatable)')
    .option('--status <state...>', `Only these live states: ${PS_STATUSES.join(', ')} (repeatable or comma-separated)`)
    .option('--bookmarks', 'Only bookmarked sessions (bookmark one with `agents sessions bookmark <id>`)')
    .option('--routines, --routine [name]', 'Only routine-run sessions; pass a name to narrow to one routine (fuzzy name matching)')
    .option('--no-interactive', 'Print the roster instead of opening the picker on a TTY');

  setHelpSections(ps, {
    examples: `
      # What is running right now, here and on every reachable device
      agents ps

      # Machine-readable roster for this box only
      agents ps --json --local

      # One peer's running agents, over SSH
      agents ps --json -D yosemite-s0

      # Only agents waiting on you (exits 1 when any are waiting)
      agents ps --status waiting

      # Only bookmarked sessions, or the runs of one routine
      agents ps --bookmarks
      agents ps --routine nightly-review

      # Act on one row by its 8-character id
      agents ps focus 4b2f1a9c
      agents ps detach 4b2f1a9c
      agents ps stop 4b2f1a9c
      agents ps migrate 4b2f1a9c --auto

      # Where migrated sessions went
      agents ps migrations
    `,
    notes: `
      - On a TTY with no --status, ps opens the session picker filtered to running
        sessions: r toggles that filter, f focuses, enter resumes, y copies the command.
      - Type into a running agent with: agents send --channel session --to <id> --text "continue"
      - Resume an ended session with: agents run --resume <id>
      - A session on another device is stopped, detached, or focused there over SSH.
      - Put -D and --status after the verb or after the roster flags, never before a
        verb: they take several values, so 'ps -D box stop <id>' reads 'stop' as a device.
    `,
  });

  ps.action(async (opts: PsOptions) => {
    let flags: LiveStatusFlags;
    try {
      flags = statusFlags(opts.status);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 2;
      return;
    }
    await runLiveRoster({
      ...flags,
      json: opts.json,
      local: opts.local,
      host: deviceScope(opts.device),
      interactive: opts.interactive,
      bookmarks: opts.bookmarks,
      routine: opts.routine,
    });
  });

  registerSessionsStopCommand(ps, 'ps');
  registerFocusCommand(ps, { group: 'ps', hidden: false });
  registerDetachCommand(ps, 'ps');
  registerSessionsMigrateCommand(ps, 'ps');
  registerSessionsMigrationsCommand(ps, 'ps');
}
