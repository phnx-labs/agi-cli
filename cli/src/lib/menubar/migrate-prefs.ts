
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { assertValidValue, configKeySpec, getConfigValue, setConfigValue } from '../device-config.js';
import { getRuntimeStateDir } from '../state.js';
import { MENUBAR_MENU_PROPERTIES } from '../config-keys.js';

const USER_DEFAULTS_DOMAIN = 'com.phnx-labs.agents-menubar';

function sentinelPath(): string {
  return path.join(getRuntimeStateDir(), 'menubar-prefs-migrated');
}

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
      }
    }
    return { ok: true, values };
  } catch {
    return { ok: false, values: {} };
  }
}

export function migrateMenubarPreferencesFromUserDefaults(): void {
  if (process.platform !== 'darwin') return;
  const sentinel = sentinelPath();
  if (fs.existsSync(sentinel)) return;

  const { ok, values } = readUserDefaultsDomain();
  if (!ok) return;

  try {
    const plan = planMenubarPrefMigration(values, (name) => getConfigValue(name).value === undefined);
    for (const { name, value } of plan) {
      const coerced = coerceMenubarPrefValue(name, value);
      if (coerced === undefined) continue;
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
  }
}
