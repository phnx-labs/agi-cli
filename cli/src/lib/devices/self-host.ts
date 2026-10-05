/** "Is this hostname the local machine?", matched against every identity the box answers to, not
 * just its short id. Callers using the tailscale MagicDNS name used to self-SSH, and on a loaded
 * box `doctor --json` orphaned on timeout and piled up (RUSH-2114). */
import { machineId } from '../machine-id.js';
import { loadDevicesSync } from './registry.js';

const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

/** Lowercase + strip a trailing dot (FQDNs are equivalent with or without it). */
function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '');
}

let cached: Set<string> | null = null;

/** Every name that resolves to this machine: short id, loopback, and the self device's tailscale
 * dnsName plus short form. Computed once per process; the registry is read best-effort (an
 * unreadable one still leaves the short id and loopback). */
function selfAliases(): Set<string> {
  if (cached) return cached;
  const aliases = new Set<string>([machineId(), ...LOOPBACK]);
  try {
    const dns = loadDevicesSync()[machineId()]?.address?.dnsName;
    if (dns) {
      const d = normalize(dns);
      aliases.add(d);
      aliases.add(d.split('.')[0]); // the short form of the FQDN
    }
  } catch {
    /* registry unreadable — the short id + loopback aliases still hold */
  }
  cached = aliases;
  return cached;
}

/** True when `name` refers to the local machine (case-insensitive, trailing-dot-tolerant). Use
 * wherever a `--device`/fleet target is compared to "self", so a tailscale-name reference runs
 * locally instead of self-SSHing. */
export function isSelfHost(name: string | undefined | null): boolean {
  if (!name) return false;
  const n = normalize(name);
  return n.length > 0 && selfAliases().has(n);
}

/** Test hook: drop the memoized alias set so a fresh registry/env is re-read. */
export function resetSelfHostCache(): void {
  cached = null;
}
