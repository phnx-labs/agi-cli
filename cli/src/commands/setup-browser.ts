/**
 * `agents setup browser` — interactive wizard to get `agents browser` working on
 * a fresh machine: detect an installed Chromium-family browser, create the
 * `default` profile pinned to it, optionally make it this machine's default, and
 * point the user at the one manual step we can't automate (first-run + sign-in).
 *
 * Idempotent: re-running shows the current default profile and offers to change
 * the pinned browser or re-point the device default.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { setConfigValue } from '../lib/device-config.js';
import { listInstalledBrowsers } from '../lib/browser/chrome.js';
import {
  DEFAULT_BROWSER_PROFILE_NAME,
  getAutoDetectedProfile,
  createProfile,
  findFreeProfilePort,
  getConfiguredDefaultProfileName,
  type BrowserProfile,
} from '../lib/browser/profiles.js';
import { DEFAULT_VIEWPORT } from '../lib/browser/devices.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { defaultBrowserChoice } from './setup-preferences.js';

const INSTALL_HINT =
  'Install one of: Google Chrome, Brave, Microsoft Edge, Chromium, Comet, Arc, or Firefox, then re-run `agents setup browser`.\n' +
  '(Safari is not supported — agents browser drives over the Chrome DevTools Protocol, Arc natively, and Firefox over WebDriver BiDi.)';

/**
 * Interactive browser setup. Returns true if a usable default profile exists
 * afterwards, false if none exists / the user backed out. Non-interactively it
 * only RECOGNIZES an existing profile — it never creates one (PHNX-3296), since
 * silently minting a logged-out `auto-chrome` on a headless box is the exact bug
 * that removed; a headless box gets its browser from the fleet hub. Never throws
 * on cancel — the `agents setup` hub relies on that.
 */
export async function runBrowserWizard(): Promise<boolean> {
  if (!isInteractiveTerminal()) {
    // Non-interactive / headless: recognize an existing default, but NEVER mint
    // one. Silently auto-detecting an installed browser and creating an
    // `auto-chrome` here is exactly the bug PHNX-3296 removed — a headless box
    // gets its browser from the fleet hub (`browser.device`), or from an
    // interactive pick later.
    const existing = await getAutoDetectedProfile();
    if (existing) {
      console.log(chalk.dim(`Browser profile "${existing.name}" already exists.`));
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

  const installed = listInstalledBrowsers();
  if (installed.length === 0) {
    console.error(chalk.red('No supported browser found on this machine.'));
    console.log(chalk.dim(INSTALL_HINT));
    return false;
  }

  const { confirm, select } = await import('@inquirer/prompts');

  // If a default profile already exists, this is a reconfigure.
  const existing = await getAutoDetectedProfile();
  if (existing) {
    console.log(
      chalk.dim(
        `Browser profile "${existing.name}" already exists (${existing.browser}${existing.binary ? ` · ${existing.binary}` : ''}).`,
      ),
    );
    const change = await confirm({ message: 'Re-create it (e.g. to pin a different browser)?', default: false });
    if (!change) {
      await maybeSetDeviceDefault(existing.name, confirm);
      printOnboardingNextStep(existing.name);
      return true;
    }
    // Re-create: drop the old one so createProfile doesn't collide.
    const { deleteProfile } = await import('../lib/browser/profiles.js');
    await deleteProfile(existing.name);
  }

  // Pick which installed browser to pin (auto-select if only one). The picker
  // highlights the same browser auto-detect would win — choosing is an
  // override of the default, never a guess.
  let chosen = installed[0];
  if (installed.length > 1) {
    const value = await select({
      message: 'Which browser should the default profile use?',
      default: defaultBrowserChoice(installed) ?? undefined,
      choices: installed.map((b) => ({ name: `${b.browserType}  ${chalk.dim(b.binary)}`, value: b.browserType })),
    });
    chosen = installed.find((b) => b.browserType === value) ?? installed[0];
  }

  const freePort = await findFreeProfilePort();
  const profile: BrowserProfile = {
    name: DEFAULT_BROWSER_PROFILE_NAME,
    description: `${chosen.browserType} profile (agents setup browser)`,
    browser: chosen.browserType,
    binary: chosen.binary,
    endpoints: [`cdp://127.0.0.1:${freePort}`],
    viewport: { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height },
  };
  await createProfile(profile);
  console.log(chalk.green(`\nCreated browser profile "${profile.name}" → ${chosen.browserType} (CDP 127.0.0.1:${freePort}).`));

  await maybeSetDeviceDefault(profile.name, confirm);
  printOnboardingNextStep(profile.name);
  return true;
}

/** Offer to make `name` this machine's default browser profile (device-local). */
async function maybeSetDeviceDefault(
  name: string,
  confirm: (typeof import('@inquirer/prompts'))['confirm'],
): Promise<void> {
  const current = getConfiguredDefaultProfileName();
  if (current === name) return; // already the device default
  const set = await confirm({
    message: `Make "${name}" this machine's default browser profile?`,
    default: true,
  });
  if (set) {
    setConfigValue('browser.profile', name);
    console.log(chalk.dim(`Bare \`agents browser start\` will now use "${name}" on this machine.`));
  }
}

/** The one step we can't automate: Chrome's first-run + your own sign-in. */
function printOnboardingNextStep(name: string): void {
  console.log(chalk.bold('\nOne manual step left:'));
  console.log(
    '  ' +
      chalk.cyan(`agents browser start --profile ${name}`) +
      chalk.dim('   # finish Chrome first-run + sign in to any sites you want automated'),
  );
  console.log(chalk.dim(`  Then check it's ready:  agents browser profiles doctor ${name}`));
}

/** Register `agents setup browser` under the parent `setup` command. */
export function registerSetupBrowserCommand(setupCmd: Command): void {
  setupCmd
    .command('browser')
    .description('Set up `agents browser` — detect an installed browser and create the default profile.')
    .action(async () => {
      try {
        await runBrowserWizard();
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
