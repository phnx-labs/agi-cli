/** Semantic identity of a monitor: are two definitions the same watcher? The name is not its
 * identity (`writeMonitor` overwrites by name), so overlapping watchers once polled one PR queue
 * unnoticed. HASHED: source, interval, condition, action. NOT: name, `enabled`, placement. */

import { createHash } from 'crypto';
import type { MonitorConfig } from './config.js';

/** Stable JSON: object keys sorted so YAML key order can't change the hash. Cycle-safe: a recursive
 * YAML anchor makes a cyclic object that `validateMonitor` accepts; without the seen-set the
 * recursion blew the stack. A `Date` serializes to its ISO string (it collapsed to `{}`). */
function stable(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return value.map((v) => stable(v, seen));
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = stable(v, seen);
    }
    return out;
  }
  return value;
}

/** The behavioral identity of a monitor as a short hex digest: the same fingerprint means the same
 * watch and the same action on fire, whatever the name or pin. Pure, so the duplicate check is
 * unit-tested without a monitors dir. */
export function monitorFingerprint(
  config: Pick<MonitorConfig, 'source' | 'condition' | 'action'>,
): string {
  const identity = stable({
    source: config.source,
    condition: config.condition,
    action: config.action,
  });
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16);
}

/** The existing monitor this config would duplicate, or null. `existing` is the full set (user +
 * system), so duplicating a built-in is caught too. A same-NAME entry is a rewrite, reported
 * separately. Pure; the caller supplies the list. */
export function findDuplicateMonitor(
  config: Pick<MonitorConfig, 'name' | 'source' | 'condition' | 'action'>,
  existing: Array<Pick<MonitorConfig, 'name' | 'source' | 'condition' | 'action'>>,
): string | null {
  const fp = monitorFingerprint(config);
  for (const other of existing) {
    if (other.name === config.name) continue;
    if (monitorFingerprint(other) === fp) return other.name;
  }
  return null;
}
