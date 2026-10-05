/**
 * Resolve a live session selector to the terminal split it runs in. Shared by
 * `agents sessions inject` and the `session` channel of `agents send`, so both
 * address exactly the sessions the watchdog can (`resolveInjectTargetForSession`,
 * precedence tmux > iterm > vscodium).
 */
import { getActiveSessions, shortIdFromName, type ActiveSession } from './active.js';
import { resolveInjectTargetForSession, type InjectTarget } from '../terminal/index.js';

/**
 * Whether an active session is the one `<token>` means. Matches a resolvable
 * session id (exact or unique prefix) AND — for a tmux-hosted row whose full id
 * never resolved (`sessionId` absent) — the `ag-<agent>-<shortid>` tmux name's
 * `shortid` suffix (exact or prefix), the full tmux name, and the pane id. Those
 * are the only selectors an id-less remote tmux row exposes (PHNX-3688).
 */
export function matchInjectSelector(session: ActiveSession, token: string): boolean {
  if (!token) return false;
  const sid = session.sessionId;
  if (sid && (sid === token || sid.startsWith(token))) return true;
  const short = session.tmuxName ? shortIdFromName(session.tmuxName) : undefined;
  if (short && (short === token || short.startsWith(token))) return true;
  if (session.tmuxName && session.tmuxName === token) return true;
  if (session.paneId && session.paneId === token) return true;
  return false;
}

/** A live session on this machine resolved to an addressable split, or why not. */
export async function resolveLiveInjectTarget(
  selector: string,
): Promise<{ target: InjectTarget | null; reason?: string; hint?: string }> {
  const sessions = await getActiveSessions();
  const match = sessions.find((s) => matchInjectSelector(s, selector));
  if (!match) return { target: null, reason: `No active session matches "${selector}".` };
  const resolution = resolveInjectTargetForSession(match);
  if (!resolution.addressable) {
    return {
      target: null,
      reason: `Session "${selector}": ${resolution.reason}`,
      hint: resolution.hint,
    };
  }
  return { target: resolution.target };
}
