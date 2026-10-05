
import type { Command } from 'commander';
import { withIsolationBoundary } from '../lib/isolation-boundary-report.js';
import { assertIsolationBoundary, createVersionedAlias } from '../lib/installations/shims.js';
import { markVersionIsolated } from '../lib/installations/versions.js';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { confirm } from '@inquirer/prompts';

import { MANAGED_AGENT_IDS } from '../lib/agents.js';
import { AGENTS, getCliPath, getCliVersion, agentLabel, resolveAgentName, isAgentHardDeprecated, hardDeprecationError } from '../lib/agents.js';
import { getVersionDir } from '../lib/installations/versions.js';
import {
  finalizeImport,
  importAgentBinary,
  importAgentConfig,
  importInstallScriptBinary,
  seedIsolatedConfigFromLocal,
  isValidImportVersion,
  resolvePackageDirFromBinary,
} from '../lib/import.js';
import { isPromptCancelled, isInteractiveTerminal } from './utils.js';

interface ImportOptions {
  all?: boolean;
  as?: string;
  isolated?: boolean;
  withAuth?: boolean;
  fromPath?: string;
  yes?: boolean;
}

async function runImport(agentArg: string, opts: ImportOptions): Promise<void> {
  const agentId = resolveAgentName(agentArg);
  if (!agentId) {
    console.error(chalk.red(`Unknown agent: ${agentArg}`));
    console.error(chalk.gray(`Known agents: ${MANAGED_AGENT_IDS.join(', ')}`));
    process.exit(1);
  }
  if (isAgentHardDeprecated(agentId)) {
    console.error(chalk.red(hardDeprecationError(agentId)));
    process.exit(1);
  }
  const agent = AGENTS[agentId];

  if (!opts.isolated) {
    assertIsolationBoundary(agentId, 'adopt your existing install');
  }

  const isInstallScriptAgent = !agent.npmPackage;

  let useDirectBinaryImport = isInstallScriptAgent;

  let globalPath: string | null = null;
  let installScriptBinary: string | null = null;

  if (opts.fromPath) {
    globalPath = path.resolve(opts.fromPath);
    if (!fs.existsSync(globalPath)) {
      console.error(chalk.red(`Path does not exist: ${globalPath}`));
      process.exit(1);
    }
    if (isInstallScriptAgent) {
      if (fs.statSync(globalPath).isDirectory()) {
        const candidate = path.join(globalPath, agent.cliCommand);
        if (!fs.existsSync(candidate)) {
          console.error(chalk.red(`No "${agent.cliCommand}" in ${globalPath}`));
          process.exit(1);
        }
        installScriptBinary = candidate;
      } else {
        installScriptBinary = globalPath;
      }
    }
  } else {
    const binary = await getCliPath(agentId);
    if (!binary) {
      const installHint = isInstallScriptAgent
        ? `Run \`agents add ${agentId}\` to install via the official script, or pass --from-path.`
        : `Install it first (e.g. \`npm i -g ${agent.npmPackage || agent.cliCommand}\`) or pass --from-path.`;
      console.error(chalk.red(`No "${agent.cliCommand}" found on PATH.`));
      console.error(chalk.gray(installHint));
      process.exit(1);
    }
    if (isInstallScriptAgent) {
      installScriptBinary = binary;
    } else {
      globalPath = resolvePackageDirFromBinary(binary);
      if (!globalPath) {
        installScriptBinary = binary;
        useDirectBinaryImport = true;
      }
    }
  }

  if (isInstallScriptAgent && agentId === 'grok' && !opts.fromPath) {
    const detected = await getCliVersion(agentId);
    if (detected) {
      const downloads = path.join(os.homedir(), '.grok', 'downloads');
      try {
        const entries = fs.readdirSync(downloads);
        const exact = entries.find((e) => e.startsWith('grok-') && e.includes(detected));
        if (exact) {
          installScriptBinary = path.join(downloads, exact);
        }
      } catch {
      }
    }
  }

  let version = opts.as;
  if (!version) {
    if (!useDirectBinaryImport && globalPath) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(globalPath, 'package.json'), 'utf8'));
        version = typeof pkg.version === 'string' ? pkg.version : undefined;
      } catch {
      }
    }
    if (!version && (isInstallScriptAgent || !opts.fromPath)) {
      const detected = await getCliVersion(agentId);
      version = detected ?? undefined;
    }
  }

  if (!version) {
    console.error(chalk.red(`Could not determine version for ${agentLabel(agentId)}.`));
    console.error(chalk.gray('Pass --as <version> explicitly.'));
    process.exit(1);
  }
  if (!isValidImportVersion(version)) {
    console.error(chalk.red(`Invalid version: ${version}`));
    console.error(chalk.gray('Version must be "latest" or 1-64 letters, numbers, dots, underscores, plus signs, or hyphens.'));
    process.exit(1);
  }

  const versionDir = getVersionDir(agentId, version);
  const fromLabel = useDirectBinaryImport ? (installScriptBinary as string) : (globalPath as string);

  console.log(chalk.bold(`\nImport ${agentLabel(agentId)} v${version}${opts.isolated ? ' (isolated copy)' : ''}`));
  console.log(`  from: ${chalk.gray(fromLabel)}`);
  console.log(`  into: ${chalk.gray(versionDir)}`);

  const configDirExists = fs.existsSync(agent.configDir);
  let configAlreadyManaged = false;
  if (configDirExists) {
    const stat = fs.lstatSync(agent.configDir);
    if (stat.isSymbolicLink()) {
      configAlreadyManaged = true;
      console.log(`  config: ${chalk.gray(`${agent.configDir} (already managed — will skip)`)}`);
    } else if (opts.isolated) {
      console.log(`  config: ${chalk.gray(`${agent.configDir} (will be COPIED — your original stays put)`)}`);
      if (!opts.withAuth) {
        console.log(`          ${chalk.gray('credentials are skipped; pass --with-auth to include them')}`);
      }
    } else {
      console.log(`  config: ${chalk.gray(`${agent.configDir} (will be moved into version home)`)}`);
    }
  } else {
    console.log(`  config: ${chalk.gray(`${agent.configDir} (does not exist — will skip)`)}`);
  }

  if (!opts.yes && isInteractiveTerminal()) {
    console.log();
    const proceed = await confirm({
      message: opts.isolated
        ? `Import ${agentLabel(agentId)} v${version} as an isolated copy?`
        : `Import ${agentLabel(agentId)} v${version} into agents-cli?`,
      default: true,
    }).catch((err) => {
      if (isPromptCancelled(err)) return false;
      throw err;
    });
    if (!proceed) {
      console.log(chalk.gray('Aborted.'));
      return;
    }
  }

  const willImportConfig = configDirExists && !configAlreadyManaged && !opts.isolated;
  if (opts.isolated && configDirExists && configAlreadyManaged) {
    console.log(chalk.gray(`  Skipping config copy: ${agent.configDir} is a managed symlink, not your real settings.`));
  } else if (opts.isolated && configDirExists) {
    const seedSpinner = ora(`Copying ${agent.configDir} into the isolated copy...`).start();
    const seed = seedIsolatedConfigFromLocal(agentId, version, { withAuth: opts.withAuth, all: opts.all });
    if (seed.error) {
      seedSpinner.fail(`Config: ${seed.error}`);
      process.exit(1);
    } else if (seed.seeded) {
      seedSpinner.succeed(`Settings copied (${seed.from} -> ${seed.to}); your original is untouched`);
      if (seed.skippedRuntime.length > 0) {
        console.log(chalk.gray(`  Runtime state NOT copied: ${seed.skippedRuntime.join(', ')} (regenerated as you use it; --all to include)`));
      }
      if (seed.skippedAuth.length > 0) {
        console.log(chalk.gray(`  Credentials NOT copied: ${seed.skippedAuth.join(', ')}`));
        console.log(chalk.gray('  The copy signs in separately. Use --with-auth to copy them too.'));
      }
    } else {
      seedSpinner.info('No existing config to copy.');
    }
  }
  if (willImportConfig) {
    const cfgSpinner = ora(`Importing config dir for ${agentLabel(agentId)} v${version}...`).start();
    const cfgResult = await importAgentConfig(agentId, version);
    if (cfgResult.success) {
      const relConfig = path.relative(os.homedir(), agent.configDir);
      cfgSpinner.succeed(`Config imported (${agent.configDir} -> ${versionDir}/home/${relConfig})`);
    } else if (cfgResult.skipped) {
      cfgSpinner.warn(`Config: ${cfgResult.error}`);
    } else {
      cfgSpinner.fail(`Config: ${cfgResult.error}`);
      process.exit(1);
    }
  }

  const binSpinner = ora(`Registering ${agentLabel(agentId)} v${version} binary...`).start();
  const binResult = useDirectBinaryImport
    ? importInstallScriptBinary(
        { agentId, npmPackage: agent.npmPackage, cliCommand: agent.cliCommand },
        version,
        installScriptBinary as string,
        versionDir
      )
    : importAgentBinary(
        { agentId, npmPackage: agent.npmPackage, cliCommand: agent.cliCommand },
        version,
        globalPath as string,
        versionDir
      );
  if (binResult.success) {
    binSpinner.succeed(`Binary registered (${agent.cliCommand} -> ${binResult.resolvedFromPath})`);
  } else if (binResult.skipped) {
    binSpinner.warn(`Binary: ${binResult.error}`);
  } else {
    binSpinner.fail(`Binary: ${binResult.error}`);
    process.exit(1);
  }

  if (opts.isolated) {
    createVersionedAlias(agentId, version);
    markVersionIsolated(agentId, version);
    console.log();
    console.log(chalk.green(`${agentLabel(agentId)} v${version} imported as an isolated copy.`));
    console.log(chalk.gray(`  Your ${agent.configDir} and ${agent.cliCommand} launcher are untouched.`));
    console.log(chalk.gray(`  Run it:  agents run ${agentId}@${version}`));
    console.log(chalk.gray(`  Or make it the default isolated copy:  agents use ${agentId}@${version}`));
    return;
  }

  const finalizeSpinner = ora(`Wiring ${agentLabel(agentId)} v${version} as the active version...`).start();
  try {
    finalizeImport(agentId, version);
    finalizeSpinner.succeed(`${agentLabel(agentId)} v${version} set as default with shim + alias`);
  } catch (err) {
    finalizeSpinner.fail(`Finalize: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log();
  console.log(chalk.green(`${agentLabel(agentId)} v${version} is now managed.`));
  console.log(chalk.gray(`Verify: agents view ${agentId}`));
}

export function registerImportCommand(program: Command): void {
  program
    .command('import')
    .argument('<agent>', 'Agent id (e.g. openclaw, claude, codex)')
    .description('Import an existing unmanaged agent install into agents-cli')
    .option('--as <version>', 'Version label to import as (otherwise read from package.json)')
    .option('--from-path <path>', 'Path to the npm package dir (otherwise auto-detected from PATH)')
    .option('--isolated', 'Copy the install into a self-contained isolated version instead of adopting it')
    .option('--with-auth', 'With --isolated, also copy credentials into the sandbox (skipped by default)')
    .option('--all', 'With --isolated, also copy session history, logs and caches (skipped by default)')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .addHelpText('after', `
Examples:
  $ agents import openclaw                          Auto-detect via PATH
  $ agents import openclaw --as 2026.3.8            Pin a version label
  $ agents import openclaw --from-path /opt/homebrew/lib/node_modules/openclaw

  # installScript-based agents (curl/brew installers, no npm package):
  $ agents import grok                              Adopt ~/.grok/downloads/grok-<ver>
  $ agents import antigravity                       Adopt ~/.local/bin/agy
  $ agents import cursor                            Adopt ~/.local/bin/cursor-agent
  $ agents import antigravity --from-path ~/.local/bin/agy

  # Copy your setup into a sandbox instead of adopting it:
  $ agents import codex --isolated                  New isolated copy at the local version
  $ agents import codex --isolated --as 0.146.0     Re-seed an EXISTING isolated copy
  $ agents import codex --isolated --with-auth      ...and share credentials with it

When to use:
  When an agent CLI is already installed globally and you want to bring it
  under agents-cli management without reinstalling. Creates a symlink farm
  pointing at the existing install — nothing is copied or moved (except the
  agent's config dir, which is moved into the version's home). Works for both
  npm-style packages (claude, codex, opencode, openclaw) and
  installScript-based agents (grok, antigravity, cursor, goose).
`)
    .action((...args: Parameters<typeof runImport>) =>
      withIsolationBoundary(() => runImport(...args)));
}
