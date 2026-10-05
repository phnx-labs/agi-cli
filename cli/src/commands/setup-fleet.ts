/** `agents setup fleet`: guided Tailscale onboarding as a front door over existing fleet/device
 * commands (sync, auth, SSH config, device tests, optional fleet updater), reimplementing none of
 * them. */

import type { Command } from 'commander';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import { getCliLaunch } from '../lib/cli-entry.js';
import { loadDevices } from '../lib/devices/registry.js';
import { runDeviceSync } from '../lib/devices/sync.js';
import { setDeviceDiscoveryStatus } from '../lib/devices/discovery-policy.js';
import { tailscaleStatusJson } from '../lib/devices/tailscale.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { maybePickInteractiveHost } from './setup-preferences.js';

type FleetAuthMethod = 'key' | 'password';

interface SetupFleetOptions {
  auth?: string;
  bundle?: string;
  bundleKey?: string;
  yes?: boolean;
  writeSshConfig?: boolean;
  testConnectivity?: boolean;
  fleetUpdate?: boolean;
}

function parseAuth(raw: string | undefined): FleetAuthMethod {
  const value = (raw ?? 'key').toLowerCase();
  if (value === 'key' || value === 'password') return value;
  throw new Error(`Invalid --auth '${raw}'. Use key or password.`);
}

function runAgentsSubcommand(args: string[], opts: { optional?: boolean } = {}): boolean {
  const launch = getCliLaunch(args);
  const res = spawnSync(launch.command, launch.args, { stdio: 'inherit', env: process.env });
  if ((res.status ?? 1) === 0) return true;
  if (opts.optional) return false;
  throw new Error(`agents ${args.join(' ')} failed with exit ${res.status ?? 1}.`);
}

function commandExists(command: string): boolean {
  const res = spawnSync(command, ['version'], { stdio: 'ignore', windowsHide: true });
  if (!res.error) return true;
  const fallback = spawnSync(command, ['--version'], { stdio: 'ignore', windowsHide: true });
  return !fallback.error;
}

function tailscaleStatusOk(): boolean {
  try {
    tailscaleStatusJson();
    return true;
  } catch {
    return false;
  }
}

function printTailscaleInstallInstructions(): void {
  console.error(chalk.red('Tailscale is not installed or not on PATH.'));
  const platform = process.platform;
  console.log(chalk.bold('\nInstall Tailscale, then re-run `agents setup fleet`:'));
  if (platform === 'darwin') {
    console.log(chalk.cyan('  brew install --cask tailscale'));
    console.log(chalk.gray('  or install from https://tailscale.com/download/mac'));
  } else if (platform === 'linux') {
    console.log(chalk.cyan('  curl -fsSL https://tailscale.com/install.sh | sh'));
    console.log(chalk.gray('  then run: sudo tailscale up'));
  } else if (platform === 'win32') {
    console.log(chalk.cyan('  winget install Tailscale.Tailscale'));
    console.log(chalk.gray('  or install from https://tailscale.com/download/windows'));
  } else {
    console.log(chalk.gray('  https://tailscale.com/download'));
  }
}

async function resolveInteractiveChoices(opts: SetupFleetOptions): Promise<{
  auth: FleetAuthMethod;
  writeSshConfig: boolean;
  testConnectivity: boolean;
  fleetUpdate: boolean;
}> {
  if (!isInteractiveTerminal()) {
    return {
      auth: parseAuth(opts.auth),
      writeSshConfig: Boolean(opts.writeSshConfig),
      testConnectivity: Boolean(opts.testConnectivity),
      fleetUpdate: Boolean(opts.fleetUpdate),
    };
  }

  const { confirm, select } = await import('@inquirer/prompts');
  const auth = opts.auth ? parseAuth(opts.auth) : await select<FleetAuthMethod>({
    message: 'Default SSH auth for registered devices',
    default: 'key',
    choices: [
      { name: 'key — use your SSH agent / on-disk public keys', value: 'key' },
      { name: 'password — read the login password from an agents secrets bundle', value: 'password' },
    ],
  });
  return {
    auth,
    writeSshConfig: opts.writeSshConfig ?? await confirm({
      message: 'Write ~/.ssh/config.d/agents for plain ssh/scp/rsync?',
      default: true,
    }),
    testConnectivity: opts.testConnectivity ?? await confirm({
      message: 'Test connectivity with `agents ssh <device> uname`?',
      default: true,
    }),
    fleetUpdate: opts.fleetUpdate ?? await confirm({
      message: 'Run `agents fleet update` on online devices now?',
      default: false,
    }),
  };
}

async function syncDevices(opts: SetupFleetOptions): Promise<boolean> {
  if (isInteractiveTerminal() && !opts.yes) {
    return runAgentsSubcommand(['devices', 'sync'], { optional: true });
  }
  const res = await runDeviceSync({ soft: true });
  if (!res.ok) {
    console.error(chalk.red(`Tailscale discovery failed: ${res.reason ?? 'unknown error'}`));
    return false;
  }
  for (const name of res.syncedNames) setDeviceDiscoveryStatus(name, 'approved');
  const extra = res.pending.length ? chalk.gray(` (${res.pending.length} new)`) : '';
  console.log(chalk.green(`Synced ${res.synced} device${res.synced === 1 ? '' : 's'} from Tailscale${extra}.`));
  return true;
}

async function applyAuth(auth: FleetAuthMethod, opts: SetupFleetOptions): Promise<string[]> {
  const reg = await loadDevices();
  const names = Object.keys(reg).sort();
  if (names.length === 0) {
    console.log(chalk.gray("No devices registered yet. Run 'agents setup fleet --yes' after joining Tailscale."));
    return [];
  }
  if (auth === 'password' && !opts.bundle) {
    throw new Error('--bundle is required with --auth password.');
  }
  for (const name of names) {
    const args = ['devices', 'set', name, '--auth', auth];
    if (opts.bundle) args.push('--bundle', opts.bundle);
    if (opts.bundleKey) args.push('--bundle-key', opts.bundleKey);
    runAgentsSubcommand(args);
  }
  return names;
}

function testConnectivity(names: string[]): void {
  if (names.length === 0) return;
  console.log(chalk.bold('\nTesting connectivity:'));
  for (const name of names) {
    const ok = runAgentsSubcommand(['ssh', name, 'uname'], { optional: true });
    console.log(ok ? chalk.green(`  ${name}: ok`) : chalk.yellow(`  ${name}: failed`));
  }
}

function printOnboardingSummary(names: string[], auth: FleetAuthMethod): void {
  console.log(chalk.bold('\nFleet setup summary.'));
  console.log(chalk.gray(`devices: ${names.length ? names.join(', ') : 'none registered'}`));
  console.log(chalk.gray(`auth: ${auth}${auth === 'password' ? ' via secrets bundle' : ''}`));
  console.log(chalk.bold('\nTry:'));
  console.log(chalk.cyan('  agents devices list'));
  console.log(chalk.cyan('  agents ssh <device> uname'));
  console.log(chalk.cyan('  agents fleet run hostname'));
  console.log(chalk.cyan('  agents fleet update'));
}

export async function runFleetSetupWizard(opts: SetupFleetOptions = {}): Promise<boolean> {
  if (!commandExists('tailscale')) {
    printTailscaleInstallInstructions();
    return false;
  }
  if (!tailscaleStatusOk()) {
    console.error(chalk.red('Tailscale is installed but not logged in or the daemon is unavailable.'));
    console.log(chalk.gray('Run `tailscale login` (or `sudo tailscale up` on Linux), then re-run `agents setup fleet`.'));
    return false;
  }

  const choices = await resolveInteractiveChoices(opts);
  const synced = await syncDevices(opts);
  if (!synced) return false;

  const names = await applyAuth(choices.auth, opts);
  if (choices.writeSshConfig) runAgentsSubcommand(['devices', 'render', '--write']);
  if (choices.testConnectivity) testConnectivity(names);
  if (choices.fleetUpdate) runAgentsSubcommand(['fleet', 'update']);

  printOnboardingSummary(names, choices.auth);

  // With a fleet registered, the next wrong-machine trap is artifacts opening on
  // some other box — offer to pin the interactive host (TTY-only, skippable,
  // silent non-TTY and when already set).
  await maybePickInteractiveHost();
  return true;
}

/** Register `agents setup fleet` under the parent `setup` command. */
export function registerSetupFleetCommand(setupCmd: Command): void {
  setupCmd
    .command('fleet')
    .description('Set up `agents fleet` — discover Tailscale devices, choose auth, render SSH config, and test connectivity.')
    .option('--auth <method>', 'device auth method: key or password', 'key')
    .option('--bundle <name>', 'secrets bundle holding the login password when --auth password is used')
    .option('--bundle-key <key>', "key within the secrets bundle (default 'password')")
    .option('--yes', 'non-interactive: register every discovered, non-ignored Tailscale node')
    .option('--write-ssh-config', 'write ~/.ssh/config.d/agents after syncing')
    .option('--test-connectivity', 'run `agents ssh <device> uname` for each registered device')
    .option('--fleet-update', 'run `agents fleet update` after setup')
    .action(async (options: SetupFleetOptions) => {
      try {
        await runFleetSetupWizard(options);
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
