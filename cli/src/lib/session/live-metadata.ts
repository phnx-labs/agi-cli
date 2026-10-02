// ---------------------------------------------------------------------------
// Live-registry → SessionMeta bridge (RUSH-2682)
// ---------------------------------------------------------------------------
//
// A session the live registry (`getActiveSessions`) already knows about can be
// minutes ahead of the transcript index on the SAME box: indexing is lazy and
// only runs inside `discoverSessions`, so a session this machine JUST started is
// "running" in `agents sessions --active` while `agents sessions preview <id>`
// answers "No session matching" until an unrelated `agents sessions*` call
// happens to scan (measured 7.6 min blind on zion, agents-cli 1.22.39).
//
// This module converts a running `ActiveSession` into a `SessionMeta` candidate
// so the id resolver behind `preview` / `resume` / `focus` can resolve and render
// a running session with no transcript row yet, instead of claiming it does not
// exist. It parses no transcript and renders nothing — it only reshapes process
// state the live registry already computed. When the transcript IS on disk, the
// synthesized row carries its path, so the downstream `buildPreview` renders the
// real digest. Without a path, a peer-owned row fetches its digest from that peer;
// a genuinely local row renders the header + a "not indexed here" note.

import { deriveShortId } from '../text/short-id.js';
import { isSessionTrackedAgent, type SessionMeta } from '@phnx-labs/sessions-cli/reader';
import type { ActiveSession } from './active.js';

/**
 * Reshape one live `ActiveSession` into a `SessionMeta` candidate for the id
 * resolver. Returns `null` for a row that cannot back a durable session — no
 * `sessionId`, or a `kind` that is not a session-tracked harness (cloud/team
 * rows without a real agent transcript). Pure: the caller supplies `self` (the
 * local machine id) and `nowMs` so the row is deterministic and testable.
 */
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
    // Carried even though this projection only runs for a session with NO indexed
    // row (so the value is `undefined` today): a hand-built SessionMeta that
    // omits the rung is exactly the shape that silently degrades the headline the
    // moment its reachability changes (PHNX-3797). Neither guard can see it here
    // — it calls no ladder, and its fields sit on separate lines.
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

/**
 * Map every eligible live session to a `SessionMeta` candidate. Ineligible rows
 * (no id, non-agent kind) are dropped. Order follows the input.
 */
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

/**
 * Which box the AGENT of each live session executes on, keyed by lowercased id,
 * as recovered from the fleet-active snapshot (`agents sessions --active`'s
 * cross-machine merge). A dispatcher that launched a session running on a peer
 * has a live shim row locally whose `machine` self-defaulted to itself — the
 * launch process IS here, the agent is not (PHNX-3890). The fleet snapshot
 * already reconciled that against the peer's own self-report, so it is the one
 * place that knows the true execution host without a synced index row (which is
 * why `foldExecutionMachine` can't recover it: there is no local index row to
 * join). Only rows the fleet attributes to a real machine are included.
 */
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

/**
 * Correct a live `SessionMeta` candidate's machine to its true EXECUTION host
 * using the fleet-active attribution (PHNX-3890). Only a **self-attributed,
 * transcript-less** row is a candidate for correction — the launcher-shim shape
 * a dispatcher holds for a session whose agent runs on a peer, which is
 * indistinguishable from a genuinely-local just-started session by its local
 * fields alone. A row already attributed to another box, or one carrying a
 * transcript path, is left untouched. A corrected row is stamped `_remote` so
 * the read-vs-resume router (`transcriptOnPeerOf`) sends the preview to the
 * owning peer instead of dead-ending on the local "not indexed here" stub.
 */
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
    // Only a PEER attribution is positive information. A snapshot entry that
    // names THIS box cannot be trusted as confirmation, because the snapshot is
    // a merge that INCLUDES this box's own rows — so for exactly the session
    // shape being corrected here (no index row to fold from), a `self` entry may
    // be nothing but an echo of the self-default above, recorded while the
    // owning peer had not reported yet or was unreachable during that gather.
    // Treating it as proof would skip the fan-out and dead-end on the local stub
    // for a session genuinely running elsewhere — the PHNX-3890 bug itself.
    if (!exec || exec === self) return meta;
    return { ...meta, machine: exec, _remote: true };
  });
}
