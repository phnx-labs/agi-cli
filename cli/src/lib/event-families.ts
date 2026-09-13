/**
 * Event stream families — sessions-style --include / --exclude for the unified
 * event reader. One vocabulary maps onto existing filters (includeActivity,
 * eventTypes, level) so the engine stays single-path.
 */

import type { EventType, EventLevel } from './feed/events.js';
import type { UnifiedQuery } from './event-stream.js';

export const EVENT_FAMILIES = [
  'ops',
  'activity',
  'commands',
  'runs',
  'security',
] as const;

export type EventFamily = (typeof EVENT_FAMILIES)[number];

const FAMILY_SET: ReadonlySet<string> = new Set(EVENT_FAMILIES);

function isEventFamily(value: string): value is EventFamily {
  return FAMILY_SET.has(value);
}

/**
 * Parse a comma-separated family list. Throws on unknown names or empty list
 * after split (same discipline as sessions role lists).
 */
export function parseFamilyList(raw: string, flagName: string): EventFamily[] {
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`${flagName} requires at least one family: ${EVENT_FAMILIES.join(', ')}`);
  }
  const out: EventFamily[] = [];
  for (const p of parts) {
    if (!isEventFamily(p)) {
      throw new Error(`Unknown family ${JSON.stringify(p)} in ${flagName}. Use: ${EVENT_FAMILIES.join(', ')}`);
    }
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** Command-churn event kinds. */
const COMMAND_EVENT_TYPES: readonly EventType[] = ['command.start', 'command.end'];

/** Run-dispatch outcome kinds (replaces the separate audit/log.jsonl product). */
const RUN_EVENT_TYPES: readonly EventType[] = ['run.dispatched', 'run.launch', 'agent.run.end'];

/**
 * Fold family include/exclude into a UnifiedQuery.
 * Precedence: family narrows sources/types; field filters (module, event, …)
 * still apply on top.
 *
 * --include and --exclude are mutually exclusive at the CLI layer; this
 * function accepts only one of includeFamilies / excludeFamilies.
 */
export function applyFamilies(q: UnifiedQuery): UnifiedQuery {
  const include = q.includeFamilies;
  const exclude = q.excludeFamilies;
  if (include?.length && exclude?.length) {
    throw new Error('--include and --exclude are mutually exclusive');
  }
  if (!include?.length && !exclude?.length) return q;
  if (include?.length) return applyInclude(q, include);
  return applyExclude(q, exclude!);
}

function applyInclude(q: UnifiedQuery, families: EventFamily[]): UnifiedQuery {
  const has = (f: EventFamily) => families.includes(f);
  const typeSets: EventType[][] = [];
  let level: EventLevel | undefined = q.level;
  let includeActivity = false;
  let forceModule: string | undefined;

  // Source selection — multi-family include is a UNION of each family's rows.
  if (has('activity')) includeActivity = true;
  if (has('ops') || has('commands') || has('runs') || has('security')) {
    // ops path open (includeActivity stays true when activity is also listed)
  } else if (has('activity')) {
    // activity-only
    forceModule = q.module ?? 'activity';
    includeActivity = true;
  }
  // Default when include lists only type-scoping / ops / security: activity off
  // unless activity is listed.
  if (!has('activity') && (has('ops') || has('commands') || has('runs') || has('security'))) {
    includeActivity = false;
  }
  // include ops + activity explicitly
  if (has('ops') && has('activity')) includeActivity = true;

  if (has('commands')) typeSets.push([...COMMAND_EVENT_TYPES]);
  if (has('runs')) typeSets.push([...RUN_EVENT_TYPES]);
  if (has('security')) {
    if (!level) level = 'audit';
    // security without activity stays ops-only
    if (!has('activity')) includeActivity = false;
  }

  // Type-scoped families (commands / runs) only restrict eventTypes when no
  // broader ops-side family is in the include list. ops and security already
  // cover those kinds; AND-ing a type filter would shrink the union (e.g.
  // --include security,runs would drop secrets.get and keep only run.dispatched).
  const broadOps = has('ops') || has('security');
  let eventTypes = q.eventTypes ? [...q.eventTypes] : undefined;
  if (typeSets.length > 0 && !broadOps) {
    const union = new Set<EventType>();
    for (const set of typeSets) for (const t of set) union.add(t);
    if (eventTypes?.length) {
      // Intersect with --event; empty means no match (never silently widen).
      const allowed = new Set(eventTypes);
      eventTypes = [...union].filter((t) => allowed.has(t));
    } else {
      eventTypes = [...union];
    }
  }

  return {
    ...q,
    includeActivity,
    ...(forceModule != null ? { module: forceModule } : {}),
    ...(level ? { level } : {}),
    ...(eventTypes ? { eventTypes } : {}),
  };
}

function applyExclude(q: UnifiedQuery, families: EventFamily[]): UnifiedQuery {
  const has = (f: EventFamily) => families.includes(f);
  let includeActivity = q.includeActivity !== false;
  const excludeEventTypes: EventType[] = [...(q.excludeEventTypes ?? [])];
  let excludeLevel: EventLevel | undefined = q.excludeLevel;
  let forceModule: string | undefined;

  // Exclude ops first (→ activity-only), then activity (may clear the reopen).
  // --exclude ops,activity must not re-open activity after both sources are out.
  if (has('ops')) {
    forceModule = q.module ?? 'activity';
    includeActivity = true;
  }
  if (has('activity')) includeActivity = false;
  if (has('commands')) {
    for (const t of COMMAND_EVENT_TYPES) {
      if (!excludeEventTypes.includes(t)) excludeEventTypes.push(t);
    }
  }
  if (has('runs')) {
    for (const t of RUN_EVENT_TYPES) {
      if (!excludeEventTypes.includes(t)) excludeEventTypes.push(t);
    }
  }
  if (has('security')) excludeLevel = 'audit';

  return {
    ...q,
    includeActivity,
    ...(forceModule != null ? { module: forceModule } : {}),
    ...(excludeEventTypes.length ? { excludeEventTypes } : {}),
    ...(excludeLevel ? { excludeLevel } : {}),
  };
}

