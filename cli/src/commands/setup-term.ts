
import type { Command } from 'commander';
import chalk from 'chalk';
import { isPromptCancelled } from './utils.js';
import { openSetupTerminal } from './setup-terminal.js';
import { resolveTermBin } from '../lib/term-client.js';
import { installSetupTool } from '../lib/setup-tool-install.js';
import { refreshToolSetup } from '../lib/setup-tool-status.js';

const INSTALL_HINT = 'agents clis install term   # or: npm i -g @phnx-labs/term-cli';

export function isTermCliInstalled(): boolean {
  return resolveTermBin() !== null;
}

export async function runTermWizard(): Promise<boolean> {
  // term ships independently and is spawned on demand; PATH presence is readiness.
  // agents-cli must not rebundle, health-probe, or configure it.
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

export function registerSetupTermCommand(setupCmd: Command): void {
  setupCmd
    .command('term')
    .description('Install the standalone `term` CLI (the PTY engine `agents accounts add`/`login` spawn) if missing.')
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
