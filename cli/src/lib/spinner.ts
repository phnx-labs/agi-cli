import ora, { type Options, type Ora } from 'ora';

export function interruptibleSpinner(text?: string, options?: Omit<Options, 'discardStdin'>): Ora {
  return ora({ ...options, ...(text !== undefined ? { text } : {}), discardStdin: false });
}
