import type { Command } from 'commander';

export function configureRootCommand(program: Command, name: string, version: string): Command {


  return program
    .name(name)
    .description(
      'Install, configure, run, and dispatch AI coding agents from one place.\n' +
        'Works with Claude, Codex, Antigravity, Cursor, OpenCode, OpenClaw, and Droid.',
    )
    .version(version)
    .option('--verbose', 'Show startup self-heal details on stderr')
    .helpOption('-h, --help', 'Show help')
    .addHelpCommand(false);
}
