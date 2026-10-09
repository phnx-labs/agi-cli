import type { Command } from 'commander';
import chalk from 'chalk';
import { gatherLiveTargets } from './go.js';
import { resolveDetachTarget, resolveOne } from './detach-core.js';
import { stopInteractive } from './detach.js';
import { runOnPeer } from '../lib/session/remote-list.js';
import { setHelpSections } from '../lib/help.js';

export function registerSessionsStopCommand(program: Command, group: 'sessions' | 'ps' = 'sessions'): void {
  const cmd = program
    .command('stop')
    .argument('<id>', 'Short or full id of the live session to stop')
    .option('--local', 'Only this machine (skip the cross-host sweep)')
    .description('Stop a live agent outright — end its process and tear down its tmux/mux session')
    .action(async (id: string, opts: { local?: boolean }) => {
      await stopSessionAction(id, opts);
    });
  setHelpSections(cmd, {
    examples: `
      # Stop a live session by a short id prefix
      agents ${group} stop 4b2f1a9c

      # Only look on this machine (skip the fleet sweep)
      agents ${group} stop 4b2f1a9c --local
    `,
    notes: `
      stop ENDS the session; it does not background it. To keep an agent working
      unattended instead, use \`agents ${group} detach <id>\`, and bring it back
      with \`agents ps focus <id>\`.

      A session that lives on another machine is stopped THERE over SSH — its pid
      and tmux socket only mean something where it actually runs.
    `,
  });
}

async function stopSessionAction(id: string, opts: { local?: boolean } = {}): Promise<void> {
  const { self, activeById } = await gatherLiveTargets(!!opts.local, { includeCloud: true, selector: id });
  const resolved = resolveOne(activeById, id);
  if ('error' in resolved) {
    console.error(chalk.red(resolved.error));
    process.exitCode = 1;
    return;
  }
  const s = resolved;
  const target = resolveDetachTarget(s, self);

  if (target.kind === 'refuse') {
    console.error(chalk.red(target.reason));
    process.exitCode = 1;
    return;
  }

  const short = target.sessionId.slice(0, 8);

  if (target.kind === 'remote') {
    console.log(chalk.gray(`${short} lives on ${target.machine} — stopping it there over SSH…`));
    const rc = await runOnPeer(['sessions', 'stop', target.sessionId, '--local'], target.machine);
    if (rc === 'no-target') {
      console.error(chalk.red(`Can't reach ${target.machine} to stop ${short}.`));
      process.exitCode = 1;
    }
    return;
  }

  await stopInteractive(s);
  console.log(chalk.green(`■ Stopped ${s.kind} ${short}`) + chalk.gray(' — process ended, session closed.'));
}
