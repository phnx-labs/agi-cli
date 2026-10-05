
import chalk from 'chalk';
import { browserInstalled, runBrowser } from '../lib/browser-client.js';
import { buildBrowserContext } from '../lib/browser/context.js';
import { getConfigValue, setConfigValue } from '../lib/device-config.js';
import { loadDevices, type DeviceRegistry } from '../lib/devices/registry.js';
import { machineId } from '../lib/machine-id.js';
import { isInteractiveTerminal } from './utils.js';

const SKIP = '__skip__';

export function macDeviceNames(reg: DeviceRegistry): string[] {
  return Object.values(reg)
    .filter((d) => d.platform === 'macos')
    .map((d) => d.name)
    .sort();
}

export function defaultInteractiveHostChoice(candidates: string[], self: string = machineId()): string | null {
  if (candidates.length === 0) return null;
  return candidates.includes(self) ? self : candidates[0];
}

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

export async function maybePickBrowserProfile(deps: {
  interactive?: boolean;
} = {}): Promise<boolean> {
  // Preserve an existing choice. Standalone browser owns discovery/profile creation;
  // absent, headless, or cancelled setup is a no-op and fleet routing remains valid.
  const interactive = deps.interactive ?? isInteractiveTerminal();
  if (!interactive) return false;
  if ((getConfigValue('browser.profile').value as string | undefined)) return false;
  if (!browserInstalled()) return false;

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

export async function runPreferencesStep(): Promise<void> {
  // Preference prompts are optional; cancellation must not fail setup.
  if (!isInteractiveTerminal()) return;
  try {
    const pickedHost = await maybePickInteractiveHost();
    const pickedBrowser = await maybePickBrowserProfile();
    if (pickedHost || pickedBrowser) console.log();
  } catch {
  }
}
