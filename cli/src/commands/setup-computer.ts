/**
 * `agents setup computer` — guided setup for `agents computer` on macOS: fetch +
 * verify the signed helper, install it, then walk the user through the two TCC
 * permission grants (Accessibility + Screen Recording) by opening the exact
 * System Settings panes and polling until the grant lands.
 *
 * The plain `agents computer setup` / `start` commands remain for scripted use;
 * this wizard chains them with the permission hand-holding a fresh machine needs.
 * Idempotent: re-running re-installs the current helper and re-checks trust.
 */

import type { Command } from 'commander';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import chalk from 'chalk';
import {
  installComputerHelperMacLocal,
  activateComputerHelperMacLocal,
  probeComputerTrust,
} from './computer.js';
import { resolveComputerBin, ComputerClientError } from '../lib/computer-client.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';

const ACCESSIBILITY_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const SCREEN_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Open a System Settings Privacy pane (best-effort — never throws). */
function openPane(pane: string): void {
  try {
    execFileSync('/usr/bin/open', [pane], { stdio: 'ignore' });
  } catch {
    // ignore — we print the manual path as a fallback
  }
}

/**
 * Interactive computer setup. Returns true if the helper is installed and trust
 * is granted (or the user chose to finish later), false if unsupported/aborted.
 * Never throws on cancel — the `agents setup` hub relies on that.
 */
export async function runComputerWizard(): Promise<boolean> {
  if (os.platform() !== 'darwin') {
    console.log(chalk.yellow('`agents setup computer` configures the macOS helper (local control).'));
    console.log(
      chalk.dim(
        'On Windows, provision a remote host from a Mac/Linux box instead: `agents computer setup --device <device>`.',
      ),
    );
    return false;
  }

  try {
    resolveComputerBin();
  } catch (error) {
    if (!(error instanceof ComputerClientError) || error.code !== 'COMPUTER_BIN_MISSING') throw error;
    console.log('Installing @phnx-labs/computer-cli@0.1.2…');
    const installed = spawnSync('npm', ['install', '-g', '@phnx-labs/computer-cli@0.1.2'], { stdio: 'inherit' });
    if (installed.status !== 0) return false;
    try { resolveComputerBin(); }
    catch { console.error('Computer CLI installation did not produce an executable on PATH.'); return false; }
  }

  // 1. Download + verify + install the signed, notarized helper.
  console.log(chalk.bold('Installing the Agents Computer helper...'));
  try {
    await installComputerHelperMacLocal();
  } catch (err) {
    console.error(chalk.red(`Install failed: ${(err as Error).message}`));
    return false;
  }

  // 2. Activate the daemon so macOS can attribute the TCC grants to it.
  console.log(chalk.bold('\nStarting the helper...'));
  let trusted = false;
  try {
    ({ trusted } = await activateComputerHelperMacLocal());
  } catch (err) {
    console.error(chalk.red(`Could not start the helper: ${(err as Error).message}`));
    return false;
  }

  // 3. Guide the two permission grants if not already trusted.
  if (!trusted) {
    console.log(chalk.bold('\nGrant two permissions to "Agents Computer" (one-time):'));
    console.log('  1. ' + chalk.cyan('Accessibility') + chalk.dim('     — lets it click/type'));
    console.log('  2. ' + chalk.cyan('Screen Recording') + chalk.dim('  — lets it screenshot windows'));
    console.log(chalk.dim('\nOpening System Settings > Privacy & Security ...'));
    openPane(ACCESSIBILITY_PANE);

    if (isInteractiveTerminal()) {
      trusted = await pollForTrust();
    }
    // Also nudge the Screen Recording pane so both are visible.
    openPane(SCREEN_PANE);

    if (!trusted) {
      console.log(chalk.yellow('\nAccessibility not granted yet.'));
      console.log(chalk.dim('Finish both grants in System Settings, then run: ') + chalk.cyan('agents computer start'));
      console.log(chalk.dim('  Accessibility:    System Settings > Privacy & Security > Accessibility'));
      console.log(chalk.dim('  Screen Recording: System Settings > Privacy & Security > Screen Recording'));
    }
  }

  if (trusted) {
    console.log(chalk.green('\nComputer control is ready.'));
  }

  // 4. App allow-list guidance (deny-by-default) — always shown; it's the gate
  // between "trusted" and "can actually drive an app".
  console.log(chalk.bold('\nWhitelist the apps the helper may drive (default is deny-all):'));
  console.log(chalk.dim('  Add a YAML under ~/.agents/permissions/groups/, e.g. computer.yaml:'));
  console.log(chalk.dim('    name: computer'));
  console.log(chalk.dim('    allow:'));
  console.log(chalk.dim('      - "Computer(com.apple.finder)"'));
  console.log(chalk.dim('      - "Computer(com.apple.notes)"'));
  console.log(chalk.dim('  Then reload: ') + chalk.cyan('agents computer reload'));

  return trusted;
}

/**
 * Poll the daemon's trust status while the user toggles the Accessibility
 * checkbox in System Settings. Bounded to ~2 minutes; the user can Ctrl+C.
 */
async function pollForTrust(): Promise<boolean> {
  const { default: ora } = await import('ora');
  const spinner = ora('Waiting for Accessibility to be granted (toggle the checkbox in System Settings)...').start();
  const deadline = Date.now() + 120_000;
  try {
    while (Date.now() < deadline) {
      if (await probeComputerTrust()) {
        spinner.succeed('Accessibility granted.');
        return true;
      }
      await sleep(2000);
    }
    spinner.stop();
    return false;
  } catch {
    spinner.stop();
    return false;
  }
}

/** Register `agents setup computer` under the parent `setup` command. */
export function registerSetupComputerCommand(setupCmd: Command): void {
  setupCmd
    .command('computer')
    .description('Set up `agents computer` (macOS) — install the signed helper and grant control permissions.')
    .action(async () => {
      try {
        await runComputerWizard();
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
