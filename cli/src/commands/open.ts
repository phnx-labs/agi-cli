import type { Command } from 'commander';
import chalk from 'chalk';
import { parseAgentsUrl } from '../lib/deeplink/url.js';
import {
  registerAgentsUrlScheme,
  unregisterAgentsUrlScheme,
  agentsUrlSchemeStatus,
} from '../lib/deeplink/register.js';

export function registerOpenCommand(program: Command): void {
  const callback = program
    .command('_callback [url]', { hidden: true })
    .alias('open')
    .description('OS callback that resumes a session from an agents:// deep link (machine-only; humans use `agents sessions resume`).')
    .action(async (url: string | undefined) => {
      if (!url) {
        callback.help();
        return;
      }
      await handleUrl(url);
    });

  addUrlSchemeSubcommands(callback, { hidden: true });
}

export function addUrlSchemeSubcommands(parent: Command, opts: { hidden?: boolean } = {}): void {
  const hidden = opts.hidden ?? false;

  parent
    .command('register', { hidden })
    .description('Register the agents:// URL scheme with the OS so artifact links resume sessions (idempotent).')
    .action(() => {
      const status = registerAgentsUrlScheme();
      if (status.registered) {
        console.log(chalk.green('agents:// scheme registered.') + chalk.gray(` ${status.detail}`));
      } else {
        console.log(chalk.yellow('Could not register the agents:// scheme.') + chalk.gray(` ${status.detail}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('unregister', { hidden })
    .description('Remove the agents:// URL scheme handler.')
    .action(() => {
      const status = unregisterAgentsUrlScheme();
      console.log(chalk.gray(status.detail));
    });

  parent
    .command('status', { hidden })
    .description('Report whether the agents:// URL scheme handler is registered.')
    .action(() => {
      const status = agentsUrlSchemeStatus();
      const label = status.registered ? chalk.green('registered') : chalk.yellow('not registered');
      console.log(`agents:// handler: ${label} ${chalk.gray(`(${status.platform})`)}`);
      console.log(chalk.gray(`  ${status.detail}`));
      if (!status.registered) process.exitCode = 1;
    });
}

async function handleUrl(url: string): Promise<void> {
  const parsed = parseAgentsUrl(url);
  if ('error' in parsed) {
    console.error(chalk.red(`Not a valid agents:// link: ${parsed.error}`));
    process.exitCode = 2;
    return;
  }
  const { dispatchSessionLifecycleInPlace } = await import('./sessions-resume.js');
  await dispatchSessionLifecycleInPlace(parsed.id, parsed.host ? [parsed.host] : []);
}
