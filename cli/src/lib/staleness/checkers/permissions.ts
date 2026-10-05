/** Permissions staleness: every `groups/*.yaml` across user + system feeds the merged set (project
 * not consulted by the sync writer); user wins collisions. The active preset
 * (`AGENTS_PERMISSION_PRESET`) is fingerprinted too, so a preset switch alone counts as stale. */

import * as fs from 'fs';
import * as path from 'path';
import { getUserPermissionsDir, getPermissionsDir } from '../../state.js';
import { fingerprintFile, isFileStale } from '../fingerprint.js';
import { getActivePermissionPresetName } from '../../permissions.js';
import type { PermEntry, FileEntry } from '../types.js';

/** Walk user + system permissions/groups/. First-wins user > system on names. */
function collectPermissionGroupFiles(): Record<string, string> {
  const seen = new Map<string, string>();
  for (const baseDir of [getUserPermissionsDir(), getPermissionsDir()]) {
    const groupsDir = path.join(baseDir, 'groups');
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(groupsDir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;
      const name = entry.name.replace(/\.(yaml|yml)$/, '');
      if (!seen.has(name)) seen.set(name, path.join(groupsDir, entry.name));
    }
  }
  return Object.fromEntries(seen);
}

/** Build the permissions section of the manifest. */
export function buildPermissions(): PermEntry {
  const groupFiles = collectPermissionGroupFiles();
  const groups: Record<string, FileEntry> = {};
  for (const [name, filePath] of Object.entries(groupFiles)) {
    const fp = fingerprintFile(filePath);
    if (fp) groups[name] = { source: fp };
  }
  return {
    groups,
    permissionPreset: getActivePermissionPresetName(),
  };
}

/** True when the stored permissions section no longer matches current state. */
export function isPermissionsStale(stored: PermEntry): boolean {
  if (stored.permissionPreset !== getActivePermissionPresetName()) return true;
  const currentGroups = collectPermissionGroupFiles();
  const storedNames = Object.keys(stored.groups).sort();
  const currentNames = Object.keys(currentGroups).sort();
  if (storedNames.length !== currentNames.length) return true;
  for (let i = 0; i < storedNames.length; i++) {
    if (storedNames[i] !== currentNames[i]) return true;
  }
  for (const [name, filePath] of Object.entries(currentGroups)) {
    const entry = stored.groups[name];
    if (!entry || isFileStale(entry.source, filePath)) return true;
  }
  return false;
}
