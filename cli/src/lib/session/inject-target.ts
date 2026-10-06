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
  const matches = sessions.filter((s) => matchInjectSelector(s, selector));
  if (matches.length === 0) return { target: null, reason: `No active session matches "${selector}".` };
  const exact = matches.filter((s) =>
    [s.sessionId, s.tmuxName, s.paneId, s.tmuxName && shortIdFromName(s.tmuxName)].includes(selector));
  const candidates = exact.length > 0 ? exact : matches;
  if (candidates.length > 1) {
    const names = candidates.map((s) => s.tmuxName ?? s.sessionId ?? s.paneId).join(', ');
    return {
      target: null,
      reason: `"${selector}" matches ${candidates.length} live sessions (${names}); pass a longer id.`,
    };
  }
  const [match] = candidates;
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
