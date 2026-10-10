import * as fs from 'node:fs';
import * as path from 'node:path';
import { getRuntimeStateDir } from '../state.js';
import { getConfigValue } from '../device-config.js';

export const MENUBAR_AUTO_UPDATE_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const menubarAutoUpdateEnabled = (): boolean => getConfigValue('menubar.autoUpdate').value !== false;
export const updateStatePath = (): string => path.join(getRuntimeStateDir(), 'menubar-update.json');
export interface MenubarUpdateState {
  outcome: 'unknown' | 'available' | 'updated' | 'current' | 'skipped' | 'failed';
  installed: string | null;
  available: string | null;
  checkedAt: string | null;
  nextCheckAt: string | null;
  autoUpdate: boolean;
  detail: string;
}
export function readUpdateState(): Partial<MenubarUpdateState> {
  try {
    const state = JSON.parse(fs.readFileSync(updateStatePath(), 'utf8'));
    if (!state || typeof state !== 'object') return {};
    if (state.checkedAt != null && (typeof state.checkedAt !== 'string' || !Number.isFinite(Date.parse(state.checkedAt)))) return {};
    if (!['unknown', 'available', 'updated', 'current', 'skipped', 'failed'].includes(state.outcome)) return {};
    if (state.available != null && (typeof state.available !== 'string' || !/^\d+\.\d+\.\d+$/.test(state.available))) return {};
    if (typeof state.detail !== 'string') return {};
    return state;
  } catch { return {}; }
}
export function saveUpdateState(status: MenubarUpdateState): MenubarUpdateState {
  fs.mkdirSync(path.dirname(updateStatePath()), { recursive: true });
  const tmp = `${updateStatePath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status));
  fs.renameSync(tmp, updateStatePath());
  return status;
}
export function menubarAutomaticUpdateDue(checkedAt: string | null, now = Date.now()): boolean {
  return checkedAt === null || now - Date.parse(checkedAt) >= MENUBAR_AUTO_UPDATE_INTERVAL_MS;
}
