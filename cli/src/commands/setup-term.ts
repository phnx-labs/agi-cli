/**
 * `agents setup term` — install the standalone `term` CLI if missing (PHNX-4092).
 *
 * The PTY engine lives in `@phnx-labs/term-cli` (extracted PHNX-4091);
 * agents-cli never rebundles it. The OAuth device-code driver (`agents fleet
 * login`, `agents auth mint`) spawns `term` on demand and fails loud when it is
 * absent, so onboarding installs it here like every other standalone tool.
 *
 * Unlike browser/computer/secrets there is nothing to configure — no profile,
 * no OS permission, no migrate step. A missing binary is a routine install
 * (`agents clis install term` via the system `clis/term.yaml`, then a pinned
 * `npm i -g`, both handled by installSetupTool), and once it is on PATH the
 * tool is ready.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { isPromptCancelled } from './utils.js';
import { openSetupTerminal } from './setup-terminal.js';
import { resolveTermBin } from '../lib/term-client.js';
import { installSetupTool } from '../lib/setup-tool-install.js';
import { refreshToolSetup } from '../lib/setup-tool-status.js';

const INSTALL_HINT = 'agents clis install term   # or: npm i -g @phnx-labs/term-cli';

/** True when the standalone `term` executable resolves ($TERM_BIN or PATH). */
export function isTermCliInstalled(): boolean {
  return resolveTermBin() !== null;
}

/**
 * Install the standalone `term` CLI if missing. Returns whether `term` is on
 * PATH afterwards. There is no further onboarding — presence is readiness.
 */
export async function runTermWizard(): Promise<boolean> {
  if (isTermCliInstalled()) {
    console.log(chalk.green('The standalone `term` CLI is installed.'));
    return true;
  }
  if (await installSetupTool('term')) {
    console.log(chalk.green('Installed the standalone `term` CLI.'));
    return true;
  }
  console.log(chalk.yellow('The standalone `term` CLI is not installed.'));
  console.log(chalk.gray('Install it, then re-run `agents setup term`:'));
  console.log(chalk.cyan(`  ${INSTALL_HINT}`));
  return false;
}

/** Register `agents setup term` under the parent `setup` command. */
export function registerSetupTermCommand(setupCmd: Command): void {
  setupCmd
    .command('term')
    .description('Install the standalone `term` CLI (the PTY engine fleet login and auth mint spawn) if missing.')
    .option('--install-only', 'Install the standalone term CLI (identical to the wizard; term needs no further setup)')
    .option('--terminal [backend]', 'Open interactive setup in a detected or selected terminal')
    .action(async (options: { installOnly?: boolean; terminal?: boolean | string }) => {
      try {
        if (options.terminal !== undefined) { await openSetupTerminal('term', options.terminal, options.installOnly); return; }
        if (!(await runTermWizard())) process.exitCode = 1;
        await refreshToolSetup('term');
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.yellow('\nCancelled'));
          return;
        }
        console.error(chalk.red((err as Error).message));
        process.exitCode = 1;
      }
    });
}
