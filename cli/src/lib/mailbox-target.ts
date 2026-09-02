/**
 * Resolve an `agents message <target>` argument to exactly one destination —
 * a cloud task, one live local/teams/loop agent, or an error. The anti-misroute
 * rule lives here: a target that matches zero or more-than-one live agent is
 * NEVER guessed; the caller reports it. Pure (no I/O) so it is unit-testable.
 */
import type { ActiveSession } from './session/active.js';
import type { HostTask } from './hosts/tasks.js';
import { sessionHeadline } from './session/title.js';

export type MessageResolution =
  | { kind: 'cloud'; id: string }
  | { kind: 'local'; id: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: Array<{ id: string; label: string }> };

/**
 * The mailbox id a live session's box is keyed by. Teams stamp a durable
 * `agentId` (== the Claude session id for Claude teammates); a bare run has
 * only its `sessionId`. The spawn-time `AGENTS_MAILBOX_DIR` wiring must key the
 * box by this same id — this is the single source of truth for both sides.
 */
export function mailboxIdForActiveSession(s: ActiveSession): string | undefined {
  return s.agentId ?? s.sessionId;
}

function labelFor(s: ActiveSession): string {
  return sessionHeadline(s) ?? s.teamName ?? s.host ?? s.context;
}

/**
 * Resolve `target` against the live sessions. Exact id matches win over prefix
 * matches; results are de-duped by canonical mailbox id (collapsed subagents
 * share one). `isCloudTask` is consulted first so a cloud task id routes to the
 * cloud provider.
 */
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

/**
 * Decide how `agents message <target>` should handle a target that matched no
 * local/cloud session (RUSH-2366 follow-up): `getActiveSessions()` has no
 * visibility into a detached `agents run --device <host> --no-follow`
 * dispatch, whose only local record is the `~/.agents/.cache/hosts/<id>.json`
 * sidecar `agents devices ps` reads. Pure — the caller does the actual lookup
 * (`resolveTaskRef`) and I/O (the ssh reroute).
 *
 * `remoteRef` prefers the remote agent's OWN identity (its captured session id
 * or `--name` handle) over the LOCAL dispatch-record id the user typed here —
 * the live process on the host registers itself under the former, never the
 * latter.
 */
export function decideHostTaskRoute(task: HostTask | null, target: string): HostTaskRoute {
  if (!task) return { kind: 'not-found' };
  if (task.status === 'running') {
    return { kind: 'reroute', remoteRef: task.sessionId ?? task.name ?? target, host: task.host };
  }
  return { kind: 'finished', host: task.host, status: task.status, exitCode: task.exitCode };
}
