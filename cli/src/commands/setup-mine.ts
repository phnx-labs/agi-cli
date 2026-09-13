/**
 * `agents setup mine` — interactive wizard to white-label the CLI under your own
 * name. Pick a name, choose which features to turn off, and get a personally-
 * named binary (e.g. `jack`) that runs every agents verb as yours. Delegates the
 * actual minting to `initBrand` (see mine.ts). Manage verbs (init/list/toggle/
 * remove) live under the same `setup mine` command.
 *
 * Idempotent: re-running for an existing brand offers to re-mint it.
 * Bare `agents setup mine` (no subcommand) runs the wizard.
 */

import type { Command } from 'commander';
import chalk from 'chalk';

import { initBrand, registerMineManageCommands } from './mine.js';
import { validateBrandName, getBrandConfig } from '../lib/brand.js';
import { isShimsInPath } from '../lib/installations/shims.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';

/**
 * Optional/heavier top-level commands a brand commonly turns off. Kept short so
 * the checkbox is scannable — anything can still be toggled later with
 * `agents setup mine toggle <name> --disable <cmd>`.
 */
const DISABLEABLE_FEATURES: Array<{ name: string; hint: string }> = [
  { name: 'teams', hint: 'coordinate multiple agents on shared work' },
  { name: 'cloud', hint: 'dispatch agent tasks to the cloud' },
  { name: 'browser', hint: 'automate a browser' },
  { name: 'computer', hint: 'drive native desktop apps' },
  { name: 'secrets', hint: 'keychain-backed env bundles' },
  { name: 'routines', hint: 'run agents on a cron schedule' },
  { name: 'monitors', hint: 'event-triggered watchers' },
];

/**
 * Interactive white-label setup. Returns true when a brand exists afterward,
 * false if the user backed out. Never throws on cancel — the `agents setup` hub
 * relies on that.
 */
async function runMineWizard(): Promise<boolean> {
  if (!isInteractiveTerminal()) {
    console.log(
      chalk.dim('Non-interactive shell. Create a brand directly, e.g.:\n') +
        chalk.cyan('  agents setup mine init jack --disable teams cloud'),
    );
    return false;
  }

  const { input, checkbox, confirm } = await import('@inquirer/prompts');

  console.log(chalk.bold('Make it yours — a personally-named CLI that IS agents-cli.\n'));

  const name = (
    await input({
      message: 'What should your CLI be called? (e.g. jack)',
      validate: (v: string) => {
        const err = validateBrandName(v.trim());
        return err ?? true;
      },
    })
  ).trim();

  // Existing brand → offer to re-mint rather than error out.
  let force = false;
  if (getBrandConfig(name)) {
    const again = await confirm({
      message: `Brand "${name}" already exists. Re-mint it?`,
      default: false,
    });
    if (!again) {
      printNextSteps(name, !isShimsInPath());
      return true;
    }
    force = true;
  }

  const disabled = await checkbox({
    message: `Any features to turn OFF for ${name}? (space to toggle, enter to accept)`,
    choices: DISABLEABLE_FEATURES.map((f) => ({
      name: `${f.name}  ${chalk.dim(f.hint)}`,
      value: f.name,
    })),
    required: false,
  });

  const { pathWarning } = initBrand(name, { disabledCommands: disabled, force });

  console.log(chalk.green(`\nMinted ${chalk.bold(name)} — your own agents CLI.`));
  if (disabled.length > 0) {
    console.log(chalk.dim(`  turned off: ${disabled.join(', ')}`));
  }
  printNextSteps(name, pathWarning);
  return true;
}

function printNextSteps(name: string, pathWarning: boolean): void {
  console.log(chalk.bold('\nTry it:'));
  console.log('  ' + chalk.cyan(`${name} --help`) + chalk.dim(`         # your CLI, your name`));
  console.log('  ' + chalk.cyan(`${name} run claude "hello"`));
  console.log(chalk.dim(`  Manage it later:  agents setup mine toggle ${name} --disable <cmd>   ·   agents setup mine list`));
  if (pathWarning) {
    console.log(
      chalk.yellow(`\n  note: the shims dir isn't on your PATH yet — run 'agents setup' or open a new shell.`),
    );
  }
}

/**
 * Register `agents setup mine` under the parent `setup` command.
 * Bare invocation runs the wizard; init/list/toggle/remove manage brands.
 */
export function registerSetupMineCommand(setupCmd: Command): void {
  const mineCmd = setupCmd
    .command('mine')
    .description('White-label the CLI — mint your own personally-named binary (e.g. `jack`).')
    .action(async () => {
      try {
        await runMineWizard();
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.yellow('\nCancelled'));
          return;
        }
        console.error(chalk.red((err as Error).message));
        process.exitCode = 1;
      }
    });

  registerMineManageCommands(mineCmd);
}
