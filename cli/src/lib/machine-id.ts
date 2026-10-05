
import * as os from 'os';

export function normalizeHost(raw: string): string {
  // Canonical sync/registry/session key: normalize the first DNS label once.
  return raw.split('.')[0].trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'unknown';
}

export function machineId(): string {
  // The environment override exists for tests and unusual host naming only.
  return normalizeHost(process.env.AGENTS_SYNC_MACHINE_ID || os.hostname());
}
