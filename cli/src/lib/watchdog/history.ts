import type { WatchdogEvent, WatchdogEventKind } from './log.js';

interface WatchdogHistoryEntry {
  ts: number;
  kind: WatchdogEventKind | 'inspection';
  sessionId?: string;
  agent?: string;
  message: string;
  reason?: string;
  stalledForMs?: number;
  nudgeText?: string;
}

interface WatchdogHistoryOptions {
  limit?: number;
  sinceMs?: number;
  sessionId?: string;
  includeTicks?: boolean;
  nowMs?: number;
}

/** Select newest history and deliberately remove raw transcript tailLines. */
export function selectWatchdogHistory(
  events: WatchdogEvent[],
  options: WatchdogHistoryOptions = {},
): WatchdogHistoryEntry[] {
  const limit = options.limit ?? 50;
  const cutoff = options.sinceMs === undefined
    ? Number.NEGATIVE_INFINITY
    : (options.nowMs ?? Date.now()) - options.sinceMs;
  const session = options.sessionId?.toLowerCase();

  const expanded = events.flatMap((event): WatchdogHistoryEntry[] => {
    const inspections = event.inspections?.map((inspection) => ({
      ts: event.ts,
      kind: 'inspection' as const,
      sessionId: inspection.terminalId,
      agent: inspection.agentType,
      message: inspection.message,
      reason: inspection.reason,
      stalledForMs: inspection.stalledForMs,
    })) ?? [];
    if (event.kind === 'tick' && !options.includeTicks) return inspections;
    return [...inspections, {
      ts: event.ts,
      kind: event.kind,
      sessionId: event.terminalId,
      agent: event.agentType,
      message: event.message,
      reason: event.reason,
      stalledForMs: event.stalledForMs,
      nudgeText: event.nudgeText,
    }];
  });

  const matching = expanded
    .filter((entry) => entry.ts >= cutoff)
    .filter((entry) => !session || entry.sessionId?.toLowerCase().startsWith(session))
    .sort((a, b) => b.ts - a.ts);
  if (matching.length <= limit) return matching;

  // A busy tick can contain more inspections than the display limit. Keep the
  // newest timeline, but reserve one row for the newest real action.
  const newest = matching.slice(0, limit);
  if (newest.some((entry) => entry.kind !== 'inspection')) return newest;
  const newestAction = matching.find((entry) => entry.kind !== 'inspection');
  if (!newestAction) return newest;
  return [...newest.slice(0, limit - 1), newestAction].sort((a, b) => b.ts - a.ts);
}
