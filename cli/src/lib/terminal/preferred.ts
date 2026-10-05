import type { Backend, EngineContext } from './types.js';
import { BACKENDS, availableBackends, detectCurrentBackend } from './backends/index.js';

export const SESSION_HOST_BACKENDS: Readonly<Record<string, Backend>> = Object.freeze({
  iterm: 'iterm',
  ghostty: 'ghostty',
  terminal: 'terminal',
  tmux: 'tmux',
  codium: 'vscodium-agent',
});

export interface SessionHostSample {
  host?: string;
  viewingApp?: string;
  lastActivityMs?: number;
  startedAtMs?: number;
}

export type BackendSource = 'forced' | 'current-terminal' | 'active-session' | 'available';

export interface LaunchBackendChoice {
  backend: Backend;
  source: BackendSource;
  host?: string;
}

function byRecency(a: SessionHostSample, b: SessionHostSample): number {
  const at = a.lastActivityMs ?? a.startedAtMs ?? 0;
  const bt = b.lastActivityMs ?? b.startedAtMs ?? 0;
  return bt - at;
}

export interface BackendResolveDeps {
  isAvailable?: (backend: Backend, ctx: EngineContext) => boolean;
}

const realIsAvailable = (backend: Backend, ctx: EngineContext): boolean =>
  BACKENDS[backend].isAvailable(ctx);

export function backendFromSessions(
  sessions: SessionHostSample[],
  ctx: EngineContext,
  deps: BackendResolveDeps = {},
): { backend: Backend; host: string } | null {
  const isAvailable = deps.isAvailable ?? realIsAvailable;
  for (const s of [...sessions].sort(byRecency)) {
    // viewingApp is the drivable outer terminal; a tmux session's host may name only the inner rail.
    const host = s.viewingApp ?? s.host;
    if (!host) continue;
    // Admit only explicit host mappings whose backend is actually available on this machine.
    if (!Object.hasOwn(SESSION_HOST_BACKENDS, host)) continue;
    const backend = SESSION_HOST_BACKENDS[host];
    if (!backend) continue;
    if (!isAvailable(backend, ctx)) continue;
    return { backend, host };
  }
  return null;
}

export function resolveLaunchBackend(
  ctx: EngineContext,
  sessions: SessionHostSample[] = [],
  deps: BackendResolveDeps = {},
): LaunchBackendChoice | null {
  const isAvailable = deps.isAvailable ?? realIsAvailable;
  const current = detectCurrentBackend(ctx);
  if (current && isAvailable(current, ctx)) {
    return { backend: current, source: 'current-terminal' };
  }
  const fromSession = backendFromSessions(sessions, ctx, deps);
  if (fromSession) {
    return { backend: fromSession.backend, source: 'active-session', host: fromSession.host };
  }
  const first = (Object.keys(BACKENDS) as Backend[]).find((b) => isAvailable(b, ctx));
  return first ? { backend: first, source: 'available' } : null;
}

export function describeBackendChoice(choice: LaunchBackendChoice): string {
  const label = BACKENDS[choice.backend].label;
  switch (choice.source) {
    case 'forced':
      return `${label} (you asked for it)`;
    case 'current-terminal':
      return `${label} (the terminal you're in)`;
    case 'active-session':
      return `${label} (where your ${choice.host} sessions run)`;
    case 'available':
      return `${label} (no running session named a terminal)`;
  }
}
