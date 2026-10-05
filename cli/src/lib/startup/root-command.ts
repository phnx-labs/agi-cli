import type { Command } from 'commander';

/** Configure the public root surface shared by the live CLI and reference generator. Deliberately
 * no `enablePositionalOptions()` (tried for RUSH-2687, reverted): it cascades to all ~552 commands
 * and breaks leaves that read parent flags via `optsWithGlobals()`. */
export function configureRootCommand(program: Command, name: string, version: string): Command {
  // Do not enable global positional options: parent commands own flags that may follow leaf nouns,
  // and their leaves recover those options through optsWithGlobals().
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

export function normalizeResumeDeviceArgs(args: string[]): string[] {
  if (args[0] !== 'sessions' || args[1] !== 'resume') return args;
  let options = true;
  return args.map((arg, index) => {
    if (index < 2 || !options) return arg;
    if (arg === '--') { options = false; return arg; }
    if (arg === '--device' || arg === '--devices' || arg === '-D') return '--resume-device';
    if (arg.startsWith('--device=') || arg.startsWith('--devices=')) {
      return `--resume-device=${arg.slice(arg.indexOf('=') + 1)}`;
    }
    if (arg.startsWith('-D')) return `--resume-device=${arg.slice(arg[2] === '=' ? 3 : 2)}`;
    return arg;
  });
}
