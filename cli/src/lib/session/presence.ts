/**
 * RUSH-2007 Layer C — per-session presence tracking, folded into the `agents
 * watchdog` tick (NOT a revived daemon).
 *
 * Each tick the watchdog observes the active sessions across the fleet
 * (`gatherRemoteActive` + the local scan). This module persists one record per
 * session — `{location, device, transport, lastSeen, status}` — and DERIVES
 * `connected` / `disconnected` by diffing consecutive observations: a session
 * present this tick is `connected`; one that was tracked but is now absent (its
 * peer went unreachable, or the interactive client dropped) flips to
 * `disconnected` while its record — and the transition — is surfaced so the tick
 * can act (an interactive drop is a reconnect-nudge candidate; a headless remote
 * is a keep-alive). The store is honest across a crash: it only reflects what the
 * last scan actually saw, never an asserted state.
 *
 * Store: `~/.agents/.cache/state/watchdog/presence.json` — sibling of the tick's
 * existing `nudges/flags/last-tick` files. Best-effort: an unreadable/corrupt
 * file degrades to an empty store, never throws into the tick loop.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRuntimeStateDir } from '../state.js';

export type PresenceStatus = 'connected' | 'disconnected';
export type PresenceLocation = 'local' | 'ssh';

/** A session as OBSERVED by one tick's active scan — the pure reconcile input. */
export interface ObservedSession {
  sessionId: string;
  agent: string;
  /** `local` when the session runs on this box, `ssh` when it's on a peer. */
  location: PresenceLocation;
  /** The device/host the session runs on (this box's hostname, or the peer). */
  device: string;
  /** Transport the session's provenance reports (`local` | `ssh` | ...). */
  transport: string;
  /** True for an interactive (terminal/tmux) session — a drop is reconnect-worthy;
   *  false for a headless remote continuation, where a drop means keep-alive. */
  interactive: boolean;
}

export interface PresenceRecord {
  sessionId: string;
  agent: string;
  location: PresenceLocation;
  device: string;
  transport: string;
  interactive: boolean;
  /** ms of the last tick this session was observed active. */
  lastSeenMs: number;
  status: PresenceStatus;
}

/** What the tick should do about a session that just flipped `disconnected`. */
export type PresenceAction = 'reconnect-nudge' | 'keep-alive' | 'none';

export interface PresenceTransition {
  record: PresenceRecord;
  from: PresenceStatus;
  to: PresenceStatus;
  action: PresenceAction;
}

/** A `disconnected` record older than this is pruned — the session is gone for
 *  good, not merely between clients. Kept generous so a long reconnect window
 *  (the reconnect loop's own bounded backoff) never drops a record mid-recovery. */
export const PRESENCE_TTL_MS = 30 * 60_000; // 30 minutes

/** `presence.json` under the watchdog state dir. `dir` is the watchdog state dir
 *  (the tick passes its own, overridable in tests); default is the real one. */
export function presenceFilePath(dir?: string): string {
  return path.join(dir ?? path.join(getRuntimeStateDir(), 'watchdog'), 'presence.json');
}

export function loadPresence(dir?: string): Record<string, PresenceRecord> {
  let raw: string;
  try {
    raw = fs.readFileSync(presenceFilePath(dir), 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, PresenceRecord>;
    }
  } catch {
    /* corrupt — degrade to empty, never throw into the tick */
  }
  return {};
}

export function savePresence(map: Record<string, PresenceRecord>, dir?: string): void {
  try {
    const file = presenceFilePath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(map), 'utf8');
  } catch {
    /* best-effort; a failed write just re-derives next tick */
  }
}

/** The subset of an `ActiveSession` the presence adapter reads (structural, so
 *  this module doesn't import the heavy active-session graph). */
interface ActiveSessionLike {
  sessionId?: string;
  kind: string;
  /** 'terminal' (interactive) | 'headless' | 'teams' | 'cloud' | ... */
  context: string;
  /** Set for a peer session by the fleet fan-out (`gatherRemoteActive`). */
  machine?: string;
  provenance?: { transport?: string };
}

/**
 * Map this tick's active sessions to presence observations. A session on a peer
 * carries `machine` (from the fleet fan-out) → `location: 'ssh'`; a local one →
 * `'local'`. `interactive` is true only for a `terminal` context (a tmux/terminal
 * session whose drop is reconnect-worthy) — headless/teams/cloud are not.
 * Sessions with no id are skipped (they can't be tracked or addressed).
 */
export function observedFromActive(
  sessions: ActiveSessionLike[],
  selfHost: string = os.hostname(),
): ObservedSession[] {
  const out: ObservedSession[] = [];
  for (const s of sessions) {
    if (!s.sessionId) continue;
    const location: PresenceLocation = s.machine ? 'ssh' : 'local';
    out.push({
      sessionId: s.sessionId,
      agent: s.kind,
      location,
      device: s.machine ?? selfHost,
      transport: s.provenance?.transport ?? location,
      interactive: s.context === 'terminal',
    });
  }
  return out;
}

/** The action for a session that just flipped to `disconnected`: an interactive
 *  session wants a reconnect nudge; a headless remote wants keep-alive; a local
 *  headless that vanished is simply gone (no action). */
export function actionFor(record: PresenceRecord): PresenceAction {
  if (record.status !== 'disconnected') return 'none';
  if (record.interactive) return 'reconnect-nudge';
  if (record.location === 'ssh') return 'keep-alive';
  return 'none';
}

/**
 * Pure state machine. Given the prior store, the sessions observed THIS tick, and
 * `nowMs`, return the next store plus the set of status transitions.
 *
 * - observed now                 -> `connected`, lastSeen = now (record refreshed)
 * - tracked but absent now       -> `disconnected` (lastSeen kept from prior tick)
 * - `disconnected` older than TTL -> pruned (gone for good)
 *
 * `transitions` carries only sessions whose status actually changed, each with
 * the action the tick should take — so the caller never re-nudges a session that
 * was already disconnected last tick.
 */
export function reconcilePresence(
  prev: Record<string, PresenceRecord>,
  observed: ObservedSession[],
  nowMs: number,
): { next: Record<string, PresenceRecord>; transitions: PresenceTransition[] } {
  const next: Record<string, PresenceRecord> = {};
  const transitions: PresenceTransition[] = [];
  const observedIds = new Set(observed.map((o) => o.sessionId));

  // 1. Everything observed this tick is connected.
  for (const o of observed) {
    const before = prev[o.sessionId];
    const record: PresenceRecord = {
      sessionId: o.sessionId,
      agent: o.agent,
      location: o.location,
      device: o.device,
      transport: o.transport,
      interactive: o.interactive,
      lastSeenMs: nowMs,
      status: 'connected',
    };
    next[o.sessionId] = record;
    if (before && before.status === 'disconnected') {
      transitions.push({ record, from: 'disconnected', to: 'connected', action: 'none' });
    }
  }

  // 2. Tracked-but-absent sessions flip to disconnected (or prune past TTL).
  for (const [id, before] of Object.entries(prev)) {
    if (observedIds.has(id)) continue;
    if (nowMs - before.lastSeenMs > PRESENCE_TTL_MS) continue; // prune: gone for good
    const record: PresenceRecord = { ...before, status: 'disconnected' };
    next[id] = record;
    if (before.status === 'connected') {
      transitions.push({
        record,
        from: 'connected',
        to: 'disconnected',
        action: actionFor(record),
      });
    }
  }

  return { next, transitions };
}
