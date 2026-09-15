/**
 * Preferences onboarding — the guided path over the same device-config keys the
 * `agents devices …` commands write (lib/device-config.ts). Two questions, each
 * TTY-only, skippable, and absent non-interactively:
 *
 *   1. "Which machine do you sit at?"   → `interactive.host` (central config:)
 *   2. "Which browser should agents drive on THIS machine?"
 *                                       → `browser.profile` (device-local default)
 *
 * Shared by the bare `agents setup` flow (a short step after the capability
 * hub) and by `agents setup fleet` (interactive host after a successful sync).
 * Unset always keeps today's behavior — skipping is a real choice, not a
 * partial state.
 */

import chalk from 'chalk';
import { browserInstalled, runBrowser } from '../lib/browser-client.js';
import { buildBrowserContext } from '../lib/browser/context.js';
import { getConfigValue, setConfigValue } from '../lib/device-config.js';
import { loadDevices, type DeviceRegistry } from '../lib/devices/registry.js';
import { machineId } from '../lib/machine-id.js';
import { isInteractiveTerminal } from './utils.js';

const SKIP = '__skip__';

/** Registered macOS device names, sorted — the interactive-host candidates. */
export function macDeviceNames(reg: DeviceRegistry): string[] {
  return Object.values(reg)
    .filter((d) => d.platform === 'macos')
    .map((d) => d.name)
    .sort();
}

/**
 * The interactive-host picker's highlighted default: this machine when it is a
 * candidate (the common case — you run setup on the box you sit at), else the
 * first candidate. null when there are no candidates.
 */
export function defaultInteractiveHostChoice(candidates: string[], self: string = machineId()): string | null {
  if (candidates.length === 0) return null;
  return candidates.includes(self) ? self : candidates[0];
}

/**
 * Offer to set the interactive host when none is configured and the registry
 * has more than one macOS device. Returns true when a host was set. Silent
 * no-op non-TTY, when already set, or with fewer than two candidates (the
 * answer is obvious or absent).
 */
export async function maybePickInteractiveHost(): Promise<boolean> {
  if (!isInteractiveTerminal()) return false;
  if (getConfigValue('interactive.host').value !== undefined) return false;
  const macs = macDeviceNames(await loadDevices());
  if (macs.length < 2) return false;

  const { select } = await import('@inquirer/prompts');
  const self = machineId();
  const picked = await select({
    message: 'Which machine do you sit at? (agents open browser windows and artifacts there)',
    default: defaultInteractiveHostChoice(macs, self) ?? SKIP,
    choices: [
      ...macs.map((n) => ({ name: n === self ? `${n}  ${chalk.dim('(this machine)')}` : n, value: n })),
      { name: `Skip ${chalk.dim('— decide later: agents devices config <name> interactive.host <name>')}`, value: SKIP },
    ],
  });
  if (picked === SKIP) return false;
  setConfigValue('interactive.host', picked);
  console.log(chalk.green(`Interactive host: '${picked}'`) + chalk.dim(' — marked ★ interactive in `agents devices list`.'));
  return true;
}

/**
 * Offer to pin this machine's default browser profile to a chosen browser.
 * Only asked when there is nothing to preserve: no configured device default
 * AND no existing `default` profile (an existing profile is the user's earlier
 * choice — never re-pinned behind their back). The list is the installed
 * Chromium-family browsers plus a "None — this box uses the fleet hub" opt-out.
 *
 * This is the ONE place a default browser is chosen for a machine (PHNX-3296):
 * a bare `agents browser start` no longer auto-detects and mints one, so picking
 * here (or `agents browser use` / `agents setup browser` later) is how a box
 * gets a local default at all. Picking "None" leaves it to the fleet hub
 * (`browser.device`). Returns true when a profile was created and set as the
 * device default. Silent no-op non-TTY — a headless box relies on the hub.
 */
export async function maybePickBrowserProfile(deps: {
  /** Force interactivity in a test; defaults to a real TTY probe. */
  interactive?: boolean;
} = {}): Promise<boolean> {
  const interactive = deps.interactive ?? isInteractiveTerminal();
  if (!interactive) return false;
  // Already chosen (by an earlier setup, `agents browser use`, or browser-cli
  // directly) — never re-pin behind the user's back.
  if ((getConfigValue('browser.profile').value as string | undefined)) return false;
  // The engine owns detection and profile creation (PHNX-4101); it is optional,
  // so skip the pick quietly when it is not installed rather than nagging.
  if (!browserInstalled()) return false;

  // Let the engine detect installed browsers and create a machine-local profile
  // for each (idempotent), then open its own picker to set this machine's default.
  const context = await buildBrowserContext();
  const seed = await runBrowser({ argv: ['profiles', 'seed'], context });
  if (seed.exitCode !== 0) return false;
  await runBrowser({ argv: ['use'], context });

  const chosen = getConfigValue('browser.profile').value as string | undefined;
  if (!chosen) return false;
  console.log(
    chalk.green(`Browser: '${chosen}'`) +
      chalk.dim(' — this machine\'s default (agents browser use to change).'),
  );
  return true;
}

/**
 * The bare-`agents setup` preferences step: interactive host, then browser.
 * Runs AFTER the capability hub so it never delays the bootstrap. Never
 * throws — a prompt cancel or a failed pick ends the step quietly and lets
 * setup complete (the same semantics as the capability hub).
 */
export async function runPreferencesStep(): Promise<void> {
  if (!isInteractiveTerminal()) return;
  try {
    const pickedHost = await maybePickInteractiveHost();
    const pickedBrowser = await maybePickBrowserProfile();
    if (pickedHost || pickedBrowser) console.log();
  } catch {
    // Cancel (ctrl-c) or a picker failure — the step is optional; end it.
  }
}
