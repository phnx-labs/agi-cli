import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { getCacheDir } from '../state.js';
import { assertValidSshTarget } from '../ssh-exec.js';
import { parseKnownHosts } from '../hosts/ssh-config.js';
import { hostNameFor } from './ssh-config.js';
import type { DeviceProfile } from './registry.js';

export function managedKnownHostsPath(): string {
  return path.join(getCacheDir(), 'devices', 'known_hosts');
}

export function ensureManagedKnownHostsDir(file = managedKnownHostsPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
}

function readManagedKnownHosts(file = managedKnownHostsPath()): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

export function isHostPinnedIn(content: string, host: string): boolean {
  const needle = host.trim().toLowerCase();
  if (!needle) return false;
  return parseKnownHosts(content).some((h) => h.toLowerCase() === needle);
}

export function isHostPinned(host: string, file = managedKnownHostsPath()): boolean {
  return isHostPinnedIn(readManagedKnownHosts(file), host);
}

export function isDevicePinned(
  device: DeviceProfile,
  isPinned: (host: string) => boolean = (host) => isHostPinned(host),
): boolean {

  const host = device.address ? hostNameFor(device) : undefined;
  return (host != null && isPinned(host)) || isPinned(device.name);
}

export function hostKeyCheckingOpts(pinned: boolean, file = managedKnownHostsPath()): string[] {

  return [
    '-o', `UserKnownHostsFile=${file}`,
    '-o', `StrictHostKeyChecking=${pinned ? 'yes' : 'accept-new'}`,
  ];
}

export function newKnownHostsLines(existing: string, scanned: string): string[] {
  const have = new Set(existing.split('\n').map((l) => l.trim()).filter(Boolean));
  const seen = new Set<string>();
  const fresh: string[] = [];
  for (const raw of scanned.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || have.has(line) || seen.has(line)) continue;
    seen.add(line);
    fresh.push(line);
  }
  return fresh;
}

interface PinResult {
  pinned: boolean;
  added: number;
}

export function recordScannedKeys(host: string, scanned: string, file = managedKnownHostsPath()): PinResult {
  ensureManagedKnownHostsDir(file);
  const existing = readManagedKnownHosts(file);
  const fresh = newKnownHostsLines(existing, scanned);
  if (fresh.length > 0) {
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(file, prefix + fresh.join('\n') + '\n', { mode: 0o600 });
  }
  return { pinned: isHostPinned(host, file), added: fresh.length };
}

function pinHostKey(
  host: string,
  opts: { file?: string; timeoutMs?: number; port?: number } = {},
): PinResult {
  assertValidSshTarget(host);
  const file = opts.file ?? managedKnownHostsPath();
  const timeoutMs = opts.timeoutMs ?? 8000;
  ensureManagedKnownHostsDir(file);

  const args = ['-T', String(Math.max(1, Math.ceil(timeoutMs / 1000)))];
  if (opts.port) args.push('-p', String(opts.port));
  args.push(host);
  const res = spawnSync('ssh-keyscan', args, { encoding: 'utf-8', timeout: timeoutMs });
  if (res.status !== 0 || !res.stdout) {
    return { pinned: isHostPinned(host, file), added: 0 };
  }

  return recordScannedKeys(host, res.stdout, file);
}
