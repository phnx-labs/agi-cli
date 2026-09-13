/**
 * Managed known_hosts pinning for the device fleet (RUSH-1767).
 *
 * The shared SSH baseline uses `StrictHostKeyChecking=accept-new`
 * (trust-on-first-use): it silently accepts whatever key answers on the FIRST
 * connect, so a machine-in-the-middle present in that window is trusted forever
 * and never re-checked. This module gives the CLI its own known_hosts store,
 * kept apart from the user's `~/.ssh/known_hosts`, so a device's host key can be
 * *pinned*: once a key is recorded here, connections verify against it with
 * `StrictHostKeyChecking=yes`, so a later key swap is refused instead of
 * silently re-accepted.
 *
 * The learn-then-pin flow: the first `agents ssh`/fleet connection to a host is
 * still `accept-new`, but it writes the learned key into THIS store, which pins
 * it for every subsequent connect. Credential copies (`run --device --copy-creds`)
 * refuse to run against a host that isn't pinned here — see
 * `commands/exec.ts` — so tokens never ride an unverified first connect.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { getCacheDir } from '../state.js';
import { assertValidSshTarget } from '../ssh-exec.js';
import { parseKnownHosts } from '../hosts/ssh-config.js';
import { hostNameFor } from './ssh-config.js';
import type { DeviceProfile } from './registry.js';

/** Path to the CLI-managed known_hosts store (created lazily, mode 0600). */
export function managedKnownHostsPath(): string {
  return path.join(getCacheDir(), 'devices', 'known_hosts');
}

/** Ensure the parent directory of the managed store exists (mode 0700). */
export function ensureManagedKnownHostsDir(file = managedKnownHostsPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
}

/** Read the managed store, or '' when it does not exist yet. */
function readManagedKnownHosts(file = managedKnownHostsPath()): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * True if `host` has at least one pinned key line in `content`. Pure (content
 * in) so the match logic is unit-testable without touching disk. Matching is
 * case-insensitive on the hostname, as OpenSSH does.
 */
export function isHostPinnedIn(content: string, host: string): boolean {
  const needle = host.trim().toLowerCase();
  if (!needle) return false;
  return parseKnownHosts(content).some((h) => h.toLowerCase() === needle);
}

/** True if `host` is pinned in the managed store on disk. */
export function isHostPinned(host: string, file = managedKnownHostsPath()): boolean {
  return isHostPinnedIn(readManagedKnownHosts(file), host);
}

/**
 * True if a DEVICE's host key is pinned — checked against the SAME host string
 * the ssh connection dials (`hostNameFor(device)`: the Tailscale dnsName/IP that
 * `sshTargetFor` resolves), falling back to the bare device name.
 *
 * A device discovered over the tailnet is pinned under its FQDN
 * (`yosemite-m6.tail….ts.net`), so a caller that checks the bare `device.name`
 * misses the pin and wrongly treats a reachable, pinned peer as unpinned —
 * silently excluding it from usage/auth fan-out while ssh to it would have
 * succeeded (PHNX-3505). Accepting the bare name too keeps a device pinned only
 * under its short name working. `isPinned` is injectable for tests; it defaults
 * to the managed on-disk store.
 */
export function isDevicePinned(
  device: DeviceProfile,
  isPinned: (host: string) => boolean = (host) => isHostPinned(host),
): boolean {
  const host = device.address ? hostNameFor(device) : undefined;
  return (host != null && isPinned(host)) || isPinned(device.name);
}

/**
 * The host-key-checking ssh options for a connection.
 *
 * Always points `UserKnownHostsFile` at the managed store so learned and pinned
 * keys live in exactly one CLI-owned file. `StrictHostKeyChecking` is `yes` once
 * the host is pinned (a key swap is refused) and `accept-new` before that
 * (genuine first enrollment learns the key into the managed store, which pins it
 * for every subsequent connect). Pure given `pinned`, so the policy is testable.
 */
export function hostKeyCheckingOpts(pinned: boolean, file = managedKnownHostsPath()): string[] {
  return [
    '-o', `UserKnownHostsFile=${file}`,
    '-o', `StrictHostKeyChecking=${pinned ? 'yes' : 'accept-new'}`,
  ];
}

/**
 * The key lines in `scanned` (ssh-keyscan output) not already present in
 * `existing`. Comments and blank lines are dropped; whitespace is normalized so
 * a re-scan of an already-pinned key is a no-op. Pure, so the idempotent-append
 * contract is unit-testable without spawning ssh-keyscan.
 */
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
  /** True if the host is pinned in the managed store after this call. */
  pinned: boolean;
  /** How many new key lines were appended. */
  added: number;
}

/**
 * Merge `ssh-keyscan` output for `host` into the managed store at `file`,
 * idempotently, and report whether `host` is pinned afterward. Split out from
 * {@link pinHostKey} so the store-write half — the part that decides a scanned
 * key now counts as pinned — is unit-testable with real keyscan text and no
 * network (the spawn stays in `pinHostKey`).
 */
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

/**
 * `ssh-keyscan` a host at a trusted moment and append any new key lines to the
 * managed store, idempotently. This is the explicit pin path; the implicit one
 * is a normal `accept-new` connection whose learned key lands in the same store.
 * Returns whether the host is pinned afterward.
 *
 * Host-name-agnostic: it scans whatever address it is handed, so it also pins a
 * host `agents ssh` can't reach — notably a bare `~/.ssh/config` `Host` alias,
 * which is not a registered device. The `--copy-creds` gate (commands/exec.ts)
 * calls this for exactly that case so the credential copy is usable for
 * ssh-config-alias hosts (RUSH-1767).
 */
function pinHostKey(
  host: string,
  opts: { file?: string; timeoutMs?: number; port?: number } = {},
): PinResult {
  // Same injection guard as sshExec: a host starting with `-` (or carrying shell
  // metacharacters) must never reach ssh-keyscan as a bare argv where it could
  // be parsed as a flag.
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
