/** This machine's stable, human-readable id, in a dependency-free leaf so low-level modules
 * (state.ts) can use it without importing the secrets/session-sync layer (a cycle). */

import * as os from 'os';

/** Normalizes a hostname to a device id: first label, lowercased, non-alphanumerics to hyphens
 * (`zion.tail...ts.net` and `ZION` both give `zion`). The single source: machineId() and session
 * grouping must agree. */
export function normalizeHost(raw: string): string {
  return raw.split('.')[0].trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'unknown';
}

/** This machine's id: R2 sync prefix, session mirror dir, `agents devices` self-key and per-device
 * config folder. Tailnet hostnames are already unique; lowercased with the domain stripped.
 * Override with AGENTS_SYNC_MACHINE_ID. */
export function machineId(): string {
  return normalizeHost(process.env.AGENTS_SYNC_MACHINE_ID || os.hostname());
}
