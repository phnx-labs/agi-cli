/**
 * Cheap heuristic readers over the `friction` event sink (emitFriction in
 * events.ts). Guard hooks (git-guard, rm-guard, git-require-clean-tree) call
 * `agents _internal friction --surface guard --id <failureId>` when they block
 * a destructive command, so it exists in the log — but nothing reads it back
 * yet. This is a starting point: one detector for the most actionable pattern,
 * an agent stuck retrying the SAME denied action instead of adapting.
 */
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

/**
 * Group `friction` events by (session, surface, failureId) and flag groups
 * that repeat at least `minRepeats` times — the signature of an agent hitting
 * the same guard over and over rather than changing approach after the first
 * block. `events` is expected to already be filtered/queried for
 * `eventTypes: ['friction']` (see events.ts `query()`); non-friction records
 * are ignored defensively rather than assumed absent.
 */
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
