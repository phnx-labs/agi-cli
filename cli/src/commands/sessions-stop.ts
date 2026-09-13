/**
 * `agents sessions stop <id>` — end a live agent session outright: stop its
 * interactive process and tear down its tmux/mux session, so the session becomes
 * done/closed rather than an orphaned idle background process.
 *
 * The lifecycle sibling of `detach` that does NOT resume headless. `detach`
 * backgrounds a still-wanted agent (stop the terminal, keep it working); `stop`
 * is for when the work is over — the agent's editor tab was closed, or you want
 * it gone. Both reuse the same live-session resolution and the same
 * `stopInteractive` teardown (tmux `kill-session`, else SIGTERM→SIGKILL the pid),
 * so a session killed here reaps its helpers exactly as `detach` does before it
 * resumes.
 *
 * The primary caller is AGI EXT: when a user genuinely closes an agent tab
 * (Cmd+W), the extension runs this so the underlying agent + its mux are shut
 * down instead of being left running detached (the "Cmd+W orphans an idle
 * session" bug). A window RELOAD does NOT call this — the extension distinguishes
 * the two via `terminal.exitStatus.reason` and only a real user close tears down.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { gatherLiveTargets } from './go.js';
import { resolveDetachTarget, resolveOne } from './detach-core.js';
import { stopInteractive } from './detach.js';
import { runOnPeer } from '../lib/session/remote-list.js';
import { setHelpSections } from '../lib/help.js';

export function registerSessionsStopCommand(program: Command): void {
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
      agents sessions stop 4b2f1a9c

      # Only look on this machine (skip the fleet sweep)
      agents sessions stop 4b2f1a9c --local
    `,
    notes: `
      stop ENDS the session; it does not background it. To keep an agent working
      unattended instead, use \`agents sessions detach <id>\`, and bring it back
      with \`agents sessions resume <id>\`.

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

  // Cloud/team/id-less sessions have their own lifecycles — refuse rather than
  // half-stopping one from here (same boundary `detach` enforces).
  if (target.kind === 'refuse') {
    console.error(chalk.red(target.reason));
    process.exitCode = 1;
    return;
  }

  const short = target.sessionId.slice(0, 8);

  // A session on another host: its pid/tmux socket only mean something where it
  // runs, so stop it THERE over SSH — never kill locally. Mirrors detach/focus.
  if (target.kind === 'remote') {
    console.log(chalk.gray(`${short} lives on ${target.machine} — stopping it there over SSH…`));
    const rc = await runOnPeer(['sessions', 'stop', target.sessionId, '--local'], target.machine);
    if (rc === 'no-target') {
      console.error(chalk.red(`Can't reach ${target.machine} to stop ${short}.`));
      process.exitCode = 1;
    }
    return;
  }

  // Local: end the interactive process and tear down its tmux/mux session.
  await stopInteractive(s);
  console.log(chalk.green(`■ Stopped ${s.kind} ${short}`) + chalk.gray(' — process ended, session closed.'));
}
