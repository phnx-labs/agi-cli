import * as fs from 'fs';
import type { TerminalBackend, LaunchSpec, SplitDirection, EngineContext } from '../types.js';
import { appleScriptStr } from '../quote.js';
import { execOnly, iLoginShell } from '../shell.js';

const GHOSTTY_APP = '/Applications/Ghostty.app';

function appExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function configPrologue(cwd: string, command: string[]): string[] {
  const cmd = appleScriptStr(iLoginShell(execOnly(command)));
  return [
    'tell application "Ghostty"',
    '  activate',
    '  set cfg to new surface configuration',
    `  set initial working directory of cfg to ${appleScriptStr(cwd)}`,
    `  set command of cfg to ${cmd}`,
  ];
}

export function ghosttyTabScript(cwd: string, command: string[]): string {
  return [
    ...configPrologue(cwd, command),
    '  if (count of windows) is 0 then',
    '    new window with configuration cfg',
    '  else',
    '    new tab in front window with configuration cfg',
    '  end if',
    'end tell',
  ].join('\n');
}

export function ghosttySplitScript(cwd: string, command: string[], direction: SplitDirection): string {
  return [
    ...configPrologue(cwd, command),
    '  if (count of windows) is 0 then',
    '    new window with configuration cfg',
    '  else',
    `    split (focused terminal of selected tab of front window) direction ${direction} with configuration cfg`,
    '  end if',
    'end tell',
  ].join('\n');
}

export const ghosttyBackend: TerminalBackend = {
  id: 'ghostty',
  label: 'Ghostty',
  isAvailable(ctx: EngineContext): boolean {
    return ctx.platform === 'darwin' && appExists(GHOSTTY_APP);
  },
  buildTab(cwd: string, command: string[]): LaunchSpec {
    return { argv: ['osascript', '-e', ghosttyTabScript(cwd, command)] };
  },
  buildSplit(cwd: string, command: string[], direction: SplitDirection): LaunchSpec {
    return { argv: ['osascript', '-e', ghosttySplitScript(cwd, command, direction)] };
  },
};
