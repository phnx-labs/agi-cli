/**
 * `agents sessions` — read queries passthrough to the standalone `sessions`
 * CLI (PHNX-4012). Lifecycle verbs (resume/stop/inject/watch/…) stay on the
 * in-repo engine so v1 of sessions-cli can ship the 2 ms search path without
 * pulling exec/tmux/accounts.
 *
 * DIST-1 on the read path: a missing `sessions` binary fails loud.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import {
  invocation,
  isReadQuery,
  resolveSessionsBin,
  SessionsClientError,
  SESSIONS_INSTALL_HINT,
} from '../lib/sessions-client.js';

export function registerSessionsCommands(program: Command): void {
  program
    .command('sessions')
    .description(
      'Find and read agent transcripts — search/list passthrough to `sessions`; resume/stop stay here.',
    )
    .allowUnknownOption()
    .allowExcessArguments()
    .helpOption(false)
    .action(async () => {
      const sessionsIndex = process.argv.indexOf('sessions');
      const forwarded = sessionsIndex >= 0 ? process.argv.slice(sessionsIndex + 1) : [];

      if (!isReadQuery(forwarded)) {
        const { registerSessionsCommands: registerLegacy } = await import('./sessions.js');
        const { Command: Nested } = await import('commander');
        const inner = new Nested('agents');
        registerLegacy(inner);
        await inner.parseAsync(['node', 'agents', 'sessions', ...forwarded]);
        return;
      }

      let bin: string;
      try {
        bin = resolveSessionsBin();
      } catch (err) {
        if (err instanceof SessionsClientError && err.code === 'SESSIONS_BIN_MISSING') {
          console.error(chalk.red('The standalone `sessions` CLI is not installed.'));
          console.error(chalk.gray('Install it, then re-run this command:'));
          console.error(chalk.cyan(`  ${SESSIONS_INSTALL_HINT}`));
          process.exit(1);
        }
        throw err;
      }
      const { command, prefix } = invocation(bin);
      const res = spawnSync(command, [...prefix, ...forwarded], { stdio: 'inherit' });
      if (res.error) {
        console.error(chalk.red(`Failed to run \`sessions\`: ${res.error.message}`));
        process.exit(1);
      }
      process.exit(res.status ?? 1);
    });
}
