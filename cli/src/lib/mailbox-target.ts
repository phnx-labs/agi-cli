import type { ActiveSession } from './session/active.js';

export function mailboxIdForActiveSession(s: ActiveSession): string | undefined {

  return s.agentId ?? s.sessionId;
}
