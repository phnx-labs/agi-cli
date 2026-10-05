import type { Backend, EngineContext } from './types.js';
import type { ActiveSession } from '../session/active.js';
import { BACKENDS } from './backends/index.js';
import { openSurface } from './engine.js';
import { getCliLaunch } from '../cli-entry.js';
import { shellQuote } from './quote.js';
import {
  resolveLaunchBackend,
  describeBackendChoice,
  type LaunchBackendChoice,
  type SessionHostSample,
} from './preferred.js';

export const TERMINAL_FLAG_BACKENDS: Backend[] = Object.keys(BACKENDS) as Backend[];

export function parseTerminalFlag(value: unknown): { backend?: Backend; error?: string } {
  if (value === undefined || value === true || value === '') return {};
  const raw = String(value);
  if ((TERMINAL_FLAG_BACKENDS as string[]).includes(raw)) return { backend: raw as Backend };
  const looksLikeAPrompt = /\s/.test(raw) || raw.length > 24;
  const hint = looksLikeAPrompt
    ? ` That looks like a prompt: put it BEFORE the flag — agents run <agent> "${raw.length > 40 ? `${raw.slice(0, 40)}…` : raw}" --terminal.`
    : '';
  return {
    error: `Unknown --terminal backend '${raw}'. Use one of: ${TERMINAL_FLAG_BACKENDS.join(', ')} (or pass --terminal alone to auto-detect).${hint}`,
  };
}

export function stripTerminalFlag(argv: string[], consumedValue?: string): string[] {
  // Strip only Commander's consumed option/value and stop at -- so passthrough argv remains untouched.
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') {
      out.push(...argv.slice(i));
      break;
    }
    if (tok === '--terminal') {
      if (consumedValue !== undefined && argv[i + 1] === consumedValue) i++;
      continue;
    }
    if (tok.startsWith('--terminal=')) continue;
    out.push(tok);
  }
  return out;
}

export function buildRunCommand(argv: string[]): string[] {
  const { command, args } = getCliLaunch(argv);
  return [command, ...args].map(shellQuote);
}

export async function toHostSamples(sessions: ActiveSession[]): Promise<SessionHostSample[]> {
  const samples: SessionHostSample[] = sessions.map((s) => ({
    host: s.host,
    lastActivityMs: s.lastActivityMs,
    startedAtMs: s.startedAtMs,
  }));

  const tmuxIdx = sessions
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.provenance?.mux?.kind === 'tmux' && s.provenance.mux.pane);
  if (tmuxIdx.length === 0) return samples;

  try {
    const { enumerateGhosttyTabs } = await import('../session/ghostty-tabs.js');
    const { mapPanesToTargets, listClients } = await import('../tmux/session.js');
    const { resolveViewingIn } = await import('../session/viewing-in.js');
    const ghosttySurfaces = await enumerateGhosttyTabs();
    const sockets = new Set(tmuxIdx.map(({ s }) => s.provenance!.mux!.socket));
    for (const socket of sockets) {
      const paneToTarget = await mapPanesToTargets(socket);
      if (paneToTarget.size === 0) continue;
      const clients = await listClients(socket);
      for (const { s, i } of tmuxIdx) {
        if (s.provenance!.mux!.socket !== socket) continue;
        const viewing = await resolveViewingIn(s, clients, { paneToTarget, ghosttySurfaces });
        if (viewing) samples[i].viewingApp = viewing.app;
      }
    }
  } catch {
  }
  return samples;
}

export interface OpenRunSurfaceParams {
  argv: string[];
  forced?: Backend;
  consumedValue?: string;
  cwd: string;
  sessions: SessionHostSample[];
  ctx: EngineContext;
}

export interface OpenRunSurfaceResult {
  ok: boolean;
  choice?: LaunchBackendChoice;
  description?: string;
  error?: string;
}

export async function openRunInTerminal(params: OpenRunSurfaceParams): Promise<OpenRunSurfaceResult> {
  const choice: LaunchBackendChoice | null = params.forced
    ? { backend: params.forced, source: 'forced' }
    : resolveLaunchBackend(params.ctx, params.sessions);

  if (!choice) {
    return {
      ok: false,
      error: 'No terminal this machine can drive (need iTerm, Ghostty, Terminal.app, VSCodium, or a tmux session). Run without --terminal.',
    };
  }
  if (params.forced && !BACKENDS[choice.backend].isAvailable(params.ctx)) {
    return { ok: false, error: `--terminal ${choice.backend} is not available here.` };
  }

  const command = buildRunCommand(stripTerminalFlag(params.argv, params.consumedValue));
  const result = await openSurface({
    backend: choice.backend,
    layout: 'tab',
    cwd: params.cwd,
    command,
  });
  return { ok: result.ok, choice, description: describeBackendChoice(choice), error: result.error };
}
