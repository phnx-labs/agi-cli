/** The unified event reader: one stream over operational events (events.ts) and agent-semantic
 * events (per-session activity logs via activity.ts), sharing one {@link EventType} vocabulary and
 * {@link EventRecord} shape for `agents events`. */
import { query, type EventRecord, type EventType, type EventLevel, levelFor } from './feed/events.js';
import { readActivityAsEventRecords } from './feed/activity.js';
import { applyFamilies, type EventFamily } from './event-families.js';

export interface UnifiedQuery {
  startDate?: Date;
  endDate?: Date;
  eventTypes?: EventType[];
  /** Drop these event kinds after read (used by --exclude commands / runs). */
  excludeEventTypes?: EventType[];
  level?: EventLevel;
  /** Drop this level (used by --exclude security). */
  excludeLevel?: EventLevel;
  agent?: string;
  /** Only events stamped with this session id (payload `sessionId`, the provenance floor). */
  sessionId?: string;
  /** Only events carrying this bundle name in their payload (e.g. secrets events).
   * Combined with `sessionId`, answers "which session read this secrets bundle". */
  bundle?: string;
  caller?: string;
  command?: string;
  module?: string;
  limit?: number;
  /** Include agent-semantic activity events. Default true. */
  includeActivity?: boolean;
  /** Override the activity dir (tests). */
  activityRoot?: string;
  /** Sessions-style family filters (resolved via applyFamilies). */
  includeFamilies?: EventFamily[];
  excludeFamilies?: EventFamily[];
}

/** Apply the same filters query() applies, to an activity-derived record. */
function matches(r: EventRecord, q: UnifiedQuery): boolean {
  const ms = Date.parse(r.ts);
  // Mirror query()'s default upper bound (endDate = now) so both sources drop
  // future-dated records identically -- keeps the two in exact filter parity.
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

/** Read a unified, newest-first event stream: operational events from events.ts `query()`, activity
 * events normalized to the same shape and filtered identically. */
export function readUnifiedEvents(raw: UnifiedQuery = {}): EventRecord[] {
  const q = applyFamilies(raw);

  // `bundle` is filtered inside query()'s scan (before its limit cutoff) so a matching record
  // older than the newest-`limit` window is not dropped. Over-fetch when post-filtering
  // excludeEventTypes / excludeLevel so the top-N stays meaningful.
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

  // Activity events always stamp module: 'activity'. A non-activity module
  // filter can never match them — skip the activity scan entirely.
  if (q.module != null && q.module !== 'activity') {
    return typeof q.limit === 'number' ? ops.slice(0, q.limit) : ops;
  }

  // Push eventTypes into the activity reader so `limit` applies after the event-type filter;
  // otherwise a rare match older than the newest-`limit` window is dropped, the same bug class as
  // the ops-side bundle pre-filter (RUSH-2093). Other filters still run via matches().
  const acts = readActivityAsEventRecords({
    sinceMs: q.startDate?.getTime(),
    limit: fetchLimit,
    root: q.activityRoot,
    events: q.eventTypes,
  }).filter((r) => matches(r, q));

  const merged = [...ops, ...acts].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return typeof q.limit === 'number' ? merged.slice(0, q.limit) : merged;
}
