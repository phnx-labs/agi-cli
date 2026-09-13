/**
 * Detached-session store — the record `agents sessions detach` writes and both
 * `agents sessions attach` and the active-session scan read to know an agent is
 * "backgrounded": running headless with no terminal, continuing its task
 * unattended.
 *
 * One file per detached session under `~/.agents/.system/detached/<id>.json`.
 * Presence is DERIVED, never asserted: a record only means "this session was
 * detached to a headless continuation"; whether it is still `background`
 * (that continuation is alive) or `parked` (it has exited) is decided live from
 * the recorded pid + its start-time fingerprint. That keeps the store honest
 * even across a crash that never ran `attach`.
 */
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
  /**
   * Start-time fingerprint of {@link headlessPid} at spawn, so a liveness check
   * survives PID reuse: the pid is only "our" continuation if it still occupies
   * the process we launched. Null when the platform capture failed.
   */
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

/**
 * Presence for a session id from the detach store alone:
 *   - no record            -> undefined (caller decides: `attached` for a live
 *                             interactive row, nothing for cloud/team rows)
 *   - record + pid alive    -> `background` (headless continuation running)
 *   - record + pid exited   -> `parked` (the run finished; transcript is durable)
 */
export function presenceFromStore(sessionId: string): Presence | undefined {
  const rec = readDetachRecord(sessionId);
  if (!rec) return undefined;
  return isHeadlessAlive(rec) ? 'background' : 'parked';
}
