
import { createHash } from 'crypto';
import type { MonitorConfig } from './config.js';

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
