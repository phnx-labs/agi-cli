/**
 * Inject-target resolution — the safety choke point (RUSH-1415).
 *
 * The watchdog knows a session has stalled and wants to nudge it with "continue".
 * `injectIntoTerminal` (inject.ts) can DELIVER into a target; this module decides
 * the RIGHT target for a given sessionId — the exact split the agent lives in —
 * and NEVER guesses. If it can't name a precise rail it returns `addressable:
 * false` with a reason, and the watchdog skips rather than typing into the
 * frontmost / wrong split.
 *
 * Resolution reads the agent's INHERITED ENV (via session provenance) plus the
 * IDE's live-terminals registry (off disk) — no cooperation from the agent:
 *
 *   tmux  > iterm > vscodium
 *
 * tmux wins whenever present: a `tmux send-keys -t <pane>` reaches the pane no
 * matter which host app (iTerm / Ghostty / VS Code) is above it, so it's correct
 * inside ANY of them. Absent tmux, the host-app rail: iTerm2's exact split by
 * session UUID (env), or a VSCodium/Cursor/VS Code integrated terminal addressed
 * by its live-terminals id. Ghostty has no per-split addressing (no scripting
 * dictionary), so a Ghostty-hosted session with no tmux is honestly reported
 * un-addressable — the coarse focus-stealing window path stays behind an explicit
 * opt-in and is never chosen by default.
 */
import type { ActiveSession } from '../session/active.js';
import { getActiveSessions } from '../session/active.js';
import { machineId } from '../machine-id.js';
import type { InjectTarget } from './inject.js';

/** A resolved rail, or an honest refusal. The watchdog acts only on `addressable: true`. */
export type InjectRail = 'tmux' | 'iterm' | 'vscodium' | 'ghostty';
export type InjectResolution =
  | { addressable: true; rail: InjectRail; target: InjectTarget; note?: string }
  | { addressable: false; reason: string; hint?: string };


export interface ResolveOptions {
  /**
   * Allow the COARSE Ghostty path (raise the frontmost/opt-in window and type via
   * System Events keystrokes — steals focus, not split-precise). Off by default:
   * a Ghostty session with no tmux resolves to un-addressable instead.
   */
  allowGhosttyFocus?: boolean;
}

/** The editor CLIs that speak the swarm-ext URI protocol, keyed by the host detectHost() reports. */
const IDE_INJECT_VARIANTS: Record<string, { cli: string; scheme: string }> = {
  codium: { cli: 'codium', scheme: 'vscodium' },
  cursor: { cli: 'cursor', scheme: 'cursor' },
  code: { cli: 'code', scheme: 'vscode' },
};

/**
 * Human-facing recovery hint for a session the resolver judged un-addressable.
 * Tells the user both how to continue THIS session and how to make FUTURE runs
 * addressable, so the failure is not silent and the fix is actionable.
 */
export function addressabilityRecoveryHint(session: ActiveSession, fallbackId?: string): string {
  const sid = session.sessionId;
  // Branch on the live sessionId (an IDE terminal that has not registered one
  // yet is a distinct message), but render the resume command with the real id
  // when the caller can supply it — e.g. `focus` has meta.id even though the
  // live row's sessionId is falsy, so without this the hint printed a useless
  // `agents sessions resume <id>` placeholder in exactly that case (PHNX-3070).
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

/**
 * Resolve a target from an already-fetched ActiveSession. Pure — no I/O — so the
 * precedence logic is unit-testable without the process table. This is where the
 * tmux > iterm > vscodium precedence and the Ghostty refusal live.
 */
export function resolveInjectTargetForSession(
  session: ActiveSession,
  opts: ResolveOptions = {},
): InjectResolution {
  const prov = session.provenance;

  // 1. tmux — correct inside any host app, so it takes precedence whenever the
  //    env carries a pane. (provenance.reply already encodes tmux-over-iterm.)
  if (prov?.mux?.kind === 'tmux' && prov.mux.pane) {
    return {
      addressable: true,
      rail: 'tmux',
      target: { backend: 'tmux', pane: prov.mux.pane, socket: prov.mux.socket },
    };
  }

  // 2. iterm — the exact split by session UUID (env-derived, focus-safe).
  if (prov?.reply?.rail === 'iterm') {
    return {
      addressable: true,
      rail: 'iterm',
      target: { backend: 'iterm', session: prov.reply.session },
    };
  }

  // 3. vscodium — a VSCodium/Cursor/VS Code integrated terminal, addressed by the
  //    id the extension keys live-terminals.json on (the session UUID). Only when
  //    the session is IDE-hosted AND we know its id.
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

  // 4. Ghostty — no per-split addressing exists. Refuse by default; the coarse,
  //    focus-stealing window path is opt-in only.
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

/**
 * The single resolver the watchdog calls: sessionId -> a precise InjectTarget or
 * an honest refusal. Fetches the active session (which carries provenance, host,
 * and pid), then applies the pure precedence above. Returns `addressable: false`
 * when the session isn't live / can't be found — never a guess.
 */
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
