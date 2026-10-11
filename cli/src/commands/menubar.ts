import type { Command } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import {
  updateMenubarHelperIfNewer,
  disableMenubarService,
  restartMenubarHelper,
} from '../lib/menubar/install-menubar.js';

export function registerMenubarCommands(program: Command): void {
  const menubar = program
    .command('menubar', { hidden: true })
    .description('AGI Menu lifecycle hooks the helper calls (status lives in `agents doctor`)');

  const update = menubar.command('update', { hidden: true })
    .description('Check for or install the newest AGI Menu release')
    .option('--check', 'Check only; do not download, install, or restart the app')
    .option('--json', 'Emit machine-readable update status')
    .action(async (options: { check?: boolean; json?: boolean }) => {
      const status = await updateMenubarHelperIfNewer({ manual: true, dryRun: options.check, deferRestart: true });
      if (options.json) process.stdout.write(`${JSON.stringify(status)}\n`);
      else console.log(status.detail);
      if (status.outcome === 'failed') process.exitCode = 1;
    });

  setHelpSections(update, {
    examples: `
      agents menubar update --check --json
      agents menubar update --json
      agents config set menubar.autoUpdate false
    `,
    notes: `
      Checks and updates only AGI Menu, independently of agents-cli.
      Automatic updates default on and check about every 12 hours while awake.
      Manual updates work with automatic updates off. JSON reports lookup and
      installation errors; a successful install hands off a bounded app restart
      after this command exits. Check-only never installs or restarts the app.
    `,
  });

  const restart = menubar.command('restart', { hidden: true })
    .description('Restart the running AGI Menu through its login item')
    .option('--json', 'Emit machine-readable restart result')
    .action(async (options: { json?: boolean }) => {
      const result = await restartMenubarHelper();
      if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
      else console.log(result.outcome === 'failed' ? chalk.red(result.detail) : chalk.green(result.detail));
      if (result.outcome === 'failed') process.exitCode = 1;
    });

  setHelpSections(restart, {
    examples: `
      agents menubar restart
      agents menubar restart --json
    `,
    notes: `
      Restarts AGI Menu with launchctl kickstart -k and waits up to 15 seconds
      for exactly one new process. The kickstart runs in its own session, so
      the restart completes even when AGI Menu itself requested it. A turned-off
      AGI Menu is refused rather than started; \`agents config set menubar.enabled true\`
      turns it on.
    `,
  });

  menubar
    .command('snapshot', { hidden: true })
    .description('Emit the consolidated AGI Menu polling snapshot.')
    .option('--json', 'Emit machine-readable JSON')
    .action(async () => {
      const { computeMenubarSnapshot } = await import('../lib/menubar/snapshot.js');
      process.stdout.write(`${JSON.stringify(await computeMenubarSnapshot())}\n`);
    });

  menubar
    .command('disable', { hidden: true })
    .description('Set menubar.enabled false and remove the AGI Menu login item')
    .action(() => {
      if (process.platform !== 'darwin') {
        console.log(chalk.yellow('AGI Menu is macOS only.'));
        return;
      }
      disableMenubarService();
      console.log(chalk.green('AGI Menu disabled.') + chalk.gray('  Re-enable with `agents config set menubar.enabled true`.'));
    });
}
