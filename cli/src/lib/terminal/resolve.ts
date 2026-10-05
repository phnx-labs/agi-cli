import type { ActiveSession } from '../session/active.js';
import { getActiveSessions } from '../session/active.js';
import { machineId } from '../machine-id.js';
import type { InjectTarget } from './inject.js';

export type InjectRail = 'tmux' | 'iterm' | 'vscodium' | 'ghostty';
export type InjectResolution =
  | { addressable: true; rail: InjectRail; target: InjectTarget; note?: string }
  | { addressable: false; reason: string; hint?: string };


export interface ResolveOptions {
  allowGhosttyFocus?: boolean;
}

const IDE_INJECT_VARIANTS: Record<string, { cli: string; scheme: string }> = {
  codium: { cli: 'codium', scheme: 'vscodium' },
  cursor: { cli: 'cursor', scheme: 'cursor' },
  code: { cli: 'code', scheme: 'vscode' },
};

export function addressabilityRecoveryHint(session: ActiveSession, fallbackId?: string): string {
  const sid = session.sessionId;
  const resumeId = sid ?? fallbackId;
  const shortId = resumeId ? resumeId.slice(0, 8) : '<id>';
  const device = session.machine ?? machineId();
  const resumeCmd = resumeId ? `agents sessions resume ${shortId}` : 'agents sessions resume <id>';
  const tmuxCmd = `agents config set devices.${device}.tmux on`;
  const interactive = session.context === 'terminal' || !!session.tty;

  if (session.host === 'ghostty') {
    return `Ghostty has no per-split addressing. ${interactive ? `Enable tmux wrapping with \`${tmuxCmd}\` and re-launch, or ` : ''}use \`${resumeCmd}\` to continue this session.`;
  }

  if (session.host && session.host in IDE_INJECT_VARIANTS && !sid) {
    return `This IDE terminal has not registered a session id yet. Wait a moment and retry, or use \`${resumeCmd}\` to continue.`;
  }

  if (session.host) {
    return `Host '${session.host}' has no addressable rail here. ${interactive ? `Enable tmux wrapping with \`${tmuxCmd}\` and re-launch, or ` : ''}use \`${resumeCmd}\` to continue this session.`;
  }

  return `This session has no addressable terminal rail (not tmux, iTerm, or an IDE terminal). ${interactive ? `Enable tmux wrapping with \`${tmuxCmd}\` and re-launch, or ` : ''}use \`${resumeCmd}\` to continue this session.`;
}

export function resolveInjectTargetForSession(
  session: ActiveSession,
  opts: ResolveOptions = {},
): InjectResolution {
  const prov = session.provenance;

  if (prov?.mux?.kind === 'tmux' && prov.mux.pane) {
    return {
      addressable: true,
      rail: 'tmux',
      target: { backend: 'tmux', pane: prov.mux.pane, socket: prov.mux.socket },
    };
  }

  if (prov?.reply?.rail === 'iterm') {
    return {
      addressable: true,
      rail: 'iterm',
      target: { backend: 'iterm', session: prov.reply.session },
    };
  }

  const variant = session.host ? IDE_INJECT_VARIANTS[session.host] : undefined;
  if (variant) {
    if (!session.sessionId) {
      return {
        addressable: false,
        reason: `IDE terminal (${session.host}) has no session id to address`,
        hint: addressabilityRecoveryHint(session),
      };
    }
    return {
      addressable: true,
      rail: 'vscodium',
      target: { backend: 'vscodium', terminalId: session.sessionId, cli: variant.cli, scheme: variant.scheme },
    };
  }

  if (session.host === 'ghostty') {

    if (opts.allowGhosttyFocus) {
      return {
        addressable: true,
        rail: 'ghostty',
        target: { backend: 'ghostty' },
        note: 'coarse Ghostty window path (opt-in): raises a window and types into the FOCUSED split — not split-precise',
      };
    }
    return {
      addressable: false,
      reason: 'un-addressable (ghostty, no tmux): no per-split addressing; watchdog skips',
      hint: addressabilityRecoveryHint(session),
    };
  }

  return {
    addressable: false,
    reason: session.host
      ? `no precise inject rail for host '${session.host}' (no tmux/iterm/IDE terminal detected)`
      : 'no inject rail: session is not inside tmux, iTerm, or an IDE terminal',
    hint: addressabilityRecoveryHint(session),
  };
}

export async function resolveInjectTarget(sessionId: string, opts: ResolveOptions = {}): Promise<InjectResolution> {
  if (!sessionId) return { addressable: false, reason: 'no sessionId given' };
  let sessions: ActiveSession[];
  try {
    sessions = await getActiveSessions();
  } catch (err) {
    return { addressable: false, reason: `could not list active sessions: ${err instanceof Error ? err.message : String(err)}` };
  }
  const session = sessions.find((s) => s.sessionId === sessionId);
  if (!session) return { addressable: false, reason: `no live session found for id ${sessionId}` };
  return resolveInjectTargetForSession(session, opts);
}
