
import { deriveShortId } from '../text/short-id.js';
import { isSessionTrackedAgent, type SessionMeta } from '@phnx-labs/sessions-cli/reader';
import type { ActiveSession } from './active.js';

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
    filePath: active.sessionFile ?? '',
    cwd: active.cwd,
    project: active.project ?? undefined,
    label: active.label,
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

// machine is the agent/transcript owner; offloadedFrom names only the launcher.
export function fleetExecutionMachineById(
  fleet: ActiveSession[],
): Map<string, string> {
  const byId = new Map<string, string>();
  for (const s of fleet) {
    if (!s.sessionId || !s.machine) continue;
    byId.set(s.sessionId.toLowerCase(), s.machine);
  }
  return byId;
}

// Correct only self-attributed transcript-less rows from positive peer evidence; absence never proves locality.
export function reconcileLiveMetaMachine(
  metas: SessionMeta[],
  fleetExecutionMachine: Map<string, string>,
  self: string,
): SessionMeta[] {
  return metas.map(meta => {
    if (meta.machine && meta.machine !== self) return meta;
    if (meta.filePath) return meta;
    const exec = fleetExecutionMachine.get(meta.id.toLowerCase());
    if (!exec || exec === self) return meta;
    return { ...meta, machine: exec, _remote: true };
  });
}
