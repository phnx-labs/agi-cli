import * as fs from 'node:fs';
import * as path from 'node:path';
import { leadRoot } from './paths.js';

const LEAD_CWD_RE = /[\\/]\.agents[\\/]lead(?:[\\/]|$)/;

export interface LeadCandidate {
  lead?: boolean;
  cwd?: string | null;
  sessionId?: string | null;
}

export function isLeadCwd(cwd: string | null | undefined): boolean {
  return typeof cwd === 'string' && LEAD_CWD_RE.test(cwd);
}

export function leadSessionIds(root: string = leadRoot()): Set<string> {
  const ids = new Set<string>();
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ids;
    throw err;
  }
  for (const name of names) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(root, name, 'session.json'), 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw err;
    }
    const id = (JSON.parse(raw) as { sessionId?: unknown }).sessionId;
    if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

export function isLeadSession(row: LeadCandidate, hostSessionIds: ReadonlySet<string>): boolean {
  if (row.lead === true || isLeadCwd(row.cwd)) return true;
  return typeof row.sessionId === 'string' && hostSessionIds.has(row.sessionId);
}

export function markLeadSessions<T extends LeadCandidate>(rows: T[], hostSessionIds: ReadonlySet<string> = leadSessionIds()): T[] {
  for (const row of rows) if (isLeadSession(row, hostSessionIds)) row.lead = true;
  return rows;
}

export function withoutLeadSessions<T extends LeadCandidate>(rows: T[], hostSessionIds: ReadonlySet<string> = leadSessionIds()): T[] {
  return rows.filter((row) => !isLeadSession(row, hostSessionIds));
}

type RowEnvelope<R> =
  | { type: 'reset'; rows: R[] }
  | { type: 'upsert'; rowKey: string; row: R };

export function hideLeadInSessionEnvelope<E extends { type: string }>(event: E, hostSessionIds: ReadonlySet<string>): E {
  const e = event as unknown as RowEnvelope<LeadCandidate & { rowKey?: string }> & Record<string, unknown>;
  if (e.type === 'reset') return { ...event, rows: e.rows.filter((r) => !isLeadSession(r, hostSessionIds)) } as E;
  if (e.type === 'upsert' && isLeadSession(e.row, hostSessionIds)) {
    const { row: _row, ...rest } = e as unknown as Record<string, unknown>;
    return { ...rest, type: 'remove' } as unknown as E;
  }
  return event;
}

export function hideLeadInFeedEnvelope<E extends { type: string }>(event: E, hostSessionIds: ReadonlySet<string>): E {
  const e = event as unknown as Record<string, unknown> & { type: string };
  if (e.type === 'reset') {
    const agents = (e.agents as LeadCandidate[] | undefined) ?? [];
    const attention = (e.attention as Array<{ sessionId?: string }> | undefined) ?? [];
    const hidden = new Set(agents.filter((a) => isLeadSession(a, hostSessionIds)).map((a) => a.sessionId).filter(Boolean));
    return {
      ...event,
      agents: agents.filter((a) => !isLeadSession(a, hostSessionIds)),
      attention: attention.filter((a) => !a.sessionId || !hidden.has(a.sessionId)),
    } as E;
  }
  if (e.type === 'agent.upsert' && isLeadSession(e.agent as LeadCandidate, hostSessionIds)) {
    const { agent: _agent, ...rest } = e;
    return { ...rest, type: 'agent.remove' } as unknown as E;
  }
  return event;
}
