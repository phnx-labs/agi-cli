/** Cheap heuristic readers over the `friction` event sink (emitFriction). Guard hooks log a
 * friction event when they block a destructive command but nothing read it back; this adds one
 * detector: an agent retrying the same denied action instead of adapting. */
import type { EventRecord } from './feed/events.js';

interface RepeatedGuardBlockFinding {
  /** Session id the repeated blocks happened in, or 'unknown' when the
   *  friction event carried no session (e.g. a guard fired outside any
   *  tracked agent session). */
  session: string;
  surface: string;
  failureId: string;
  /** Number of times this exact (session, surface, failureId) blocked. */
  count: number;
  firstTs: string;
  lastTs: string;
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Groups `friction` events by (session, surface, failureId) and flags groups repeating at least
 * `minRepeats` times: an agent hitting the same guard instead of changing approach. `events`
 * should be pre-filtered to `eventTypes: ['friction']`; non-friction records are ignored. */
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
