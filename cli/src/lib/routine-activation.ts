import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { machineId } from './machine-id.js';
import { getUserAgentsDir, readMeta, updateMeta } from './state.js';

export function normalizeRoutineNames(names: Iterable<string>): string[] {
  return [...new Set([...names].map((name) => name.trim()).filter(Boolean))].sort();
}

export function enabledRoutineNames(): string[] | null {
  // Device activation is scheduler ownership, distinct from where a routine executes.
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

export interface RoutineDeviceIndex {
  byRoutine: Map<string, string[]>;
  materialized: boolean;
  errors: string[];
}

export function routineDeviceIndex(): RoutineDeviceIndex {
  // Report corrupt peer documents without blanking otherwise valid device activation state.
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
