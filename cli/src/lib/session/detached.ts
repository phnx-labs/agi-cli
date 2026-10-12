import fs from 'node:fs';
import path from 'node:path';
import { getSystemAgentsDir } from '../state.js';
import { captureProcessStartTime } from '../platform/process.js';

export type Presence = 'attached' | 'background' | 'parked';

interface DetachRecord {
  sessionId: string;
  agent: string;
  cwd?: string;
  headlessPid: number;
  headlessStartTime: string | null;
  detachedAtMs: number;
}

function detachedDir(): string {
  return path.join(getSystemAgentsDir(), 'detached');
}

function recordPath(sessionId: string): string {
  return path.join(detachedDir(), `${sessionId}.json`);
}

export function writeDetachRecord(rec: DetachRecord): void {
  fs.mkdirSync(detachedDir(), { recursive: true });
  fs.writeFileSync(recordPath(rec.sessionId), JSON.stringify(rec, null, 2));
}

export function readDetachRecord(sessionId: string): DetachRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(recordPath(sessionId), 'utf8')) as DetachRecord;
  } catch {
    return undefined;
  }
}

export function clearDetachRecord(sessionId: string): void {
  try {
    fs.rmSync(recordPath(sessionId));
  } catch {
  }
}

export function isHeadlessAlive(rec: DetachRecord): boolean {

  if (!rec.headlessPid || rec.headlessPid <= 0) return false;
  try {
    process.kill(rec.headlessPid, 0);
  } catch {
    return false;
  }
  if (rec.headlessStartTime !== null) {
    const now = captureProcessStartTime(rec.headlessPid);
    if (now !== null && now !== rec.headlessStartTime) return false;
  }
  return true;
}

export function presenceFromStore(sessionId: string): Presence | undefined {
  const rec = readDetachRecord(sessionId);
  if (!rec) return undefined;
  return isHeadlessAlive(rec) ? 'background' : 'parked';
}
