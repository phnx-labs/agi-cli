/**
 * First-run setup command.
 *
 * Registers the `agents setup` command which clones the system repo into
 * ~/.agents/.system/ and installs agent CLIs with resource syncing.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { confirm } from '@inquirer/prompts';
import type { AgentId } from '../lib/types.js';
import { DEFAULT_SYSTEM_REPO, systemRepoSlug } from '../lib/types.js';
import { getAgentsDir, getVersionsDir, ensureAgentsDir } from '../lib/state.js';
import { isGitRepo, cloneIntoExisting, pullRepo } from '../lib/git.js';
import { isPromptCancelled, isInteractiveTerminal } from './utils.js';
import { AGENTS, agentConfigDirName, getUnmanagedAgentInstalls, countSessionFiles, agentLabel } from '../lib/agents.js';
import { setGlobalDefault } from '../lib/installations/versions.js';
import { ensureShimCurrent, switchHomeFileSymlinks, isShimsInPath, addShimsToPath, getPathSetupInstructions, assertIsolationBoundary } from '../lib/installations/shims.js';
import { setHelpSections } from '../lib/help.js';
import { registerSetupBrowserCommand, runBrowserWizard } from './setup-browser.js';
import { registerSetupComputerCommand, runComputerWizard } from './setup-computer.js';
import { runShareWizard } from './artifacts-setup.js';
import { registerSetupMineCommand } from './setup-mine.js';
import { registerSetupSecretsCommand } from './setup-secrets.js';
import { registerSetupFleetCommand } from './setup-fleet.js';
import { registerSetupAccountsCommand, runAccountsSetupWizard } from './setup-accounts.js';
import { registerSetupWatchdogCommand, runWatchdogSetupWizard } from './setup-watchdog.js';
import { hasMintedSetupToken } from '../lib/auth-mint.js';
import { registerAliasCommand } from './alias.js';
import { registerBetaCommands } from './beta.js';
import { addUrlSchemeSubcommands } from './open.js';
import { runPreferencesStep } from './setup-preferences.js';
import { getConfiguredDefaultProfileName, getProfile, getAutoDetectedProfile, isProfileLaunchableHere } from '../lib/browser/profiles.js';
import { listInstalledBrowsers } from '../lib/browser/chrome.js';
import { probeComputerTrust } from './computer.js';
import { readShareConfig } from '../lib/share/config.js';
import { loadDevices } from '../lib/devices/registry.js';
import { getConfigValue } from '../lib/device-config.js';
import { setupSecretsPrefsPath } from './setup-secrets.js';

const HOME = os.homedir();

/**
 * Import an existing unmanaged agent installation into agents-cli.
 * Moves the config dir into the versions structure and creates a symlink.
 */
async function importAgent(agentId: AgentId, version: string): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  const agent = AGENTS[agentId];
  // setup has its own hand-rolled adoption (rename + symlink inline, rather than
  // calling switchConfigSymlink), so the primitive gates never see it. Check the
  // boundary here, before the first mkdirSync — which would otherwise create the
  // scaffolding this very check reads.
  assertIsolationBoundary(agentId, 'adopt your existing install');
  const configDir = agent.configDir;
  const versionsDir = getVersionsDir();
  const versionHome = path.join(versionsDir, agentId, version, 'home');
  const versionConfigDir = path.join(versionHome, agentConfigDirName(agentId));

  // Skip if version dir already exists (collision)
  if (fs.existsSync(versionConfigDir)) {
    return { success: false, skipped: true, error: `${version} already installed` };
  }

  try {
    // Create version home directory
    fs.mkdirSync(versionHome, { recursive: true });

    // Move existing config dir into version home
    fs.renameSync(configDir, versionConfigDir);

    // Create symlink from original location to version config
    fs.symlinkSync(versionConfigDir, configDir);

    // Set as global default
    setGlobalDefault(agentId, version);

    // Handle home-level files (e.g. ~/.claude.json)
    switchHomeFileSymlinks(agentId, version);

    // Ensure shim exists
    ensureShimCurrent(agentId);

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

interface RunSetupOptions {
  force?: boolean;
  suppressFooter?: boolean;
  systemRepo?: boolean;
  runHub?: () => Promise<void>;
  startDaemonFn?: () => { pid: number | null; method: string };
  isDaemonEnabledFn?: () => boolean;
}

/** First-run setup. Clones ~/.agents/.system/ from the system repo if needed. */
export async function runSetup(program: Command, options: RunSetupOptions = {}): Promise<void> {
  const agentsDir = getAgentsDir();
  const alreadyConfigured = isGitRepo(agentsDir);

  if (alreadyConfigured && !options.force) {
    if (options.suppressFooter) return;
    await (options.runHub ?? runSetupHub)();
    return;
  }

  // Detect existing installations BEFORE cloning (they won't exist after if we import)
  const unmanaged = await getUnmanagedAgentInstalls();
  const sessionCounts: Partial<Record<AgentId, number>> = {};
  for (const install of unmanaged) {
    sessionCounts[install.agentId] = countSessionFiles(install.agentId);
  }

  const systemRepo = process.env.AGENTS_SYSTEM_REPO || DEFAULT_SYSTEM_REPO;

  console.log(chalk.bold('\nWelcome to agents-cli.'));

  if (options.systemRepo === false) {
    ensureAgentsDir();
    console.log(chalk.gray('Skipping system repo clone (--no-system-repo).'));
    console.log(chalk.gray(`Populate ~/.agents/.system/ yourself before running other commands that depend on it.\n`));
  } else {
    console.log(
      chalk.gray(
        alreadyConfigured
          ? `Updating the system repo from ${systemRepoSlug(systemRepo)} in ~/.agents/.system/.\n`
          : `Cloning the system repo from ${systemRepoSlug(systemRepo)} into ~/.agents/.system/.\n`,
      ),
    );

    ensureAgentsDir();

    const spinner = ora(alreadyConfigured ? 'Updating system repo...' : 'Cloning system repo...').start();

    if (isGitRepo(agentsDir)) {
      // --force on an existing repo: pull instead of re-clone
      const result = await pullRepo(agentsDir);
      if (!result.success) {
        spinner.fail(`Pull failed: ${result.error}`);
        console.log(chalk.gray('Fix the issue and re-run: agents setup --force'));
        process.exit(1);
      }
      spinner.succeed(`Updated to ${result.commit}`);
    } else {
      // Check git is available
      try {
        const { execSync } = await import('child_process');
        execSync('git --version', { stdio: 'ignore' });
      } catch {
        spinner.fail('git is not installed');
        console.log(chalk.gray('Install git first: https://git-scm.com/downloads'));
        process.exit(1);
      }

      const result = await cloneIntoExisting(systemRepo, agentsDir);
      if (!result.success) {
        spinner.fail(`Clone failed: ${result.error}`);
        console.log(chalk.gray('Fix the issue and re-run: agents setup --force'));
        process.exit(1);
      }
      spinner.succeed(`Cloned ${systemRepoSlug(systemRepo)} (${result.commit})`);
    }
  }

  try {
    const enabled = options.isDaemonEnabledFn
      ? options.isDaemonEnabledFn()
      : (await import('../lib/device-config.js')).isDaemonEnabled();
    if (enabled) {
      const start = options.startDaemonFn
        ?? (await import('../lib/daemon/daemon.js')).startDaemon;
      const started = start();
      if (started.method !== 'already-running' && started.pid) {
        console.log(chalk.gray(`Started the always-on agents daemon (pid ${started.pid}).`));
      }
    }
  } catch { /* best effort */ }

  // Populate the device registry from the tailnet on first setup. Soft mode is
  // guaranteed non-throwing (no tailscale / corrupt file / lock contention all
  // resolve to ok:false), so this can never block setup.
  const { runDeviceSync } = await import('../lib/devices/sync.js');
  const dev = await runDeviceSync({ soft: true });
  if (dev.ok) {
    const { setDeviceDiscoveryStatus } = await import('../lib/devices/discovery-policy.js');
    for (const name of dev.syncedNames) setDeviceDiscoveryStatus(name, 'approved');
  }
  if (dev.ok && dev.synced > 0) {
    console.log(chalk.gray(`Discovered ${dev.synced} device${dev.synced === 1 ? '' : 's'} on your tailnet (agents devices list).`));
  }

  // Offer to import existing unmanaged installations
  if (unmanaged.length > 0 && isInteractiveTerminal()) {
    console.log(chalk.bold('\nFound existing installations:\n'));

    const maxAgentLen = Math.max(...unmanaged.map(i => agentLabel(i.agentId).length));
    for (const install of unmanaged) {
      const label = agentLabel(install.agentId).padEnd(maxAgentLen);
      const sessions = sessionCounts[install.agentId] || 0;
      const sessionStr = sessions > 0 ? `${sessions} sessions` : 'no sessions';
      const versionStr = install.version ? `v${install.version}` : '';
      console.log(`  ${chalk.cyan(label)}  ${install.configDir}  ${chalk.gray(sessionStr)}  ${chalk.gray(versionStr)}`);
    }

    console.log();
    const shouldImport = await confirm({
      message: 'Import these under agents-cli management?',
      default: true,
    });

    if (shouldImport) {
      console.log();
      for (const install of unmanaged) {
        const version = install.version || 'unknown';
        const spinner = ora(`Importing ${agentLabel(install.agentId)} v${version}...`).start();

        const result = await importAgent(install.agentId, version);
        if (result.success) {
          spinner.succeed(`${agentLabel(install.agentId)} imported`);
        } else if (result.skipped) {
          spinner.warn(`${agentLabel(install.agentId)}: ${result.error} (skipped)`);
        } else {
          spinner.fail(`${agentLabel(install.agentId)}: ${result.error}`);
        }
      }

      // Ensure shims are in PATH
      if (!isShimsInPath()) {
        const pathResult = addShimsToPath();
        if (pathResult.success && !pathResult.alreadyPresent) {
          console.log(chalk.green(`\nAdded shims to ${pathResult.location}`));
          console.log(chalk.gray(pathResult.reloadHint));
        } else if (!pathResult.success) {
          console.log(chalk.yellow('\nTo enable version switching, add shims to PATH:'));
          console.log(chalk.gray(getPathSetupInstructions()));
        }
      }

      // Show total session count
      const totalSessions = Object.values(sessionCounts).reduce((a, b) => a + (b || 0), 0);
      if (totalSessions > 0) {
        const breakdown = unmanaged
          .filter(i => (sessionCounts[i.agentId] || 0) > 0)
          .map(i => `${agentLabel(i.agentId)} (${sessionCounts[i.agentId] || 0})`)
          .join(', ');
        console.log(chalk.gray(`\n${totalSessions} sessions available across ${breakdown}`));
        console.log(chalk.cyan('  agents sessions') + chalk.gray('  # browse them'));
      }
    }
  }

  // Register the agents:// URL scheme so deep links in rendered artifacts can
  // resume a session (RUSH — session deep links). Best-effort and idempotent:
  // never fails setup, only registers when missing.
  try {
    const { registerAgentsUrlScheme } = await import('../lib/deeplink/register.js');
    const scheme = registerAgentsUrlScheme({ ifMissing: true });
    if (scheme.registered) console.log(chalk.gray('Registered the agents:// URL scheme (artifact session deep links).'));
  } catch {
    // non-fatal — the user can run `agents setup url-scheme register` later.
  }

  if (options.suppressFooter) return;

  // Fresh-machine hub: offer to set up the optional capabilities that need their
  // own guided flow. TTY-only and fully opt-in — a non-interactive `agents setup`
  // stops at the system-repo bootstrap above, unchanged.
  await (options.runHub ?? runSetupHub)();

  console.log(chalk.bold('\nSetup complete. Try:'));
  console.log(chalk.cyan('  agents view                 ') + chalk.gray(' # see what\'s installed'));
  console.log(chalk.cyan('  agents run <agent> "hello"  ') + chalk.gray(' # run an agent'));
  console.log(chalk.gray('\nWhen you want your own editable repo, scaffold one with:'));
  console.log(chalk.cyan('  agents repo init'));
}

/**
 * Ensure the system repo exists before running a command that needs it.
 * If ~/.agents/.system/ is not a git repo AND we're in an interactive TTY,
 * prompt the user to run setup now. In non-interactive mode, print a clear
 * error and exit.
 */
export async function ensureInitialized(program: Command): Promise<void> {
  const agentsDir = getAgentsDir();
  if (isGitRepo(agentsDir)) return;

  if (!isInteractiveTerminal()) {
    console.error(chalk.red('agents-cli is not set up. Run: agents setup'));
    process.exit(1);
  }

  console.log(chalk.yellow('\nagents-cli has not been set up yet.'));
  const proceed = await confirm({
    message: 'Run `agents setup` now?',
    default: true,
  }).catch(() => false);

  if (!proceed) {
    console.log(chalk.gray('Skipped. Run `agents setup` when ready.'));
    process.exit(0);
  }

  await runSetup(program, { suppressFooter: true });
}

/**
 * Interactive "what else do you want to set up?" menu shown after the bare
 * `agents setup` finishes on a TTY. Each pick runs that capability's guided
 * wizard. Never throws — a cancel or an optional wizard's error just skips the
 * rest and lets core setup complete.
 */
type SetupPhase = 'browser' | 'computer' | 'share' | 'secrets' | 'accounts' | 'fleet' | 'watchdog' | 'preferences';
type SetupStatusState = 'ready' | 'missing' | 'n/a';
interface SetupStatusRow {
  phase: 'core' | SetupPhase;
  state: SetupStatusState;
  detail: string;
}

export async function getSetupStatus(): Promise<SetupStatusRow[]> {
  const configuredBrowserProfile = getConfiguredDefaultProfileName();
  const browserProfile = configuredBrowserProfile
    ? await getProfile(configuredBrowserProfile)
    : await getAutoDetectedProfile();
  const browserReady = browserProfile !== null && isProfileLaunchableHere(browserProfile);
  const installedBrowsers = listInstalledBrowsers();
  const computerState = process.platform === 'darwin' ? (await probeComputerTrust() ? 'ready' : 'missing') : 'n/a';
  const devices = await loadDevices();
  const coreReady = isGitRepo(getAgentsDir());
  const secretsReady = fs.existsSync(setupSecretsPrefsPath());
  const minted = hasMintedSetupToken();
  const shareConfig = readShareConfig();
  const watchdogEnabled = getConfigValue('watchdog.enabled').value === true;
  const interactiveHost = getConfigValue('interactive.host').value;
  const defaultBrowser = getConfigValue('browser.profile').value;
  return [
    { phase: 'core', state: coreReady ? 'ready' : 'missing', detail: coreReady ? 'system repo ready' : 'system repo missing' },
    { phase: 'browser', state: browserReady ? 'ready' : 'missing', detail: browserReady ? `profile ${browserProfile.name}` : browserProfile ? `profile ${browserProfile.name} cannot launch here` : installedBrowsers.length ? 'no default profile' : 'no supported browser found' },
    { phase: 'computer', state: computerState, detail: computerState === 'ready' ? 'helper trusted' : computerState === 'n/a' ? 'macOS local setup only' : 'helper not running or not trusted' },
    { phase: 'secrets', state: secretsReady ? 'ready' : 'missing', detail: secretsReady ? 'defaults chosen' : 'defaults not chosen' },
    { phase: 'accounts', state: minted.ready ? 'ready' : 'missing', detail: minted.detail },
    { phase: 'fleet', state: Object.keys(devices).length ? 'ready' : 'missing', detail: Object.keys(devices).length ? `${Object.keys(devices).length} device${Object.keys(devices).length === 1 ? '' : 's'} registered` : 'no devices registered' },
    { phase: 'share', state: shareConfig ? 'ready' : 'missing', detail: shareConfig?.baseUrl ?? 'endpoint not configured' },
    { phase: 'watchdog', state: watchdogEnabled ? 'ready' : 'missing', detail: watchdogEnabled ? 'enabled on this device' : 'disabled on this device' },
    { phase: 'preferences', state: interactiveHost || defaultBrowser ? 'ready' : 'missing', detail: [interactiveHost && `host ${interactiveHost}`, defaultBrowser && `browser ${defaultBrowser}`].filter(Boolean).join(' · ') || 'interactive host and browser unset' },
  ];
}

function renderSetupStatus(rows: SetupStatusRow[]): void {
  console.log(chalk.bold('\nagents setup — onboarding\n'));
  for (const row of rows) {
    const marker = row.state === 'ready' ? chalk.green('[x]') : row.state === 'n/a' ? chalk.gray('[-]') : chalk.yellow('[ ]');
    const label = row.phase[0].toUpperCase() + row.phase.slice(1);
    console.log(`  ${marker} ${label.padEnd(12)} ${chalk.gray(row.detail)}`);
  }
}

async function runSetupPhase(phase: SetupPhase): Promise<void> {
  if (phase === 'browser') await runBrowserWizard();
  else if (phase === 'computer') await runComputerWizard();
  else if (phase === 'share') await runShareWizard();
  else if (phase === 'secrets') await import('./setup-secrets.js').then((m) => m.runSecretsSetupWizard());
  else if (phase === 'accounts') await runAccountsSetupWizard();
  else if (phase === 'fleet') await import('./setup-fleet.js').then((m) => m.runFleetSetupWizard());
  else if (phase === 'watchdog') await runWatchdogSetupWizard();
  else await runPreferencesStep();
}

export async function runSetupHub(deps: {
  interactive?: boolean;
  selectPhase?: (rows: SetupStatusRow[]) => Promise<SetupPhase | 'exit'>;
  runPhase?: (phase: SetupPhase) => Promise<void>;
} = {}): Promise<void> {
  const interactive = deps.interactive ?? isInteractiveTerminal();
  if (!interactive) {
    const rows = await getSetupStatus();
    renderSetupStatus(rows);
    if (rows.some((row) => row.state === 'missing')) process.exitCode = 1;
    return;
  }
  try {
    while (true) {
      const rows = await getSetupStatus();
      renderSetupStatus(rows);
      let pick: SetupPhase | 'exit';
      if (deps.selectPhase) {
        pick = await deps.selectPhase(rows);
      } else {
        const { select } = await import('@inquirer/prompts');
        pick = await select<SetupPhase | 'exit'>({
          message: 'Choose a phase to configure',
          choices: [
            ...rows.filter((row): row is SetupStatusRow & { phase: SetupPhase } => row.phase !== 'core' && row.state !== 'n/a').map((row) => ({
              name: `${row.state === 'ready' ? '[x]' : '[ ]'} ${row.phase.padEnd(12)} ${row.detail}`,
              value: row.phase,
            })),
            { name: 'Exit setup', value: 'exit' as const },
          ],
        });
      }
      if (pick === 'exit') return;
      console.log();
      await (deps.runPhase ?? runSetupPhase)(pick);
    }
  } catch (err) {
    if (isPromptCancelled(err)) return;
    console.log(chalk.yellow(`Optional setup skipped: ${(err as Error).message}`));
  }
}

/** Register the `agents setup` command and its capability subcommands. */
export function registerSetupCommand(program: Command): void {
  const setupCmd = program
    .command('setup')
    .description('Set up agents-cli, or re-open the capability onboarding hub.')
    .option('-f, --force', 'Re-run setup even if ~/.agents/.system/ already exists (use with caution)')
    .option('--no-system-repo', 'Skip cloning the system repo (you must populate ~/.agents/.system/ yourself)');

  // Capability subcommands: `agents setup browser|computer|mine|secrets|accounts|fleet|alias|beta`.
  // Share/artifact publishing is set up by `agents artifacts setup` (RUSH-2580);
  // the hub below still offers it as a phase via runShareWizard.
  registerSetupBrowserCommand(setupCmd);
  registerSetupComputerCommand(setupCmd);
  registerSetupMineCommand(setupCmd);
  registerSetupSecretsCommand(setupCmd);
  registerSetupAccountsCommand(setupCmd);
  registerSetupFleetCommand(setupCmd);
  registerSetupWatchdogCommand(setupCmd);
  registerAliasCommand(setupCmd);
  registerBetaCommands(setupCmd);

  // `agents setup url-scheme register|unregister|status` — the canonical, visible
  // home for the agents:// OS handler that routes artifact deep links to the
  // machine-only `agents _callback` verb. Reuses the same builder the hidden
  // `agents open` back-compat subcommands mount.
  const urlScheme = setupCmd
    .command('url-scheme')
    .description('Register/unregister/status the agents:// OS URL-scheme handler for artifact session deep links.');
  addUrlSchemeSubcommands(urlScheme, { hidden: false });
  setHelpSections(urlScheme, {
    examples: `
      # Register the handler so agents:// links in rendered artifacts resume sessions
      agents setup url-scheme register

      # Check whether the handler is registered on this machine
      agents setup url-scheme status

      # Remove the handler
      agents setup url-scheme unregister
    `,
  });

  setupCmd.command('status')
    .description('Show setup readiness for core, browser, computer, secrets, accounts, fleet, share, watchdog, and preferences.')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      const rows = await getSetupStatus();
      if (options.json) console.log(JSON.stringify(rows, null, 2));
      else renderSetupStatus(rows);
      if (rows.some((row) => row.state === 'missing')) process.exitCode = 1;
    });

  setHelpSections(setupCmd, {
    examples: `
      # First-time setup (clones the system repo into ~/.agents/.system/)
      agents setup

      # Re-run after corruption or to repair ~/.agents/.system/
      agents setup --force

      # Set up a specific capability on its own
      agents setup browser
      agents setup computer
      agents setup secrets
      agents setup accounts
      agents setup fleet
      agents setup watchdog
      agents setup alias add teams
      agents setup beta enable factory
    `,
    notes: `
      What it does:
        1. Clones the system repo into ~/.agents/.system/
        2. Imports any unmanaged agent installations it finds
        3. Opens a re-runnable capability menu with live ready/missing status
        4. Delegates each selection to its existing setup wizard

      Capability setup can also be run any time on its own:
        agents setup browser    # detect a browser + create the default profile
        agents setup computer    # install the signed macOS helper + grant permissions
        agents artifacts setup   # provision or join a Cloudflare share endpoint
        agents setup secrets     # choose secrets backend/policy defaults + import
        agents setup accounts    # mint a Claude setup-token for unattended usage/probe
        agents setup fleet       # discover Tailscale devices + configure SSH access
        agents setup watchdog    # choose which devices run the daemon watchdog pass
        agents setup alias add teams  # PATH shorthand: teams runs agents teams
        agents setup beta enable factory  # opt into preview features

      To install CLIs from agents.yaml and sync resources into version homes:
        agents sync --local -y
    `,
  });

  setupCmd.action(async (options) => {
      try {
        await runSetup(program, options);
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.yellow('\nCancelled'));
          return;
        }
        throw err;
      }
    });
}
