/**
 * Personal operating reminders.
 *
 * A small, user-owned list of principles kept in
 * `~/.agents/reminders/reminders.yaml` and surfaced succinctly in the Claude
 * statusline — one per session, chosen deterministically from the session id so
 * concurrent agents each show a different one and it stays stable within a
 * session. Presence of the file with at least one entry is the opt-in; there is
 * no separate flag. The file syncs across the fleet via `agents repo push/pull`.
 */
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

/**
 * Point the reminders file at a fixture for tests, mirroring
 * `setClaudeUsageCachePathForTest` in accounting/usage.ts. Returns the prior
 * override so a test can restore it. Pass `null` to clear.
 */
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

/**
 * Load reminders from disk.
 *
 * Returns `[]` when the file does not exist — the feature is simply not opted
 * in. Throws on a present-but-malformed file so `agents reminders` can surface
 * the problem; the statusline caller deliberately swallows that, because a
 * broken prompt is worse than a missing reminder line.
 */
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

/**
 * Deterministically pick one reminder for a session. Same `sessionId` always
 * maps to the same reminder, so it is stable within a session; different session
 * ids spread across the list, so concurrent agents show different reminders.
 * Returns `null` when there are no reminders.
 */
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
