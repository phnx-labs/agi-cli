import type { Command } from 'commander';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import { buildServeEnv, invocation, resolveSecretsBin, SecretsClientError } from '../lib/secrets-client.js';
import { flagValue } from '../lib/hosts/routing-flag.js';
import { stripRoutingFlags } from '../lib/hosts/remote-cmd.js';
import { resolveRemoteDevice } from '../lib/ssh-tunnel.js';
import { SECRETS_CLI_INSTALL_HINT } from '../lib/secrets-cli.js';
import { forwardsHelp } from '../lib/help.js';

export async function rewriteDeviceToHost(argv: string[]): Promise<string[]> {
  if (flagValue(argv, 'host', 'H') !== undefined) return argv;
  const device = flagValue(argv, 'device', 'D');
  if (device === undefined) return argv;
  const resolved = await resolveRemoteDevice(device, {});
  const stripped = stripRoutingFlags(argv, [{ long: 'device', short: 'D', takesValue: true }]);
  return [...stripped, '--host', `ssh://${resolved.target}`];
}

export function registerSecretsCommands(program: Command): void {
  forwardsHelp(program
    .command('secrets')
    .description('Named bundles of env variables — passthrough to the standalone `secrets` CLI. Run `agents secrets --help` (or `agents setup secrets`) for the full subcommand list.')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      let bin: string;
      try {
        bin = resolveSecretsBin();
      } catch (err) {
        if (err instanceof SecretsClientError && err.code === 'SECRETS_BIN_MISSING') {
          console.error(chalk.red('The standalone `secrets` CLI is not installed.'));
          console.error(chalk.gray(`Install it, then re-run this command:`));
          console.error(chalk.cyan(`  ${SECRETS_CLI_INSTALL_HINT}`));
          process.exit(1);
        }
        throw err;
      }
      const secretsIndex = process.argv.indexOf('secrets');
      const forwarded = await rewriteDeviceToHost(secretsIndex >= 0 ? process.argv.slice(secretsIndex + 1) : []);
      const { command, prefix } = invocation(bin);
      const res = spawnSync(command, [...prefix, ...forwarded], {
        stdio: 'inherit',
        env: buildServeEnv(),
      });
      if (res.error) {
        console.error(chalk.red(`Failed to run \`secrets\`: ${res.error.message}`));
        process.exit(1);
      }
      process.exit(res.status ?? 1);
    }));
}
