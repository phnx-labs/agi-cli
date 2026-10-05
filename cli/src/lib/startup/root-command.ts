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
