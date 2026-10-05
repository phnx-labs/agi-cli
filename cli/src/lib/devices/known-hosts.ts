/** Managed known_hosts pinning (RUSH-1767). The baseline `accept-new` (TOFU) trusts a
 * machine-in-the-middle on first connect forever. This CLI-owned store lets a key be pinned, so
 * later connections use `StrictHostKeyChecking=yes` and a key swap is refused. */
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

/** True if `host` has at least one pinned key line in `content`. Pure so matching is testable
 * without disk; hostname match is case-insensitive, as in OpenSSH. */
export function isHostPinnedIn(content: string, host: string): boolean {
  const needle = host.trim().toLowerCase();
  if (!needle) return false;
  return parseKnownHosts(content).some((h) => h.toLowerCase() === needle);
}

export function isHostPinned(host: string, file = managedKnownHostsPath()): boolean {
  return isHostPinnedIn(readManagedKnownHosts(file), host);
}

/** True if a device's host key is pinned, checked against the host string ssh dials
 * (`hostNameFor(device)`), falling back to the bare name. A tailnet device is pinned under its
 * FQDN, so checking only `device.name` would wrongly drop a pinned peer (PHNX-3505). */
export function isDevicePinned(
  device: DeviceProfile,
  isPinned: (host: string) => boolean = (host) => isHostPinned(host),
): boolean {
  // Enrollment keys follow the dial address; accept the legacy device-name pin while registries converge.
  const host = device.address ? hostNameFor(device) : undefined;
  return (host != null && isPinned(host)) || isPinned(device.name);
}

/** The host-key-checking ssh options: always point `UserKnownHostsFile` at the managed store so
 * learned and pinned keys live in one CLI-owned file; `StrictHostKeyChecking` is `yes` once pinned
 * (a swap is refused), `accept-new` before (first enrollment learns the key). Pure given `pinned`. */
export function hostKeyCheckingOpts(pinned: boolean, file = managedKnownHostsPath()): string[] {
  // The first dial enrolls a key; every later dial must match the enrolled key exactly.
  return [
    '-o', `UserKnownHostsFile=${file}`,
    '-o', `StrictHostKeyChecking=${pinned ? 'yes' : 'accept-new'}`,
  ];
}

/** The key lines in `scanned` (ssh-keyscan output) not already in `existing`. Comments and blanks
 * are dropped and whitespace normalized, so re-scanning a pinned key is a no-op. Pure. */
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

/** Merge `ssh-keyscan` output for `host` into the managed store at `file`, idempotently, and report
 * whether `host` is pinned. Split from {@link pinHostKey} so the store-write half is unit-testable
 * with real keyscan text and no network. */
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

/** `ssh-keyscan` a host at a trusted moment and append new key lines to the managed store,
 * idempotently; returns whether the host is pinned. The explicit pin path; the implicit one is an
 * `accept-new` connection. Also pins a bare `~/.ssh/config` alias for `--copy-creds` (RUSH-1767). */
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
