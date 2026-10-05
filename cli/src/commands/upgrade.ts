import type { Command } from 'commander';

export interface UpgradeOptions {
  yes?: boolean;
}

type UpgradeAction = (version: string | undefined, options: UpgradeOptions) => Promise<void>;

export function registerUpgradeCommand(program: Command, action?: UpgradeAction): Command {
  const command = program.command('upgrade')
    .description('Upgrade agents-cli to the latest version (or a specific [version])')
    .argument('[version]', 'Target version or dist-tag to install (default: latest)')
    .option('-y, --yes', 'Install without an interactive confirmation prompt');
  if (action) command.action(action);
  return command;
}
