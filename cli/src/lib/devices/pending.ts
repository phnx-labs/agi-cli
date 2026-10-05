/** "Pending device" sentinels: when the daemon's tailscale probe finds a node neither registered
 * nor ignored, it drops a file under ~/.agents/.cache/state/devices-pending/ that the Swift helper
 * polls for "NEW DEVICES". The daemon owns writes; `devices register|ignore` clears one at once. */
import * as fs from 'fs';
import * as path from 'path';
import { getDevicesPendingDir } from '../state.js';
import { loadDevices, loadIgnored } from './registry.js';

export interface PendingDevice {
  name: string;
  platform: string;
}

function isSafeName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

/** Best-effort load of names that must never appear as "NEW DEVICES": the ignore-list and the
 * registered roster. A corrupted registry/ignore file (both throw by design) must not crash the
 * daemon loop, so treat it as empty and recover on the next probe. */
async function loadDismissedNames(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    for (const name of await loadIgnored()) out.add(name);
  } catch {  }
  try {
    for (const name of Object.keys(await loadDevices())) out.add(name);
  } catch {  }
  return out;
}

/** Drop pending sentinels for devices already registered or ignored. Safe without a live tailscale
 * probe, since it only removes names known not to be new; used when discovery cannot recompute the
 * pending set, so a leak or race cannot leave registered boxes in NEW DEVICES forever. */
export async function pruneDismissedPendingSentinels(): Promise<void> {
  const dir = getDevicesPendingDir();
  const dismissed = await loadDismissedNames();
  if (dismissed.size === 0) return;
  let existing: string[];
  try {
    existing = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return;
  }
  for (const name of existing) {
    if (!dismissed.has(name)) continue;
    try { fs.unlinkSync(path.join(dir, name)); } catch {  }
  }
}

/** Make the sentinel dir exactly match `pending`, deleting leftovers. Best-effort: a filesystem
 * error must never crash the daemon. As the single choke point for every discovery path, it
 * re-subtracts the ignore-list and registered roster rather than trusting `pending` (RUSH-2495). */
export async function reconcilePendingSentinels(pending: PendingDevice[]): Promise<void> {
  const dir = getDevicesPendingDir();
  // Re-read registry and ignore state at write time to close the probe-versus-dismiss race.
  const dismissed = await loadDismissedNames();
  const want = new Map(
    pending
      .filter((p) => isSafeName(p.name) && !dismissed.has(p.name))
      .map((p) => [p.name, p.platform]),
  );

  let existing: string[];
  try {
    fs.mkdirSync(dir, { recursive: true });
    existing = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    // Sentinels are daemon hints; filesystem failure must not stop discovery.
    return;
  }

  for (const name of existing) {
    if (!want.has(name)) {
      try { fs.unlinkSync(path.join(dir, name)); } catch {  }
    }
  }
  for (const [name, platform] of want) {
    const p = path.join(dir, name);
    const body = `${platform}\n`;
    let current: string | null = null;
    try { current = fs.readFileSync(p, 'utf-8'); } catch { current = null; }
    if (current !== body) {
      try { fs.writeFileSync(p, body); } catch {  }
    }
  }
}

export function clearPendingSentinel(name: string): void {
  if (!isSafeName(name)) return;
  try { fs.unlinkSync(path.join(getDevicesPendingDir(), name)); } catch {  }
}

export function readPendingSentinels(): PendingDevice[] {
  const dir = getDevicesPendingDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
  return names.map((name) => {
    let platform = 'unknown';
    try { platform = fs.readFileSync(path.join(dir, name), 'utf-8').trim() || 'unknown'; } catch {  }
    return { name, platform };
  });
}
