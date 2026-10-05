/** Shared `--device` option registrar so spelling, help and companions (`--remote-cwd`, `--no-
 * tty`, `--any`) stay identical. maybeRunOnHost consumes them before commander parses;
 * registering still documents them and keeps the local fall-through working. */

import type { Command } from 'commander';

/** Attach the standard `--device` flag family to a command and return it (chainable). */
export function addHostOption(cmd: Command): Command {
  return cmd
    .option(
      '-D, --device <name>',
      'Run this command on another machine over SSH instead of locally — a registered device, user@host, or `all` to fan out across every registered device. See `agents devices` / `agents hosts`.',
    )
    .option('--remote-cwd <dir>', "Working directory on the device for --device runs. Resolves on the REMOTE device — pass a '$HOME'-relative path (single-quoted so your local shell doesn't expand it) or a valid remote absolute path; a local ~ expands here and won't exist there (/Users/you vs /home/you). No effect on 'teams add'.")
    .option('--no-tty', 'Force non-interactive output for --device runs even from a terminal.')
    .option('--any', 'With --device <cap> (a capability tag), pick any matching device instead of erroring when several match.');
}
