/** Ctrl-C-safe spinner factory. ora's default `discardStdin: true` raw-modes a TTY stdin, so Ctrl-C
 * raises no SIGINT and is swallowed for the spinner's life (`agents sessions --flat` needed
 * SIGKILL). `discardStdin: false` keeps cooked mode; use it for any network/fleet/SSH wait. */
import ora, { type Options, type Ora } from 'ora';

/** Build an interruptible spinner, a drop-in for `ora(text)` that keeps Ctrl-C working. Returns
 * an unstarted Ora. */
export function interruptibleSpinner(text?: string, options?: Omit<Options, 'discardStdin'>): Ora {
  return ora({ ...options, ...(text !== undefined ? { text } : {}), discardStdin: false });
}
