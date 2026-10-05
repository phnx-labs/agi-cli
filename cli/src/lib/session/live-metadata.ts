// Live-registry to SessionMeta bridge (RUSH-2682). The registry (`getActiveSessions`) can be
// minutes ahead of the lazy transcript index, so `preview <id>` said "No session matching" for a
// running session. This reshapes it into a `SessionMeta` candidate; no transcript is parsed.

import { deriveShortId } from '../text/short-id.js';
import { isSessionTrackedAgent, type SessionMeta } from '@phnx-labs/sessions-cli/reader';
import type { ActiveSession } from './active.js';

/** Reshape one live `ActiveSession` into a `SessionMeta` candidate for the id resolver. Null for a
 * row that cannot back a durable session: no `sessionId`, or a `kind` that is not session-tracked
 * (cloud/team rows). Pure; caller supplies `self` and `nowMs`. */
export function activeSessionToSessionMeta(
  active: ActiveSession,
  self: string,
  nowMs: number,
): SessionMeta | null {
  const id = active.sessionId;
  if (!id) return null;
  if (!isSessionTrackedAgent(active.kind)) return null;

  const startedMs = active.startedAtMs ?? nowMs;
  const lastMs = active.lastActivityMs ?? startedMs;

  return {
    id,
    shortId: deriveShortId(id),
    agent: active.kind,
    harness: active.harness,
    timestamp: new Date(startedMs).toISOString(),
    lastActivity: new Date(lastMs).toISOString(),
    // An empty file path is honest — a just-created session may have no
    // transcript on disk yet, and `buildPreview` renders the header + a live
    // note for that case rather than trying to parse a missing file.
    filePath: active.sessionFile ?? '',
    cwd: active.cwd,
    project: active.project ?? undefined,
    label: active.label,
    // Carried though this projection only runs for sessions with NO indexed row (so `undefined`
    // today): a hand-built SessionMeta omitting the rung silently degrades the headline once its
    // reachability changes (PHNX-3797), and neither guard can see it here.
    generatedTitle: active.generatedTitle,
    topic: active.topic,
    firstUserMessage: active.firstUserMessage,
    version: active.version,
    messageCount: undefined,
    machine: active.machine ?? self,
    _remote: (active.machine ?? self) !== self,
    ticketId: active.ticket?.id,
    prUrl: active.pr?.url,
    prNumber: active.pr?.number,
    worktreeSlug: active.worktree?.slug,
    gitBranch: active.worktree?.branch,
    origin: active.origin,
    routineName: active.routineName,
  };
}

/** Map every eligible live session to a `SessionMeta` candidate. Ineligible rows (no id, non-agent
 * kind) are dropped. Order follows the input. */
export function liveSessionMetas(
  active: ActiveSession[],
  self: string,
  nowMs: number,
): SessionMeta[] {
  const out: SessionMeta[] = [];
  for (const a of active) {
    const meta = activeSessionToSessionMeta(a, self, nowMs);
    if (meta) out.push(meta);
  }
  return out;
}

/** Which box the AGENT of each live session executes on, keyed by lowercased id, from the
 * fleet-active snapshot. A dispatcher's shim row has `machine` self-defaulted though the agent
 * runs on a peer (PHNX-3890). Only rows attributed to a real machine are included. */
export function fleetExecutionMachineById(
  fleet: ActiveSession[],
): Map<string, string> {
  const byId = new Map<string, string>();
  for (const s of fleet) {
    // The AGENT machine is `machine` (where the transcript/harness lives), NOT
    // `offloadedFrom` (where the launcher shim runs) — reading follows the
    // transcript owner, so a would-be reader must reach `machine`.
    if (!s.sessionId || !s.machine) continue;
    byId.set(s.sessionId.toLowerCase(), s.machine);
  }
  return byId;
}

/** Correct a live `SessionMeta` candidate's machine to its true EXECUTION host from the
 * fleet-active attribution (PHNX-3890). Only a self-attributed, transcript-less row (the
 * launcher-shim shape) qualifies; it is stamped `_remote`. */
export function reconcileLiveMetaMachine(
  metas: SessionMeta[],
  fleetExecutionMachine: Map<string, string>,
  self: string,
): SessionMeta[] {
  return metas.map(meta => {
    // Already attributed elsewhere, or locally readable — not a self-default.
    if (meta.machine && meta.machine !== self) return meta;
    if (meta.filePath) return meta;
    const exec = fleetExecutionMachine.get(meta.id.toLowerCase());
    // Only a PEER attribution is positive information. The snapshot merges in THIS box's own rows,
    // so a `self` entry may echo the self-default recorded before the peer reported. Trusting it
    // would dead-end on the local stub (PHNX-3890).
    if (!exec || exec === self) return meta;
    return { ...meta, machine: exec, _remote: true };
  });
}
