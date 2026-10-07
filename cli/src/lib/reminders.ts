import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { getUserAgentsDir } from './state.js';

export interface Reminder {
  short: string;
  full: string;
}

let remindersFilePathOverride: string | null = null;

export function setRemindersFilePathForTest(filePath: string | null): string | null {
  const prev = remindersFilePathOverride;
  remindersFilePathOverride = filePath;
  return prev;
}

function remindersFilePath(): string {
  return remindersFilePathOverride ?? path.join(getUserAgentsDir(), 'reminders', 'reminders.yaml');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

export function pickReminderForSession(reminders: Reminder[], sessionId?: string): Reminder | null {
  if (reminders.length === 0) return null;
  const key = sessionId?.trim();
  const index = key ? hashString(key) % reminders.length : 0;
  return reminders[index];
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
