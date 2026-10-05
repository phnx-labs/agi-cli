import { query, type EventRecord, type EventType, type EventLevel, levelFor } from './feed/events.js';
import { readActivityAsEventRecords } from './feed/activity.js';
import { applyFamilies, type EventFamily } from './event-families.js';

export interface UnifiedQuery {
  startDate?: Date;
  endDate?: Date;
  eventTypes?: EventType[];
  excludeEventTypes?: EventType[];
  level?: EventLevel;
  excludeLevel?: EventLevel;
  agent?: string;
  sessionId?: string;
  bundle?: string;
  caller?: string;
  command?: string;
  module?: string;
  limit?: number;
  includeActivity?: boolean;
  activityRoot?: string;
  includeFamilies?: EventFamily[];
  excludeFamilies?: EventFamily[];
}

function matches(r: EventRecord, q: UnifiedQuery): boolean {
  const ms = Date.parse(r.ts);
  const endMs = (q.endDate ?? new Date()).getTime();
  if (q.startDate && !Number.isNaN(ms) && ms < q.startDate.getTime()) return false;
  if (!Number.isNaN(ms) && ms > endMs) return false;
  if (q.eventTypes && !q.eventTypes.includes(r.event)) return false;
  if (q.excludeEventTypes?.includes(r.event)) return false;
  const lvl = r.level ?? levelFor(r.event);
  if (q.level && lvl !== q.level) return false;
  if (q.excludeLevel && lvl === q.excludeLevel) return false;
  if (q.agent && r.agent !== q.agent) return false;
  if (q.sessionId && r.sessionId !== q.sessionId) return false;
  if (q.bundle && r.bundle !== q.bundle) return false;
  if (q.caller && r.caller !== q.caller) return false;
  if (q.command && r.command !== q.command &&
      !(typeof r.command === 'string' && r.command.startsWith(q.command + ' '))) return false;
  if (q.module && r.module !== q.module) return false;
  return true;
}

export function readUnifiedEvents(raw: UnifiedQuery = {}): EventRecord[] {
  const q = applyFamilies(raw);

  const needsPost = Boolean(q.excludeEventTypes?.length || q.excludeLevel);
  const fetchLimit = q.limit === undefined
    ? undefined
    : needsPost
      ? Math.min(q.limit * 4, q.limit + 500)
      : q.limit;

  const ops = query({
    startDate: q.startDate,
    endDate: q.endDate,
    eventTypes: q.eventTypes,
    level: q.level,
    agent: q.agent,
    sessionId: q.sessionId,
    caller: q.caller,
    command: q.command,
    module: q.module,
    bundle: q.bundle,
    limit: fetchLimit,
  }).filter((r) => matches(r, q));

  if (q.includeActivity === false) {
    return typeof q.limit === 'number' ? ops.slice(0, q.limit) : ops;
  }

  if (q.module != null && q.module !== 'activity') {
    return typeof q.limit === 'number' ? ops.slice(0, q.limit) : ops;
  }

  const acts = readActivityAsEventRecords({
    sinceMs: q.startDate?.getTime(),
    limit: fetchLimit,
    root: q.activityRoot,
    events: q.eventTypes,
  }).filter((r) => matches(r, q));

  const merged = [...ops, ...acts].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return typeof q.limit === 'number' ? merged.slice(0, q.limit) : merged;
}
