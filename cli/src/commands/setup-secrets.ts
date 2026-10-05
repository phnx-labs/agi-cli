
import type { Command } from 'commander';
import { openSetupTerminal } from './setup-terminal.js';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'node:child_process';
import { getHistoryDir } from '../lib/state.js';
import { resolveSecretsBin, invocation, SecretsClientError, _resetSecretsClientForTest } from '../lib/secrets-client.js';
import { installCli, resolveCliManifest } from '../lib/cli-resources.js';
import { SECRETS_CLI_SPEC } from '../lib/secrets-cli.js';
import { refreshToolSetup } from '../lib/setup-tool-status.js';
import { execFileShellSpec } from '../lib/platform/exec.js';

export const SECRETS_CLI_PACKAGE = SECRETS_CLI_SPEC;
export const INSTALL_HINT = `agents clis install secrets   # or: npm i -g ${SECRETS_CLI_PACKAGE}`;

export function setupSecretsPrefsPath(): string {
  return path.join(getHistoryDir(), 'setup', 'secrets.json');
}

export function isSecretsCliInstalled(): boolean {
  try {
    resolveSecretsBin();
    return true;
  } catch (err) {
    if (err instanceof SecretsClientError && err.code === 'SECRETS_BIN_MISSING') return false;
    throw err;
  }
}

function recordSetupComplete(): void {
  const file = setupSecretsPrefsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
}

export function installSecretsCli(): boolean {
  if (isSecretsCliInstalled()) return true;
  const manifest = resolveCliManifest('secrets');
  if (manifest) {
    console.log(chalk.gray(`Installing ${manifest.name} via agents clis…`));
    const result = installCli(manifest);
    _resetSecretsClientForTest();
    if (result.installed) return true;
    if (result.error) console.error(chalk.gray(result.error));
  }
  console.log(chalk.gray(`Installing ${SECRETS_CLI_PACKAGE}…`));
  const npm = execFileShellSpec('npm', ['install', '-g', SECRETS_CLI_PACKAGE]);
  const r = spawnSync(npm.command, npm.args, { stdio: 'inherit', shell: npm.shell });
  _resetSecretsClientForTest();
  if (r.error) {
    console.error(chalk.red(`npm install failed: ${r.error.message}`));
    return false;
  }
  if ((r.status ?? 1) !== 0) return false;
  return isSecretsCliInstalled();
}

export async function runSecretsSetupWizard(): Promise<boolean> {
  if (!isSecretsCliInstalled()) {
    if (!installSecretsCli()) {
      console.log(chalk.yellow('The standalone `secrets` CLI is not installed.'));
      console.log(chalk.gray('Install it, then re-run `agents setup secrets`:'));
      console.log(chalk.cyan(`  ${INSTALL_HINT}`));
      return false;
    }
  }
  const bin = resolveSecretsBin();
  const { command, prefix } = invocation(bin);
  const res = spawnSync(command, [...prefix, 'migrate'], { stdio: 'inherit' });
  const ok = (res.status ?? 1) === 0;
  if (ok) recordSetupComplete();
  return ok;
}

export function registerSetupSecretsCommand(setupCmd: Command): void {
  setupCmd
    .command('secrets')
    .description('Install the standalone `secrets` CLI if missing, then run its `secrets migrate` onboarding.')
    .option('--install-only', 'Install the standalone Secrets CLI without migrating or unlocking secrets')
    .option('--terminal [backend]', 'Open interactive setup in a detected or selected terminal')
    .action(async (options: { installOnly?: boolean; terminal?: boolean | string }) => {
      if (options.terminal !== undefined) {
        try { await openSetupTerminal('secrets', options.terminal, options.installOnly); }
        catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
        return;
      }
      if (!(options.installOnly ? installSecretsCli() : await runSecretsSetupWizard())) process.exitCode = 1;
      await refreshToolSetup('secrets');
    });
}
