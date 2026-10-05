/** Personal operating reminders: a user-owned list in `~/.agents/reminders/reminders.yaml`, shown in
 * the Claude statusline, one per session picked deterministically from the session id. A file with
 * at least one entry is the opt-in; it syncs via `agents repo push/pull`. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { getUserAgentsDir } from './state.js';

export interface Reminder {
  /** Succinct form shown in the statusline (a few words). */
  short: string;
  /** Full principle, shown by `agents reminders`. Falls back to `short`. */
  full: string;
}

let remindersFilePathOverride: string | null = null;

/** Point the reminders file at a fixture for tests (like `setClaudeUsageCachePathForTest` in
 * accounting/usage.ts); returns the prior override, `null` clears. */
export function setRemindersFilePathForTest(filePath: string | null): string | null {
  const prev = remindersFilePathOverride;
  remindersFilePathOverride = filePath;
  return prev;
}

export function remindersFilePath(): string {
  return remindersFilePathOverride ?? path.join(getUserAgentsDir(), 'reminders', 'reminders.yaml');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Load reminders from disk. `[]` when the file is absent (not opted in); throws on a
 * present-but-malformed file so `agents reminders` can surface it, while the statusline caller
 * swallows that because a broken prompt is worse than a missing reminder line. */
export function loadReminders(filePath = remindersFilePath()): Reminder[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
  const parsed: unknown = parseYaml(raw);
  const list = isRecord(parsed) && Array.isArray(parsed.reminders) ? parsed.reminders : null;
  if (!list) {
    throw new Error(`reminders file has no 'reminders:' list: ${filePath}`);
  }
  const reminders: Reminder[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const short = typeof item.short === 'string' ? item.short.trim() : '';
    if (!short) continue;
    const full = typeof item.full === 'string' && item.full.trim() ? item.full.trim() : short;
    reminders.push({ short, full });
  }
  return reminders;
}

/** Deterministically pick one reminder for a session: the same `sessionId` always maps to the same
 * one (stable within a session), different ids spread across the list; `null` when there are none. */
export function pickReminderForSession(reminders: Reminder[], sessionId?: string): Reminder | null {
  if (reminders.length === 0) return null;
  const key = sessionId?.trim();
  const index = key ? hashString(key) % reminders.length : 0;
  return reminders[index];
}

/** FNV-1a 32-bit — stable, dependency-free, well-distributed for short ids. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
