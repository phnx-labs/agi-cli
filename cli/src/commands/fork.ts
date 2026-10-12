import { spawnSync } from 'child_process';
import type { Command } from 'commander';
import chalk from 'chalk';

import { setHelpSections } from '../lib/help.js';
import { getCliLaunch } from '../lib/cli-entry.js';
import { buildForkRecap, forkLabelFor } from '../lib/session/fork.js';

interface ForkOptions {
  name?: string;
  device?: string;
  terminal?: string | boolean;
}

export interface ForkDeps {
  runPreview: (sub: string[]) => { status: number | null; stdout: string };
  launch: (sub: string[]) => { status: number | null };
}

function defaultDeps(): ForkDeps {
  return {
    runPreview: (sub) => {
      const p = getCliLaunch(['sessions', 'preview', ...sub]);
      const r = spawnSync(p.command, p.args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] });
      return { status: r.status, stdout: r.stdout ?? '' };
    },
    launch: (sub) => {
      const l = getCliLaunch(sub);
      const r = spawnSync(l.command, l.args, { stdio: 'inherit' });
      return { status: r.status };
    },
  };
}

const FORK_HELP = {
  examples: `
    # Fork a session by (partial) id — launches a same-harness sibling seeded with a recap
    agents fork 4f3a9c21

    # Name the fork's session label
    agents fork 4f3a9c21 --name "try redis instead"

    # Place the sibling on a fleet worker instead of here
    agents fork 4f3a9c21 --device auto

    # Open the sibling in a fresh terminal tab where you work
    agents fork 4f3a9c21 --terminal
  `,
  notes: `
    - 'resume' continues the SAME conversation; 'fork' launches a NEW same-harness
      session seeded with a recap of the source, so the two diverge.
    - Works cross-device and cross-harness: the source is resolved across the fleet
      and the sibling gets a plain-text recap, so it never reaches the source transcript.
    - The recap carries the source id — the sibling can run '/continue <id>' for the
      full history if it needs more than the recap.
    - Resolve the source the same way as resume: an exact or prefix id fragment.
  `,
};

export async function runFork(
  sessionArg: string,
  options: ForkOptions,
  deps: ForkDeps = defaultDeps(),
): Promise<void> {
  if (options.device && options.terminal !== undefined) {
    console.error(chalk.red('Pick one placement: --terminal opens a tab here; --device places the sibling on another box. They cannot combine.'));
    process.exitCode = 1;
    return;
  }

  const res = deps.runPreview([sessionArg, '--json']);
  if (res.status !== 0) {
    process.exitCode = res.status ?? 1;
    return;
  }

  let data: any;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    console.error(chalk.red(`Could not read the source session for "${sessionArg}".`));
    process.exitCode = 1;
    return;
  }

  const source = data?.session;
  if (!source?.id || !source?.agent) {
    console.error(chalk.red(`Could not resolve a forkable source for "${sessionArg}".`));
    process.exitCode = 1;
    return;
  }
  const digest = data?.preview ?? undefined;

  const label = forkLabelFor(source);
  const recap = buildForkRecap({
    agent: source.agent,
    label,
    cwd: source.cwd,
    ticketId: source.ticketId,
    machine: source.machine,
    shortId: source.shortId,
    id: source.id,
    lastAssistant: digest?.lastAssistant,
    changes: digest?.changes,
  });

  const runArgs = ['run', source.agent, recap, '-i', '--strategy', 'balanced', '--name', options.name || `fork of ${label}`];
  if (options.device) runArgs.push('--device', options.device);
  if (options.terminal !== undefined) {
    runArgs.push('--terminal');
    if (typeof options.terminal === 'string') runArgs.push(options.terminal);
  }

  const where = options.device ? ` on ${options.device}` : options.terminal !== undefined ? ' in a new terminal' : '';
  console.error(chalk.gray(`Forking ${source.shortId} → new ${source.agent} session${where}, seeded with a recap…`));

  const child = deps.launch(runArgs);
  process.exitCode = child.status ?? 0;
}

export function registerSessionsForkCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('fork <session>')
    .description('Branch a session into a new same-harness sibling, seeded with a recap so it continues the work. The original is untouched.')
    .option('--name <label>', 'Session label for the fork (default: "fork of <original>")')
    .option('--device <host>', 'Place the sibling on a fleet device (name or "auto"); defaults to here')
    .option('--terminal [backend]', 'Open the sibling in a real terminal tab (iterm | ghostty | terminal | tmux | vscodium-agent) instead of in-place');

  setHelpSections(cmd, FORK_HELP);
  cmd.action((session: string, options: ForkOptions) => runFork(session, options));
}

export function registerForkCommand(program: Command): void {
  const cmd = program
    .command('fork <session>', { hidden: true })
    .description('Branch a session into a new same-harness sibling, seeded with a recap so it continues the work (also `agents sessions fork`).')
    .option('--name <label>', 'Session label for the fork (default: "fork of <original>")')
    .option('--device <host>', 'Place the sibling on a fleet device (name or "auto"); defaults to here')
    .option('--terminal [backend]', 'Open the sibling in a real terminal tab (iterm | ghostty | terminal | tmux | vscodium-agent) instead of in-place');

  cmd.action((session: string, options: ForkOptions) => runFork(session, options));
}
