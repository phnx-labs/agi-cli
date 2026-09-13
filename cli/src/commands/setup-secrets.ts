/**
 * `agents setup secrets` — install the standalone `secrets` CLI if missing,
 * then hand off to its own `secrets migrate` onboarding (PHNX-3989).
 *
 * The engine lives in `@phnx-labs/secrets-cli`. agents-cli never rebundles it
 * (DIST-1). A missing binary is a routine install, not a fatal gap: try
 * `agents clis install secrets` (system `clis/secrets.yaml`) then a pinned
 * `npm i -g`. Users do not set extra env vars.
 */

import type { Command } from 'commander';
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

// Re-exported for back-compat; the canonical pin lives in `secrets-cli.ts` so a
// version bump touches ONE place (PHNX-3989 consolidation).
export const SECRETS_CLI_PACKAGE = SECRETS_CLI_SPEC;
export const INSTALL_HINT = `agents clis install secrets   # or: npm i -g ${SECRETS_CLI_PACKAGE}`;

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
 * Install the published secrets CLI. Prefers the host-CLI manifest
 * (`clis/secrets.yaml` in the system repo) so doctor/clis stay one path.
 * Falls back to a pinned npm global install. Returns whether `secrets` is
 * on PATH afterwards. Never writes an `agents secrets` shim.
 */
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

/**
 * Install the standalone if missing, then hand off to `secrets migrate`.
 * Returns whether setup is now complete (installed, and migrate exited 0
 * when it ran).
 */
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

/** Register `agents setup secrets` under the parent `setup` command. */
export function registerSetupSecretsCommand(setupCmd: Command): void {
  setupCmd
    .command('secrets')
    .description('Install the standalone `secrets` CLI if missing, then run its `secrets migrate` onboarding.')
    .option('--install-only', 'Install the standalone Secrets CLI without migrating or unlocking secrets')
    .action(async (options: { installOnly?: boolean }) => {
      if (!(options.installOnly ? installSecretsCli() : await runSecretsSetupWizard())) process.exitCode = 1;
      await refreshToolSetup('secrets');
    });
}
