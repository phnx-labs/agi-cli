/** Resolves an `agents message <target>` to exactly one destination: a cloud task, one live
 * local/teams/loop agent, or an error. A target matching zero or several live agents is never
 * guessed. Pure (no I/O). */
import type { ActiveSession } from './session/active.js';
import type { HostTask } from './hosts/tasks.js';
import { sessionHeadline } from './session/title.js';

type MessageResolution =
  | { kind: 'cloud'; id: string }
  | { kind: 'local'; id: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: Array<{ id: string; label: string }> };

/** The mailbox id a live session's box is keyed by: a teams durable `agentId`, else the bare run's
 * `sessionId`. The spawn-time AGENTS_MAILBOX_DIR wiring must use this same id. */
export function mailboxIdForActiveSession(s: ActiveSession): string | undefined {
  return s.agentId ?? s.sessionId;
}

function labelFor(s: ActiveSession): string {
  return sessionHeadline(s) ?? s.teamName ?? s.host ?? s.context;
}

/** Resolves `target` against live sessions. Exact id matches win over prefix matches; results are
 * de-duped by canonical mailbox id (collapsed subagents share one). `isCloudTask` is checked first
 * so cloud task ids go to the cloud provider. */
export function resolveMessageTarget(
  target: string,
  sessions: ActiveSession[],
  isCloudTask: (id: string) => boolean,
): MessageResolution {
  if (isCloudTask(target)) return { kind: 'cloud', id: target };
  // An empty target would make every `startsWith` prefix match — never guess.
  if (target.length === 0) return { kind: 'none' };

  const exact = sessions.filter((s) => s.sessionId === target || s.agentId === target);
  const chosen =
    exact.length > 0
      ? exact
      : sessions.filter(
          (s) => Boolean(s.sessionId?.startsWith(target)) || Boolean(s.agentId?.startsWith(target)),
        );

  // De-dupe by canonical mailbox id (one box per logical agent).
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

/** Routes a target matching no local/cloud session (RUSH-2366): a detached `--device <host>
 * --no-follow` dispatch only has the `~/.agents/.cache/hosts/<id>.json` sidecar. Pure; `remoteRef`
 * prefers the remote agent's own id. */
export function decideHostTaskRoute(task: HostTask | null, target: string): HostTaskRoute {
  if (!task) return { kind: 'not-found' };
  if (task.status === 'running') {
    return { kind: 'reroute', remoteRef: task.sessionId ?? task.name ?? target, host: task.host };
  }
  return { kind: 'finished', host: task.host, status: task.status, exitCode: task.exitCode };
}
