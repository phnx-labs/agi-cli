import type { Backend, EngineContext, TerminalBackend } from '../types.js';
import { itermBackend } from './iterm.js';
import { ghosttyBackend } from './ghostty.js';
import { tmuxBackend } from './tmux.js';
import { vscodiumAgentBackend } from './vscodium-agent.js';
import { terminalAppBackend } from './terminal-app.js';

export const BACKENDS: Record<Backend, TerminalBackend> = {
  iterm: itermBackend,
  ghostty: ghosttyBackend,
  tmux: tmuxBackend,
  'vscodium-agent': vscodiumAgentBackend,
  terminal: terminalAppBackend,
};

export function detectCurrentBackend(ctx: EngineContext): Backend | null {
  if (ctx.env.TMUX) return 'tmux';
  const term = (ctx.env.TERM_PROGRAM || '').toLowerCase();
  if (term.includes('iterm')) return 'iterm';
  if (term.includes('ghostty')) return 'ghostty';
  if (term.includes('apple_terminal')) return 'terminal';
  return null;
}

export function availableBackends(ctx: EngineContext): TerminalBackend[] {
  return Object.values(BACKENDS).filter((b) => b.isAvailable(ctx));
}

export { itermBackend, ghosttyBackend, tmuxBackend, vscodiumAgentBackend, terminalAppBackend };
