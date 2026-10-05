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

export function listDetachRecords(): DetachRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(detachedDir());
  } catch {
    return [];
  }
  const out: DetachRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const rec = readDetachRecord(name.slice(0, -'.json'.length));
    if (rec) out.push(rec);
  }
  return out;
}

export function isHeadlessAlive(rec: DetachRecord): boolean {
  // Liveness belongs to the recorded process incarnation, not merely to a reused PID.
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

export async function takeOverDetachedSession(sessionId: string): Promise<boolean> {
  // Signal only the fingerprint-verified owner and fail closed if it survives SIGTERM.
  const rec = readDetachRecord(sessionId);
  if (!rec) return false;

  if (isHeadlessAlive(rec)) {
    try {
      process.kill(rec.headlessPid, 'SIGTERM');
    } catch (err) {
      if (isHeadlessAlive(rec)) throw err;
    }

    const deadline = Date.now() + 2_000;
    while (isHeadlessAlive(rec) && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    if (isHeadlessAlive(rec)) {
      throw new Error(`Detached continuation ${rec.headlessPid} did not stop; refusing to resume a duplicate process.`);
    }
  }

  clearDetachRecord(sessionId);
  return true;
}

export function presenceFromStore(sessionId: string): Presence | undefined {
  const rec = readDetachRecord(sessionId);
  if (!rec) return undefined;
  return isHeadlessAlive(rec) ? 'background' : 'parked';
}
