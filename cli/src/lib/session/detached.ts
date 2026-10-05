/** Detached-session store: the record `agents sessions detach` writes and `sessions resume` reads,
 * one file per session at `~/.agents/.system/detached/<id>.json`. `background` vs `parked` is
 * derived live from the recorded pid and start-time fingerprint, never asserted. */
import fs from 'node:fs';
import path from 'node:path';
import { getSystemAgentsDir } from '../state.js';
import { captureProcessStartTime } from '../platform/process.js';

/** A session's foreground/background presence. */
export type Presence = 'attached' | 'background' | 'parked';

interface DetachRecord {
  sessionId: string;
  agent: string;
  cwd?: string;
  /** pid of the detached headless continuation `agents sessions detach` spawned. */
  headlessPid: number;
  /** Start-time fingerprint of {@link headlessPid} at spawn, so liveness survives PID reuse: the
   * pid is ours only if it still occupies the process we launched. Null when platform capture
   * failed. */
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
    /* already gone */
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

/** True while the recorded headless continuation is still the live process we spawned. */
export function isHeadlessAlive(rec: DetachRecord): boolean {
  if (!rec.headlessPid || rec.headlessPid <= 0) return false;
  try {
    process.kill(rec.headlessPid, 0);
  } catch {
    return false;
  }
  // Defeat PID reuse: if the pid now belongs to a different process, it is not ours.
  if (rec.headlessStartTime !== null) {
    const now = captureProcessStartTime(rec.headlessPid);
    if (now !== null && now !== rec.headlessStartTime) return false;
  }
  return true;
}

/** Stop the detached continuation before a local foreground resume. The start-time check in {@link
 * isHeadlessAlive} avoids signalling a reused PID; a continuation that ignores SIGTERM fails
 * closed instead of running beside a second process on the same transcript. */
export async function takeOverDetachedSession(sessionId: string): Promise<boolean> {
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

/** Presence from the detach store alone: no record -> undefined (caller decides); record + pid
 * alive -> `background`; record + pid exited -> `parked` (transcript durable). */
export function presenceFromStore(sessionId: string): Presence | undefined {
  const rec = readDetachRecord(sessionId);
  if (!rec) return undefined;
  return isHeadlessAlive(rec) ? 'background' : 'parked';
}
