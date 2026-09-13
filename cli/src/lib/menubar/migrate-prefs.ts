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
 * The stable app stores each preference under its FULL `menubar.menu.*` key name
 * (the Swift MenuPreferences local-cache key), so the migration matches on the
 * full name. If a key is stored under a different name, it simply is not matched
 * and the migration stays a safe no-op for it. The read uses `defaults export
 * <domain> -` piped through `plutil` (NOT `defaults read <domain> -json`, which
 * treats `-json` as a key and errors).
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { assertValidValue, configKeySpec, getConfigValue, setConfigValue } from '../device-config.js';
import { getRuntimeStateDir } from '../state.js';
import { MENUBAR_MENU_PROPERTIES } from '../config-keys.js';

/** The production menu-bar UserDefaults domain (NOT the `.dev` bundle). */
const USER_DEFAULTS_DOMAIN = 'com.phnx-labs.agents-menubar';

/** Sentinel marking the one-shot done; its presence blocks every later run. */
function sentinelPath(): string {
  return path.join(getRuntimeStateDir(), 'menubar-prefs-migrated');
}

/**
 * Pure plan step: which UserDefaults entries should be imported. The stable app
 * stores each preference under its FULL `menubar.menu.*` key name (the Swift
 * MenuPreferences local-cache key), so we match on the full name — only known
 * keys that are present in `userDefaults` AND currently unset in config
 * (`isUnset`) are imported, so an already-set value is preserved. Values are
 * returned raw; the caller coerces + validates them against each key's spec.
 */
export function planMenubarPrefMigration(
  userDefaults: Record<string, unknown>,
  isUnset: (fullName: string) => boolean,
): Array<{ name: string; value: unknown }> {
  const plan: Array<{ name: string; value: unknown }> = [];
  for (const prop of MENUBAR_MENU_PROPERTIES) {
    const name = `menubar.menu.${prop}`;
    if (!(name in userDefaults)) continue;
    if (!isUnset(name)) continue;
    plan.push({ name, value: userDefaults[name] });
  }
  return plan;
}

/**
 * Coerce a raw UserDefaults value to the type its config key expects. The
 * `plutil` scalar output is text, but a bool can arrive as
 * 0/1 or "true"/"false" and an int as a numeric string, so normalize before
 * validation. Returns undefined for a value that cannot be coerced (skipped,
 * never forced).
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

/**
 * Read known scalar preferences from the production domain.
 *
 * `defaults read <domain> -json` does NOT exist — `defaults read` treats `-json`
 * as a KEY name and errors. The correct read is `defaults export <domain> -`,
 * which writes the domain's plist to stdout (an EMPTY plist, exit 0, when the
 * domain is absent — a legitimate "nothing to migrate"), read one known scalar key at a time with `plutil -extract … raw`. Other
 * defaults may contain dates or data that cannot be represented as JSON.
 *
 * Returns `{ ok }` so the caller can tell a genuine read/convert FAILURE (do not
 * write the sentinel — retry next run) from an ABSENT domain (ok, empty values —
 * mark done). A failure never fabricates an empty map.
 */
function readUserDefaultsDomain(): { ok: boolean; values: Record<string, unknown> } {
  try {
    const plist = execFileSync('defaults', ['export', USER_DEFAULTS_DOMAIN, '-'], {
      encoding: 'utf8', timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const values: Record<string, unknown> = {};
    for (const property of MENUBAR_MENU_PROPERTIES) {
      const key = `menubar.menu.${property}`;
      try {
        values[key] = execFileSync('plutil', ['-extract', key.replaceAll('.', '\\.'), 'raw', '-o', '-', '-'], {
          input: plist, encoding: 'utf8', timeout: 5_000, stdio: ['pipe', 'pipe', 'ignore'],
        }).trimEnd();
      } catch {
        // Missing or non-scalar legacy keys are outside the preference contract.
      }
    }
    return { ok: true, values };
  } catch {
    // `defaults`/`plutil` missing, a non-zero exit, or malformed output — a real
    // failure. Do NOT claim an empty domain; the caller must retry.
    return { ok: false, values: {} };
  }
}

/**
 * Run the one-shot migration. macOS only, gated by the sentinel, best-effort:
 * any failure is swallowed (a migration must never break the snapshot read that
 * calls it) and a failed read remains eligible for a later retry.
 */
export function migrateMenubarPreferencesFromUserDefaults(): void {
  if (process.platform !== 'darwin') return;
  const sentinel = sentinelPath();
  if (fs.existsSync(sentinel)) return;

  const { ok, values } = readUserDefaultsDomain();
  // A genuine read/convert failure must NOT mark the migration done — retry on a
  // later run rather than silently skipping the user's real settings forever. An
  // ABSENT domain reads ok with empty values and legitimately marks done.
  if (!ok) return;

  try {
    const plan = planMenubarPrefMigration(values, (name) => getConfigValue(name).value === undefined);
    for (const { name, value } of plan) {
      const coerced = coerceMenubarPrefValue(name, value);
      if (coerced === undefined) continue; // unrepresentable — skip, never force
      try {
        assertValidValue(configKeySpec(name), coerced);
      } catch {
        continue;
      }
      setConfigValue(name, coerced);
    }
  } catch {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, new Date().toISOString() + '\n');
  } catch {
    /* if we cannot mark it, a later run retries — still safe (idempotent) */
  }
}
