import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRuntimeStateDir } from '../state.js';

export type PresenceStatus = 'connected' | 'disconnected';
export type PresenceLocation = 'local' | 'ssh';

export interface ObservedSession {
  sessionId: string;
  agent: string;
  location: PresenceLocation;
  device: string;
  transport: string;
  interactive: boolean;
}

export interface PresenceRecord {
  sessionId: string;
  agent: string;
  location: PresenceLocation;
  device: string;
  transport: string;
  interactive: boolean;
  lastSeenMs: number;
  status: PresenceStatus;
}

export type PresenceAction = 'reconnect-nudge' | 'keep-alive' | 'none';

export interface PresenceTransition {
  record: PresenceRecord;
  from: PresenceStatus;
  to: PresenceStatus;
  action: PresenceAction;
}

export const PRESENCE_TTL_MS = 30 * 60_000;

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
  }
  return {};
}

export function savePresence(map: Record<string, PresenceRecord>, dir?: string): void {
  try {
    const file = presenceFilePath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(map), 'utf8');
  } catch {
  }
}

interface ActiveSessionLike {
  sessionId?: string;
  kind: string;
  context: string;
  machine?: string;
  provenance?: { transport?: string };
}

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

export function actionFor(record: PresenceRecord): PresenceAction {
  if (record.status !== 'disconnected') return 'none';
  if (record.interactive) return 'reconnect-nudge';
  if (record.location === 'ssh') return 'keep-alive';
  return 'none';
}

export function reconcilePresence(
  prev: Record<string, PresenceRecord>,
  observed: ObservedSession[],
  nowMs: number,
): { next: Record<string, PresenceRecord>; transitions: PresenceTransition[] } {
  const next: Record<string, PresenceRecord> = {};
  const transitions: PresenceTransition[] = [];
  const observedIds = new Set(observed.map((o) => o.sessionId));

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

  for (const [id, before] of Object.entries(prev)) {
    if (observedIds.has(id)) continue;
    if (nowMs - before.lastSeenMs > PRESENCE_TTL_MS) continue;
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
