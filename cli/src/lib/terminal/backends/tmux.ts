import type { TerminalBackend, LaunchSpec, SplitDirection, EngineContext } from '../types.js';
import { execOnly, iLoginShell } from '../shell.js';

export function tmuxTabArgv(cwd: string, command: string[]): string[] {
  return ['tmux', 'new-window', '-c', cwd, iLoginShell(execOnly(command))];
}

export function tmuxSplitArgv(cwd: string, command: string[], direction: SplitDirection): string[] {
  const flag = direction === 'right' ? '-h' : '-v';
  return ['tmux', 'split-window', flag, '-c', cwd, iLoginShell(execOnly(command))];
}

export const tmuxBackend: TerminalBackend = {
  id: 'tmux',
  label: 'tmux',
  isAvailable(ctx: EngineContext): boolean {
    return Boolean(ctx.env.TMUX);
  },
  buildTab(cwd: string, command: string[]): LaunchSpec {
    return { argv: tmuxTabArgv(cwd, command) };
  },
  buildSplit(cwd: string, command: string[], direction: SplitDirection): LaunchSpec {
    return { argv: tmuxSplitArgv(cwd, command, direction) };
  },
};
