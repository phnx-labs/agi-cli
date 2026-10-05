import type { EventRecord } from './feed/events.js';

interface RepeatedGuardBlockFinding {
  session: string;
  surface: string;
  failureId: string;
  count: number;
  firstTs: string;
  lastTs: string;
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function detectRepeatedGuardBlocks(
  events: EventRecord[],
  opts: { minRepeats?: number } = {},
): RepeatedGuardBlockFinding[] {
  const minRepeats = opts.minRepeats ?? 3;
  const groups = new Map<string, EventRecord[]>();

  for (const e of events) {
    if (e.event !== 'friction') continue;
    const surface = asNonEmptyString(e.surface);
    const failureId = asNonEmptyString(e.failureId);
    if (!surface || !failureId) continue;
    const session = e.session ?? 'unknown';
    const key = `${session}\0${surface}\0${failureId}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(e);
    else groups.set(key, [e]);
  }

  const out: RepeatedGuardBlockFinding[] = [];
  for (const [key, evs] of groups) {
    if (evs.length < minRepeats) continue;
    const [session, surface, failureId] = key.split('\0');
    const sortedTs = evs.map((e) => e.ts).sort();
    out.push({
      session,
      surface,
      failureId,
      count: evs.length,
      firstTs: sortedTs[0],
      lastTs: sortedTs[sortedTs.length - 1],
    });
  }

  out.sort((a, b) => b.count - a.count);
  return out;
}
