/**
 * One-time, CLI-owned migration of AGI Menu preferences from the macOS
 * UserDefaults domain `com.phnx-labs.agents-menubar` into the registered
 * `menubar.menu.*` config keys (PHNX-3999).
 *
 * Why here: before the preferences became `agents config` keys, the stable menu
 * bar stored them in its own UserDefaults. A user upgrading must keep those
 * settings, but the CLI is now the single source of truth and syncs fleet-wide,
 * so the values are lifted into config ONCE and then owned there.
 *
 * The rules (from the integration contract) are all fail-safe:
 *   - macOS only. On any other platform this is a no-op (Linux derives canonical
 *     config only).
 *   - The PRODUCTION domain only — never the dev bundle
 *     `com.phnx-labs.agents-menubar.dev` (we simply never read it).
 *   - Import only KNOWN keys ({@link MENUBAR_MENU_PROPERTIES}) that are still
 *     UNSET in config — an already-set (synced) value is never overridden.
 *   - One-shot, gated by a sentinel, so a later `agents config unset` cannot
 *     resurrect the legacy value on the next run.
 *
 * NOTE (verify on a real Mac): this assumes the UserDefaults key names equal the
 * config leaf names (`defaultProject`, `workingRowsShown`, …) — "Names mirror the
 * Swift MenuPreferences local-cache keys". If the app stored them under different
 * keys, no key matches and the migration is a safe no-op (it imports nothing and
 * still marks itself done). The exact key spelling is native-owned and confirmed
 * on the interactive Mac.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { configKeySpec, getConfigValue, setConfigValue } from '../device-config.js';
import { getRuntimeStateDir } from '../state.js';
import { MENUBAR_MENU_PROPERTIES } from '../config-keys.js';

/** The production menu-bar UserDefaults domain (NOT the `.dev` bundle). */
const USER_DEFAULTS_DOMAIN = 'com.phnx-labs.agents-menubar';

/** Sentinel marking the one-shot done; its presence blocks every later run. */
function sentinelPath(): string {
  return path.join(getRuntimeStateDir(), 'menubar-prefs-migrated');
}

/**
 * Pure plan step: which UserDefaults entries should be imported. Only known leaf
 * keys that are present in `userDefaults` AND currently unset in config
 * (`isUnset`) are imported — an already-set value is preserved. Values are
 * returned raw; the caller coerces + validates them against each key's spec.
 */
export function planMenubarPrefMigration(
  userDefaults: Record<string, unknown>,
  isUnset: (fullName: string) => boolean,
): Array<{ name: string; value: unknown }> {
  const plan: Array<{ name: string; value: unknown }> = [];
  for (const prop of MENUBAR_MENU_PROPERTIES) {
    if (!(prop in userDefaults)) continue;
    const name = `menubar.menu.${prop}`;
    if (!isUnset(name)) continue;
    plan.push({ name, value: userDefaults[prop] });
  }
  return plan;
}

/**
 * Coerce a raw UserDefaults value to the type its config key expects. `defaults
 * read -json` usually yields proper JSON types, but a bool can arrive as 0/1 or
 * "true"/"false" and an int as a numeric string, so normalize before validation.
 * Returns undefined for a value that cannot be coerced (skipped, never forced).
 */
export function coerceMenubarPrefValue(name: string, raw: unknown): unknown {
  const type = configKeySpec(name).type;
  if (type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 1 || raw === '1' || raw === 'true' || raw === 'YES') return true;
    if (raw === 0 || raw === '0' || raw === 'false' || raw === 'NO') return false;
    return undefined;
  }
  if (type === 'int') {
    if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
    if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number.parseInt(raw.trim(), 10);
    return undefined;
  }
  return typeof raw === 'string' ? raw : undefined;
}

/** Read the production domain as a JSON map, or `{}` when it is absent/unreadable. */
function readUserDefaultsDomain(): Record<string, unknown> {
  try {
    const out = execFileSync('defaults', ['read', USER_DEFAULTS_DOMAIN, '-json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return {};
    const parsed = JSON.parse(out) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // No such domain, no `defaults` binary, or malformed output — nothing to
    // migrate. A no-op, not an error.
    return {};
  }
}

/**
 * Run the one-shot migration. macOS only, gated by the sentinel, best-effort:
 * any failure is swallowed (a migration must never break the snapshot read that
 * calls it) and the sentinel is still written so it does not retry forever.
 */
export function migrateMenubarPreferencesFromUserDefaults(): void {
  if (process.platform !== 'darwin') return;
  const sentinel = sentinelPath();
  if (fs.existsSync(sentinel)) return;

  try {
    const ud = readUserDefaultsDomain();
    const plan = planMenubarPrefMigration(ud, (name) => getConfigValue(name).value === undefined);
    for (const { name, value } of plan) {
      const coerced = coerceMenubarPrefValue(name, value);
      if (coerced === undefined) continue; // unrepresentable — skip, never force
      try {
        setConfigValue(name, coerced);
      } catch {
        // An invalid enum value from a legacy build — skip it, keep the rest.
      }
    }
  } catch {
    // Never let a migration failure break the caller.
  } finally {
    try {
      fs.mkdirSync(path.dirname(sentinel), { recursive: true });
      fs.writeFileSync(sentinel, new Date().toISOString() + '\n');
    } catch {
      /* if we cannot mark it, a later run retries — still safe (idempotent) */
    }
  }
}
