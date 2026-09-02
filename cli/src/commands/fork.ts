/**
 * `agents sessions fork <session>` — branch an existing conversation into a new,
 * independent same-harness sibling, seeded with a recap so it picks up where the
 * original left off. The original is untouched. Also exposed as the hidden
 * top-level alias `agents fork` (back-compat).
 *
 * The source is resolved CROSS-FLEET (the same path `agents sessions preview`
 * uses), so a session that lives on another device forks fine — the sibling is
 * handed a plain-text recap as its opening input and never has to reach the
 * source transcript. Because the seed is text, any REPL harness can be forked,
 * not just Claude.
 *
 * Thin command layer; the pure recap text lives in `lib/session/fork.ts`.
 */
import { spawnSync } from 'child_process';
import type { Command } from 'commander';
import chalk from 'chalk';

import { setHelpSections } from '../lib/help.js';
import { getCliLaunch } from '../lib/cli-entry.js';
import { buildForkRecap, forkLabelFor } from '../lib/session/fork.js';

interface ForkOptions {
  name?: string;
  device?: string;
  /** Open the sibling in a real terminal tab instead of in-place; optional backend. */
  terminal?: string | boolean;
}

/**
 * The two process boundaries fork crosses — a preview subprocess (cross-fleet
 * resolve + digest) and the sibling launch. Injectable so the resolve→recap→run
 * argv logic is unit-tested without spawning real CLIs.
 */
export interface ForkDeps {
  /** Run `agents sessions preview <sub…>` and capture stdout + exit status. */
  runPreview: (sub: string[]) => { status: number | null; stdout: string };
  /** Launch `agents <sub…>` inheriting stdio; returns its exit status. */
  launch: (sub: string[]) => { status: number | null };
}

function defaultDeps(): ForkDeps {
  return {
    runPreview: (sub) => {
      const p = getCliLaunch(['sessions', 'preview', ...sub]);
      // stderr inherited so preview's own resolution errors reach the user verbatim.
      const r = spawnSync(p.command, p.args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] });
      return { status: r.status, stdout: r.stdout ?? '' };
    },
    launch: (sub) => {
      const l = getCliLaunch(sub);
      // In-place stdio so the sibling takes over this terminal.
      const r = spawnSync(l.command, l.args, { stdio: 'inherit' });
      return { status: r.status };
    },
  };
}

const FORK_HELP = {
  examples: `
    # Fork a session by (partial) id — launches a same-harness sibling seeded with a recap
    agents sessions fork 4f3a9c21

    # Name the fork's session label
    agents sessions fork 4f3a9c21 --name "try redis instead"

    # Place the sibling on a fleet worker instead of here
    agents sessions fork 4f3a9c21 --device auto

    # Open the sibling in a fresh terminal tab where you work
    agents sessions fork 4f3a9c21 --terminal
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

/**
 * Resolve the source cross-fleet, build a recap from its preview digest, and
 * launch a same-harness sibling seeded with that recap. Shared by
 * `agents sessions fork` and the `agents fork` alias.
 */
export async function runFork(
  sessionArg: string,
  options: ForkOptions,
  deps: ForkDeps = defaultDeps(),
): Promise<void> {
  // Resolve + digest in one cross-fleet hop by shelling the existing preview
  // verb: it resolves the id across the fleet (SSH fan-out + peer hop), computes
  // the digest on the OWNING device, and prints it as JSON — so a remote source
  // resolves fine and we never re-implement resolution or digesting here.
  // --terminal opens a tab on THIS machine; --device dispatches over SSH. `agents
  // run` refuses the combination, so reject it here with a fork-specific message
  // before resolving anything, rather than after an overpromising progress line.
  if (options.device && options.terminal !== undefined) {
    console.error(chalk.red('Pick one placement: --terminal opens a tab here; --device places the sibling on another box. They cannot combine.'));
    process.exitCode = 1;
    return;
  }

  const res = deps.runPreview([sessionArg, '--json']);
  if (res.status !== 0) {
    // preview already explained why on stderr; propagate its exit code.
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

  // Most sessions have no explicit --name label; fall back to the shared headline
  // ladder the rest of the CLI shows, not the raw short id. Pass `source` whole
  // rather than re-listing fields: an object literal that omits `generatedTitle`
  // still type-checks (the key is optional) and would silently drop the
  // daemon-generated title rung — the PHNX-3797 bug shape.
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

  // Launch a NEW same-harness session, load-balanced across accounts (balanced),
  // seeded with the recap as its opening input. Runs here by default; --device
  // places it on the fleet; --terminal opens it in a fresh tab where the user works.
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

/**
 * Register `agents sessions fork <session>` — the canonical surface (fork is a
 * session operation, so it lives under the `sessions` group).
 */
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

/**
 * Register the hidden top-level `agents fork` alias. Kept working for back-compat
 * and muscle memory; the canonical, discoverable surface is `agents sessions fork`.
 */
export function registerForkCommand(program: Command): void {
  const cmd = program
    .command('fork <session>', { hidden: true })
    .description('Alias for `agents sessions fork` — branch a session into a new same-harness sibling.')
    .option('--name <label>', 'Session label for the fork (default: "fork of <original>")')
    .option('--device <host>', 'Place the sibling on a fleet device (name or "auto"); defaults to here')
    .option('--terminal [backend]', 'Open the sibling in a real terminal tab (iterm | ghostty | terminal | tmux | vscodium-agent) instead of in-place');

  cmd.action((session: string, options: ForkOptions) => runFork(session, options));
}
