/** Pure core of `agents sessions detach`: the nudge, the resumed-run argv and the id resolver.
 * Import-light (type import only) so it is unit-tested without the live-session discovery graph. */
import { sessionProcessHost, type ActiveSession } from '../lib/session/active.js';

/** The prompt the backgrounded run resumes with. It stops a now-unwatched agent from stalling on a
 * confirmation nobody will answer: it is headless and must drive to done, or stop and state a
 * blocker (a waiting session the user can `attach`). */
export const BACKGROUND_NUDGE =
  "You've been sent to the background — nobody is watching this session now. " +
  'Continue the current task and drive it to completion end-to-end. ' +
  "Don't ask for confirmation; make the reasonable call and keep going. " +
  'If you genuinely cannot proceed safely, stop and state the blocker plainly in one message.';

/** Build the argv for the headless continuation `detach` spawns. Agent-agnostic and version-pinned
 * by construction, via the same `agents run --resume` path `attach` reverses. */
export function buildBackgroundArgv(agent: string, sessionId: string, cwd?: string): string[] {
  const argv = ['run', agent, BACKGROUND_NUDGE, '--resume', sessionId, '--headless'];
  if (cwd) argv.push('--cwd', cwd);
  return argv;
}

type DetachTarget =
  | { kind: 'local'; sessionId: string }
  | { kind: 'remote'; machine: string; sessionId: string }
  | { kind: 'refuse'; reason: string };

/** Decide how to detach a resolved session. Cloud and team sessions are refused (own lifecycles); a
 * session on another machine is delegated to that host over SSH, never stopped locally since its
 * pid and tmux socket mean something only there. Pure; mirrors `focus`/`jumpTo`'s remote branch. */
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

/** Resolve `<id>` to exactly one live session by prefix, mirroring `focus`'s match so the two verbs
 * accept the same ids. */
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
