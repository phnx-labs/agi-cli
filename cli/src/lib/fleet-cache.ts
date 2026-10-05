import { readHeadroomEntry } from './usage-refresh.js';
import { readFleetStatus as readFleetStatusMirror, type FleetStatusRow } from './fleet-status.js';

export function readFleetStatus(): Record<string, FleetStatusRow> {
  return readFleetStatusMirror();
}
export type { FleetStatusRow };

interface AccountHeadroom {
  status: 'available' | 'rate_limited' | null;
  minutesToLimit: number | null;
}

export function readAccountHeadroom(usageKey: string): AccountHeadroom | null {
  const entry = readHeadroomEntry(usageKey);
  if (!entry) return null;
  return { status: entry.status, minutesToLimit: entry.minutesToLimit };
}
