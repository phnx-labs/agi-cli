import { getActiveSessions, shortIdFromName, type ActiveSession } from './active.js';
import { resolveInjectTargetForSession, type InjectTarget } from '../terminal/index.js';

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
