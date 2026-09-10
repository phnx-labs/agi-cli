/**
 * `agents secrets` — thin passthrough to the standalone `secrets` CLI
 * (PHNX-3989, DIST-1). Every bundle/keychain/vault operation now lives in
 * `@phnx-labs/secrets-cli`, not in this repo; this command re-declares no
 * subcommand or flag of its own. `agents secrets <anything>` execs the
 * installed executable with the same argv, `SECRETS_HOME` defaulted to this
 * box's existing store (`buildServeEnv`, matching the process client's own
 * default so an interactive `secrets list` and an injected `readBundle` see
 * the same store), and `SECRETS_SCOPE`/`SECRETS_CONTEXT` passed through
 * unmodified from the ambient environment — this is the operator's own
 * terminal, not an injected agent exec, so there is no separate scope to
 * compute here (that stays in `lib/exec.ts` for the run/inject path).
 *
 * A missing executable fails loud with install guidance — no fallback to the
 * retired in-repo engine (`commands/secrets.ts` and its siblings), which stays
 * in the tree, unregistered, until every consumer has moved off it (tasks.md
 * item 7).
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import { buildServeEnv, invocation, resolveSecretsBin, SecretsClientError } from '../lib/secrets-client.js';
import { SECRETS_CLI_INSTALL_HINT } from '../lib/secrets-cli.js';

export function registerSecretsCommands(program: Command): void {
  program
    .command('secrets')
    .description('Named bundles of env variables — passthrough to the standalone `secrets` CLI. Run `agents secrets --help` (or `agents setup secrets`) for the full subcommand list.')
    .allowUnknownOption()
    .allowExcessArguments()
    // Hand `-h`/`--help` through too — the real subcommand help lives in the
    // installed `secrets` binary, not in this passthrough.
    .helpOption(false)
    .action(() => {
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
      // Everything after the literal `secrets` token on the real argv — the
      // subcommand + its own flags, verbatim, never re-parsed by commander.
      const secretsIndex = process.argv.indexOf('secrets');
      const forwarded = secretsIndex >= 0 ? process.argv.slice(secretsIndex + 1) : [];
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
    });
}
