/** Device-scoped routine activation: definitions say what a routine does; this module owns whether
 * THIS device runs it, as membership in the top-level `routines:` list of
 * `~/.agents/devices/<machine>/agents.yaml`. */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { machineId } from './machine-id.js';
import { getUserAgentsDir, readMeta, updateMeta } from './state.js';

export function normalizeRoutineNames(names: Iterable<string>): string[] {
  return [...new Set([...names].map((name) => name.trim()).filter(Boolean))].sort();
}

/** null means this device has not materialized activation state yet. */
export function enabledRoutineNames(): string[] | null {
  const names = readMeta().deviceRoutines;
  return Array.isArray(names) ? normalizeRoutineNames(names) : null;
}

export function routineEnabledOnThisDevice(name: string): boolean | null {
  const names = enabledRoutineNames();
  return names === null ? null : names.includes(name);
}

export function replaceEnabledRoutines(names: Iterable<string>): string[] {
  const normalized = normalizeRoutineNames(names);
  updateMeta((meta) => ({ ...meta, deviceRoutines: normalized }));
  return normalized;
}

/** Add or remove one routine on this machine. `legacyEnabledNames` seeds the manifest the first time
 * an upgraded host changes activation, preserving every routine effectively enabled under the old
 * definition fields. */
export function setRoutineEnabledOnThisDevice(
  name: string,
  enabled: boolean,
  legacyEnabledNames: Iterable<string> = [],
): string[] {
  const current = enabledRoutineNames() ?? normalizeRoutineNames(legacyEnabledNames);
  const next = new Set(current);
  if (enabled) next.add(name);
  else next.delete(name);
  return replaceEnabledRoutines(next);
}

/** Read-only fleet view from synced device documents. Never writes a peer file. */
export function devicesWithRoutineEnabled(name: string): string[] {
  const devicesDir = path.join(getUserAgentsDir(), 'devices');
  if (!fs.existsSync(devicesDir)) return [];
  const devices: string[] = [];
  for (const entry of fs.readdirSync(devicesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(devicesDir, entry.name, 'agents.yaml');
    if (!fs.existsSync(file)) continue;
    let parsed: unknown;
    try {
      parsed = yaml.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      throw new Error(`Device config corrupted at ${file}: ${(err as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Device config corrupted at ${file}: expected a YAML map.`);
    }
    const routines = (parsed as { routines?: unknown }).routines;
    if (routines === undefined) continue;
    if (!Array.isArray(routines) || routines.some((routine) => typeof routine !== 'string')) {
      throw new Error(`Device config corrupted at ${file}: routines must be a string list.`);
    }
    if (routines.includes(name)) devices.push(entry.name);
  }
  return devices.sort();
}

/** Which devices enable which routines, read in one pass. */
export interface RoutineDeviceIndex {
  /** Routine name → the devices whose allowlist names it, sorted. */
  byRoutine: Map<string, string[]>;
  /** True when at least one device document declares a `routines:` list. Until then no routine is
   * "dark" (the fleet hasn't materialized activation state), and saying "will not fire" would be
   * wrong. */
  materialized: boolean;
  /** Device files that could not be read, reported instead of thrown. */
  errors: string[];
}

/** Build the fleet's activation map in one pass over `devices/`. `devicesWithRoutineEnabled` throws
 * on a corrupt peer file, right for one routine but wrong for a listing where one bad document
 * would blank every row (and re-walking per routine is quadratic). */
export function routineDeviceIndex(): RoutineDeviceIndex {
  const byRoutine = new Map<string, string[]>();
  const errors: string[] = [];
  let materialized = false;

  const devicesDir = path.join(getUserAgentsDir(), 'devices');
  if (!fs.existsSync(devicesDir)) return { byRoutine, materialized, errors };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(devicesDir, { withFileTypes: true });
  } catch (err) {
    return { byRoutine, materialized, errors: [`${devicesDir}: ${(err as Error).message}`] };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(devicesDir, entry.name, 'agents.yaml');
    if (!fs.existsSync(file)) continue;

    let parsed: unknown;
    try {
      parsed = yaml.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message.split('\n')[0]}`);
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push(`${file}: expected a YAML map`);
      continue;
    }
    const routines = (parsed as { routines?: unknown }).routines;
    if (routines === undefined) continue;
    if (!Array.isArray(routines) || routines.some((routine) => typeof routine !== 'string')) {
      errors.push(`${file}: routines must be a string list`);
      continue;
    }

    materialized = true;
    // Same normalization the writers use (`replaceEnabledRoutines`), so a device
    // that lists a routine twice, or with stray whitespace, cannot make the index
    // disagree with `enabledRoutineNames` about what that device enables.
    for (const name of normalizeRoutineNames(routines as string[])) {
      const devices = byRoutine.get(name);
      if (devices) devices.push(entry.name);
      else byRoutine.set(name, [entry.name]);
    }
  }

  for (const devices of byRoutine.values()) devices.sort();
  return { byRoutine, materialized, errors };
}

export function currentRoutineDevice(): string {
  return machineId();
}
