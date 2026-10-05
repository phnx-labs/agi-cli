
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

const COMMAND_EVENT_TYPES: readonly EventType[] = ['command.start', 'command.end'];

const RUN_EVENT_TYPES: readonly EventType[] = ['run.dispatched', 'run.launch', 'agent.run.end'];

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

  if (has('activity')) includeActivity = true;
  if (has('ops') || has('commands') || has('runs') || has('security')) {
  } else if (has('activity')) {
    forceModule = q.module ?? 'activity';
    includeActivity = true;
  }
  if (!has('activity') && (has('ops') || has('commands') || has('runs') || has('security'))) {
    includeActivity = false;
  }
  if (has('ops') && has('activity')) includeActivity = true;

  if (has('commands')) typeSets.push([...COMMAND_EVENT_TYPES]);
  if (has('runs')) typeSets.push([...RUN_EVENT_TYPES]);
  if (has('security')) {
    if (!level) level = 'audit';
    if (!has('activity')) includeActivity = false;
  }

  const broadOps = has('ops') || has('security');
  let eventTypes = q.eventTypes ? [...q.eventTypes] : undefined;
  if (typeSets.length > 0 && !broadOps) {
    const union = new Set<EventType>();
    for (const set of typeSets) for (const t of set) union.add(t);
    if (eventTypes?.length) {
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
