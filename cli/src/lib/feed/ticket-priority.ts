/**
 * The Linear priority of a session's ticket, for attention urgency (PHNX-4369).
 *
 * Reads are synchronous and served from disk (the reconciler is synchronous);
 * a missing or older-than-TTL entry starts ONE background `linear tasks <id>
 * --json` for that ticket and the answer lands on a later reconcile. So an
 * open ask costs at most one Linear read per ticket per TTL, never one per tick,
 * and a box without a signed-in `linear` CLI records "unknown" (null) for the
 * TTL instead of retrying every pass.
 */

import { isRateLimited, readCached, writeCached } from '../linear-cache.js';
import { linearExec, type LinearExec } from '../quick-todo.js';

export const TICKET_PRIORITY_TTL_MS = 30 * 60_000;

const inFlight = new Set<string>();

function cacheKey(ticketId: string): string {
  return `issue-${ticketId}`;
}

export async function refreshTicketPriority(ticketId: string, nowMs: number, linear: LinearExec = linearExec): Promise<number | null> {
  let priority: number | null = null;
  try {
    const issue = JSON.parse((await linear(['tasks', ticketId, '--json'])).stdout) as { priority?: unknown };
    priority = typeof issue.priority === 'number' ? issue.priority : null;
  } catch {
    priority = null;
  }
  writeCached<number | null>(cacheKey(ticketId), priority, nowMs);
  return priority;
}

export function cachedTicketPriority(ticketId: string | undefined, nowMs: number, linear: LinearExec = linearExec): number | undefined {
  if (!ticketId) return undefined;
  const hit = readCached<number | null>(cacheKey(ticketId), nowMs);
  if ((!hit || hit.ageMs > TICKET_PRIORITY_TTL_MS) && !inFlight.has(ticketId) && !isRateLimited(nowMs)) {
    inFlight.add(ticketId);
    void refreshTicketPriority(ticketId, nowMs, linear).finally(() => inFlight.delete(ticketId));
  }
  return typeof hit?.value === 'number' ? hit.value : undefined;
}
