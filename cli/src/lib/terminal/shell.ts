import { shellQuote } from './quote.js';

export function loginExec(cwd: string, command: string[]): string {
  return `cd ${shellQuote(cwd)} && exec ${command.join(' ')}`;
}

export function execOnly(command: string[]): string {
  return `exec ${command.join(' ')}`;
}

export function iLoginShell(inner: string): string {

  return `zsh -ilc ${shellQuote(inner)}`;
}
