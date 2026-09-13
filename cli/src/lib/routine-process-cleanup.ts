import * as fsp from 'fs/promises';
import * as path from 'path';

import { execFileBounded } from './exec-bounded.js';
import { isAlive, killTree } from './platform/index.js';
import { getRunsDir } from './state.js';
import type { RunMeta } from './scheduling/routines.js';

interface RoutineProcessCleanupOptions {
  runsDir?: string;
  alive?: (pid: number) => boolean;
  owns?: (meta: RunMeta) => Promise<boolean> | boolean;
  terminate?: (pid: number) => void;
}

/** Bound the identity probe: a `ps`/`powershell` spawn on the heartbeat tick must never freeze the daemon's event loop. */
const IDENTITY_PROBE_TIMEOUT_MS = 5_000;

async function processMatchesRun(meta: RunMeta): Promise<boolean> {
  if (!meta.pid || !meta.spawnedAt) return false;
  if (process.platform === 'win32') {
    const res = await execFileBounded('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Process -Id ${meta.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString("o")`,
    ], { timeoutMs: IDENTITY_PROBE_TIMEOUT_MS });
    if (res.code !== 0) return false;
    const processStart = Date.parse(res.stdout.trim());
    return Number.isFinite(processStart) && Math.abs(processStart - meta.spawnedAt) < 30_000;
  }
  const res = await execFileBounded('ps', ['-p', String(meta.pid), '-o', 'etime='], { timeoutMs: IDENTITY_PROBE_TIMEOUT_MS });
  if (res.code !== 0) return false;
  const elapsed = res.stdout.trim();
  if (!elapsed) return false;
  const fields = elapsed.replace(/-/g, ':').split(':').reverse();
  const seconds = Number(fields[0] ?? 0)
    + Number(fields[1] ?? 0) * 60
    + Number(fields[2] ?? 0) * 3600
    + Number(fields[3] ?? 0) * 86400;
  return Math.abs((Date.now() - seconds * 1000) - meta.spawnedAt) < 30_000;
}

/** Reap process groups whose durable run record is already terminal. */
export async function reapTerminalRoutineProcesses(opts: RoutineProcessCleanupOptions = {}): Promise<number[]> {
  const runsDir = opts.runsDir ?? getRunsDir();
  const alive = opts.alive ?? isAlive;
  const owns = opts.owns ?? processMatchesRun;
  const terminate = opts.terminate ?? ((pid: number) => killTree(process.platform === 'win32' ? pid : -pid));

  let jobs: import('fs').Dirent[];
  try {
    jobs = await fsp.readdir(runsDir, { withFileTypes: true });
  } catch {
    return []; // runs dir absent — nothing to reap
  }

  const reaped: number[] = [];
  for (const job of jobs) {
    if (!job.isDirectory()) continue;
    const jobDir = path.join(runsDir, job.name);
    let runs: import('fs').Dirent[];
    try {
      runs = await fsp.readdir(jobDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const run of runs) {
      if (!run.isDirectory()) continue;
      try {
        const meta = JSON.parse(
          await fsp.readFile(path.join(jobDir, run.name, 'meta.json'), 'utf-8'),
        ) as RunMeta;
        if (!['failed', 'timeout'].includes(meta.status) || !meta.pid || meta.hostTaskId || meta.cloudTaskId) continue;
        const completedAt = Date.parse(meta.completedAt ?? '');
        if (!Number.isFinite(completedAt) || Date.now() - completedAt < 5_000) continue;
        if (!alive(meta.pid)) continue;
        if (!(await owns(meta))) continue;
        terminate(meta.pid);
        reaped.push(meta.pid);
      } catch {
        // Corrupt or concurrently-replaced records are left untouched.
      }
    }
  }
  return reaped;
}
