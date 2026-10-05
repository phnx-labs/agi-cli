// Keep discardStdin:false: ora can swallow Ctrl-C before stdin flows, trapping long network or SSH waits.
import ora, { type Options, type Ora } from 'ora';

export function interruptibleSpinner(text?: string, options?: Omit<Options, 'discardStdin'>): Ora {
  return ora({ ...options, ...(text !== undefined ? { text } : {}), discardStdin: false });
}
