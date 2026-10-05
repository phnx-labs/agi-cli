import * as fs from 'fs';
import type { TerminalBackend, LaunchSpec, SplitDirection, EngineContext } from '../types.js';
import { appleScriptStr } from '../quote.js';
import { loginExec, iLoginShell } from '../shell.js';

const ITERM_APP = '/Applications/iTerm.app';

function appExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export function itermTabScript(cwd: string, command: string[]): string {
  const cmd = appleScriptStr(iLoginShell(loginExec(cwd, command)));
  return [
    'tell application "iTerm2"',
    '  activate',
    '  if (count of windows) is 0 then',
    `    create window with default profile command ${cmd}`,
    '  else',
    `    tell current window to create tab with default profile command ${cmd}`,
    '  end if',
    'end tell',
  ].join('\n');
}

export function itermSplitScript(cwd: string, command: string[], direction: SplitDirection): string {
  const cmd = appleScriptStr(iLoginShell(loginExec(cwd, command)));
  const verb = direction === 'right' ? 'split vertically' : 'split horizontally';
  return [
    'tell application "iTerm2"',
    '  activate',
    '  if (count of windows) is 0 then',
    `    create window with default profile command ${cmd}`,
    '  else',
    `    tell current session of current window to ${verb} with default profile command ${cmd}`,
    '  end if',
    'end tell',
  ].join('\n');
}

export const itermBackend: TerminalBackend = {
  id: 'iterm',
  label: 'iTerm',
  isAvailable(ctx: EngineContext): boolean {
    return ctx.platform === 'darwin' && appExists(ITERM_APP);
  },
  buildTab(cwd: string, command: string[]): LaunchSpec {
    return { argv: ['osascript', '-e', itermTabScript(cwd, command)] };
  },
  buildSplit(cwd: string, command: string[], direction: SplitDirection): LaunchSpec {
    return { argv: ['osascript', '-e', itermSplitScript(cwd, command, direction)] };
  },
};
