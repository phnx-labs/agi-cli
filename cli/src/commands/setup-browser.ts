/**
 * `agents setup browser` — get `agents browser` working on a fresh machine:
 * install the standalone `browser` CLI (@phnx-labs/browser-cli), let it detect
 * installed browsers and create machine-local profiles (`browser profiles seed`),
 * then pick this machine's default (`browser use`).
 *
 * The engine owns profile declarations and browser detection now (PHNX-4101), so
 * this wizard DELEGATES to it rather than crafting profiles itself. What stays
 * agents-cli's is the onboarding flow and the readiness check over the shared
 * `browser.profile` config key both CLIs read/write.
 *
 * Idempotent: `profiles seed` leaves existing profiles untouched, and `use`
 * re-points the device default.
 */

import type { Command } from 'commander';
import { openSetupTerminal } from './setup-terminal.js';
import chalk from 'chalk';
import { getConfigValue } from '../lib/device-config.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { installSetupTool } from '../lib/setup-tool-install.js';
import { refreshToolSetup } from '../lib/setup-tool-status.js';
import { browserInstalled, runBrowser } from '../lib/browser-client.js';
import { buildBrowserContext } from '../lib/browser/context.js';

/** The device-local default profile, as both agents-cli and browser-cli see it. */
function configuredDefaultProfile(): string | undefined {
  return (getConfigValue('browser.profile').value as string | undefined) || undefined;
}

/** Run one standalone `browser` verb, inheriting the terminal, and return its exit code. */
async function runBrowserVerb(argv: string[]): Promise<number> {
  const { exitCode } = await runBrowser({ argv, context: await buildBrowserContext() });
  return exitCode;
}

/**
 * Interactive browser setup. Returns true if a default profile is configured
 * afterwards, false if none is / the user backed out. Non-interactively it only
 * RECOGNIZES an existing default — it never creates one (PHNX-3296), since
 * silently minting a logged-out profile on a headless box is the exact bug that
 * removed; a headless box gets its browser from the fleet hub. Never throws on
 * cancel — the `agents setup` hub relies on that.
 */
export async function runBrowserWizard(): Promise<boolean> {
  if (!isInteractiveTerminal()) {
    const existing = configuredDefaultProfile();
    if (existing) {
      console.log(chalk.dim(`Default browser profile "${existing}" already configured on this machine.`));
      return true;
    }
    console.log(
      chalk.dim(
        'No default browser profile on this machine. Re-run `agents setup browser` in an ' +
          'interactive terminal to pick one, or use the fleet hub: agents config set browser.device <host>.',
      ),
    );
    return false;
  }

  if (!browserInstalled()) {
    console.log(chalk.dim('Installing the standalone Browser CLI (@phnx-labs/browser-cli)…'));
    if (!(await installSetupTool('browser'))) {
      console.error(chalk.red('Could not install @phnx-labs/browser-cli. Install it manually with `npm i -g @phnx-labs/browser-cli`, then re-run.'));
      return false;
    }
  }

  // Let the engine detect installed browsers and create a machine-local profile
  // for each (idempotent), then open its own picker to set this machine's default.
  const seedCode = await runBrowserVerb(['profiles', 'seed']);
  if (seedCode !== 0) {
    console.error(chalk.red('`browser profiles seed` failed — see the output above.'));
    return false;
  }
  await runBrowserVerb(['use']);

  const chosen = configuredDefaultProfile();
  if (!chosen) {
    console.log(chalk.dim('No default profile chosen. Run `agents browser use <name>` later to set one.'));
    return false;
  }
  printOnboardingNextStep(chosen);
  return true;
}

/** The one step we can't automate: the browser's first-run + your own sign-in. */
function printOnboardingNextStep(name: string): void {
  console.log(chalk.bold('\nOne manual step left:'));
  console.log(
    '  ' +
      chalk.cyan(`agents browser start --profile ${name}`) +
      chalk.dim('   # finish the browser first-run + sign in to any sites you want automated'),
  );
  console.log(chalk.dim(`  Then check it's ready:  agents browser profiles doctor ${name}`));
}

/** Register `agents setup browser` under the parent `setup` command. */
export function registerSetupBrowserCommand(setupCmd: Command): void {
  setupCmd
    .command('browser')
    .description('Set up `agents browser` — install the Browser CLI, seed profiles, and pick this machine\'s default.')
    .option('--install-only', 'Install the standalone Browser CLI without changing profiles or starting a browser')
    .option('--terminal [backend]', 'Open interactive setup in a detected or selected terminal')
    .action(async (options: { installOnly?: boolean; terminal?: boolean | string }) => {
      try {
        if (options.terminal !== undefined) { await openSetupTerminal('browser', options.terminal, options.installOnly); return; }
        if (options.installOnly) { if (!(await installSetupTool('browser'))) process.exitCode = 1; return; }
        if (!(await runBrowserWizard())) process.exitCode = 1;
        await refreshToolSetup('browser');
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
