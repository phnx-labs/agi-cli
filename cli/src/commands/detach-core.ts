import { sessionProcessHost, type ActiveSession } from '../lib/session/active.js';

export const BACKGROUND_NUDGE =
  "You've been sent to the background — nobody is watching this session now. " +
  'Continue the current task and drive it to completion end-to-end. ' +
  "Don't ask for confirmation; make the reasonable call and keep going. " +
  'If you genuinely cannot proceed safely, stop and state the blocker plainly in one message.';

export function buildBackgroundArgv(agent: string, sessionId: string, cwd?: string): string[] {
  const argv = ['run', agent, BACKGROUND_NUDGE, '--resume', sessionId, '--headless'];
  if (cwd) argv.push('--cwd', cwd);
  return argv;
}

type DetachTarget =
  | { kind: 'local'; sessionId: string }
  | { kind: 'remote'; machine: string; sessionId: string }
  | { kind: 'refuse'; reason: string };

export function resolveDetachTarget(s: ActiveSession, self: string): DetachTarget {
  if (s.context === 'cloud') {
    return { kind: 'refuse', reason: 'Cloud sessions run remotely and cannot be detached from here.' };
  }
  if (s.context === 'teams') {
    return {
      kind: 'refuse',
      reason: 'That session is managed by its team — stop it with `agents teams`, not `detach`.',
    };
  }
  const sessionId = s.sessionId ?? '';
  if (!sessionId) {
    return { kind: 'refuse', reason: 'That session has no id to resume, so it cannot be detached.' };
  }
  const processHost = sessionProcessHost(s, self);
  if (processHost) {
    return { kind: 'remote', machine: processHost, sessionId };
  }
  return { kind: 'local', sessionId };
}

export function resolveOne(
  activeById: Map<string, ActiveSession>,
  id: string,
): ActiveSession | { error: string } {
  const q = id.toLowerCase();
  const matches = [...activeById.values()].filter((s) => (s.sessionId ?? '').toLowerCase().startsWith(q));
  if (matches.length === 0) return { error: `No live session matching "${id}".` };
  if (matches.length > 1) {
    return { error: `"${id}" is ambiguous (${matches.length} live matches). Use more of the id.` };
  }
  return matches[0];
}
