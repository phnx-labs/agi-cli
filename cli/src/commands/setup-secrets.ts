
import type { Command } from 'commander';
import { openSetupTerminal } from './setup-terminal.js';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'node:child_process';
import { getHistoryDir } from '../lib/state.js';
import { resolveSecretsBin, invocation, _resetSecretsClientForTest } from '../lib/secrets-client.js';
import { ensureToolPins } from '../lib/standalone-tools.js';
import { SECRETS_CLI_SPEC } from '../lib/secrets-cli.js';
import { refreshToolSetup } from '../lib/setup-tool-status.js';

export const SECRETS_CLI_PACKAGE = SECRETS_CLI_SPEC;
export const INSTALL_HINT = `agents setup tools --tool secrets   # or: npm i -g ${SECRETS_CLI_PACKAGE}`;

export function setupSecretsPrefsPath(): string {
  return path.join(getHistoryDir(), 'setup', 'secrets.json');
}

function recordSetupComplete(): void {
  const file = setupSecretsPrefsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
}

export async function installSecretsCli(): Promise<boolean> {
  const [row] = await ensureToolPins({ tools: ['secrets'] });
  _resetSecretsClientForTest();
  if (row.state !== 'failed') return true;
  console.error(chalk.red(row.error));
  return false;
}

export async function runSecretsSetupWizard(): Promise<boolean> {
  if (!(await installSecretsCli())) {
    console.log(chalk.yellow(`The standalone \`secrets\` CLI is missing or below ${SECRETS_CLI_PACKAGE}.`));
    console.log(chalk.gray('Install it, then re-run `agents setup secrets`:'));
    console.log(chalk.cyan(`  ${INSTALL_HINT}`));
    return false;
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
      if (!(options.installOnly ? await installSecretsCli() : await runSecretsSetupWizard())) process.exitCode = 1;
      await refreshToolSetup('secrets');
    });
}
