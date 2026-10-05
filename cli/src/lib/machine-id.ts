
import * as os from 'os';

export function normalizeHost(raw: string): string {
  return raw.split('.')[0].trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'unknown';
}

export function machineId(): string {
  return normalizeHost(process.env.AGENTS_SYNC_MACHINE_ID || os.hostname());
}
