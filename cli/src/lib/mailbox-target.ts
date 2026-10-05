import type { ActiveSession } from './session/active.js';
import type { HostTask } from './hosts/tasks.js';
import { sessionHeadline } from './session/title.js';

type MessageResolution =
  | { kind: 'cloud'; id: string }
  | { kind: 'local'; id: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: Array<{ id: string; label: string }> };

export function mailboxIdForActiveSession(s: ActiveSession): string | undefined {
  // Teams use durable agentId; bare runs use sessionId; spawn-time AGENTS_MAILBOX_DIR must use this same canonical ID.
  return s.agentId ?? s.sessionId;
}

function labelFor(s: ActiveSession): string {
  return sessionHeadline(s) ?? s.teamName ?? s.host ?? s.context;
}

export function resolveMessageTarget(
  target: string,
  sessions: ActiveSession[],
  isCloudTask: (id: string) => boolean,
): MessageResolution {
  // Exact matches precede prefixes; route only one canonical mailbox and never guess zero or multiple matches.
  if (isCloudTask(target)) return { kind: 'cloud', id: target };
  if (target.length === 0) return { kind: 'none' };

  const exact = sessions.filter((s) => s.sessionId === target || s.agentId === target);
  const chosen =
    exact.length > 0
      ? exact
      : sessions.filter(
          (s) => Boolean(s.sessionId?.startsWith(target)) || Boolean(s.agentId?.startsWith(target)),
        );

  const byId = new Map<string, ActiveSession>();
  for (const s of chosen) {
    const id = mailboxIdForActiveSession(s);
    if (id && !byId.has(id)) byId.set(id, s);
  }

  const ids = [...byId.keys()];
  if (ids.length === 0) return { kind: 'none' };
  if (ids.length === 1) return { kind: 'local', id: ids[0] };
  return {
    kind: 'ambiguous',
    candidates: [...byId.entries()].map(([id, s]) => ({ id, label: labelFor(s) })),
  };
}

export type HostTaskRoute =
  | { kind: 'reroute'; remoteRef: string; host: string }
  | { kind: 'finished'; host: string; status: string; exitCode?: number }
  | { kind: 'not-found' };

export function decideHostTaskRoute(task: HostTask | null, target: string): HostTaskRoute {
  // Remote rerouting follows the captured host/session identity.
  if (!task) return { kind: 'not-found' };
  if (task.status === 'running') {
    return { kind: 'reroute', remoteRef: task.sessionId ?? task.name ?? target, host: task.host };
  }
  return { kind: 'finished', host: task.host, status: task.status, exitCode: task.exitCode };
}
