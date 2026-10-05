import * as fs from 'fs';
import type { TerminalBackend, LaunchSpec, SplitDirection, EngineContext } from '../types.js';
import { appleScriptStr } from '../quote.js';
import { loginExec, iLoginShell } from '../shell.js';

const TERMINAL_APP = '/System/Applications/Utilities/Terminal.app';
const TERMINAL_APP_LEGACY = '/Applications/Utilities/Terminal.app';

function appExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export function terminalAppTabScript(cwd: string, command: string[]): string {
  const cmd = appleScriptStr(iLoginShell(loginExec(cwd, command)));
  return [
    'tell application "Terminal"',
    '  activate',
    '  if (count of windows) is 0 then',
    `    do script ${cmd}`,
    '  else',
    `    do script ${cmd} in front window`,
    '  end if',
    'end tell',
  ].join('\n');
}

export const terminalAppBackend: TerminalBackend = {
  id: 'terminal',
  label: 'Terminal',
  isAvailable(ctx: EngineContext): boolean {
    if (ctx.platform !== 'darwin') return false;
    if (ctx.env.SSH_CONNECTION || ctx.env.SSH_TTY) return false;
    return appExists(TERMINAL_APP) || appExists(TERMINAL_APP_LEGACY);
  },
  buildTab(cwd: string, command: string[]): LaunchSpec {
    return { argv: ['osascript', '-e', terminalAppTabScript(cwd, command)] };
  },
  buildSplit(cwd: string, command: string[], _direction: SplitDirection): LaunchSpec {
    return { argv: ['osascript', '-e', terminalAppTabScript(cwd, command)] };
  },
};
