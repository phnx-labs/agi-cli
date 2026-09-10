/**
 * `agents setup secrets` — install the standalone `secrets` CLI if missing,
 * then hand off to its own `secrets migrate` onboarding (PHNX-3989).
 *
 * Prefers a declared host-CLI manifest (`agents clis install secrets`); otherwise
 * installs the pinned `@phnx-labs/secrets-cli`. Never rebundles the engine
 * (DIST-1) and never writes a `secrets` alias shim (agi-cli#3532).
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'node:child_process';
import { getHistoryDir } from '../lib/state.js';
import { resolveSecretsBin, invocation, SecretsClientError } from '../lib/secrets-client.js';
import { SECRETS_CLI_INSTALL_HINT, SECRETS_CLI_SPEC, isSecretsPresent } from '../lib/secrets-cli.js';
import { installSecretsCli } from '../lib/secrets-cli-install.js';

export function setupSecretsPrefsPath(): string {
  return path.join(getHistoryDir(), 'setup', 'secrets.json');
}

/** True when the standalone `secrets` executable resolves ($SECRETS_BIN or PATH). */
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

/**
 * Install the standalone if missing, then hand off to its interactive
 * `secrets migrate`. Returns whether setup is now complete (installed, and —
 * when it ran — `migrate` exited 0).
 */
export async function runSecretsSetupWizard(): Promise<boolean> {
  if (!isSecretsCliInstalled()) {
    console.log(chalk.yellow('The standalone `secrets` CLI is not installed.'));
    const result = installSecretsCli({ cwd: process.cwd() });
    if (!result.ok) {
      console.error(chalk.red(result.error ?? 'Install failed.'));
      console.error(chalk.gray('Install it, then re-run `agents setup secrets`:'));
      console.error(chalk.cyan(`  ${SECRETS_CLI_INSTALL_HINT}`));
      return false;
    }
    const via = result.method === 'clis' ? 'declared host CLI manifest' : SECRETS_CLI_SPEC;
    console.log(chalk.green(`Installed ${via}.`));
  }
  if (!isSecretsPresent()) {
    console.error(chalk.red('The standalone `secrets` CLI is still missing after install.'));
    console.error(chalk.cyan(`  ${SECRETS_CLI_INSTALL_HINT}`));
    return false;
  }
  const bin = resolveSecretsBin();
  const { command, prefix } = invocation(bin);
  const res = spawnSync(command, [...prefix, 'migrate'], { stdio: 'inherit' });
  const ok = (res.status ?? 1) === 0;
  if (ok) recordSetupComplete();
  return ok;
}

/** Register `agents setup secrets` under the parent `setup` command. */
export function registerSetupSecretsCommand(setupCmd: Command): void {
  setupCmd
    .command('secrets')
    .description('Install the standalone `secrets` CLI if missing, then run its own `secrets migrate` onboarding.')
    .action(async () => {
      if (!(await runSecretsSetupWizard())) process.exitCode = 1;
    });
}
