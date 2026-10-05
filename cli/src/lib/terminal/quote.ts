import { shellQuote } from '../ssh-exec.js';

export { shellQuote };

export function appleScriptStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
