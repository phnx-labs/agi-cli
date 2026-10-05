/** Harness-level loop checkpoint (issue #332): durable state for a `--loop` run so
 * `--resume-checkpoint` can continue after SIGTERM, timeout, or sleep. Written atomically (temp +
 * rename); a missing or corrupt file reads as null, meaning start fresh. */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from './types.js';
import { getRunsDir } from './state.js';
import type { LoopConfig, LoopSignal } from './loop.js';

/** Durable harness state for a looped run, serialized to checkpoint.json. */
export interface Checkpoint {
  /** runId == the run directory name under getRunsDir(). */
  id: string;
  agent: AgentId;
  version?: string;
  /** The prompt re-injected each iteration. */
  prompt?: string;
  /** Pinned Claude session id so a resume continues the same conversation. */
  sessionId?: string;
  /** Iterations COMPLETED so far. A resume starts at iteration + 1. */
  iteration: number;
  /** The loop config governing termination. */
  loop: LoopConfig;
  /** Last loop-signal read, if any (for audit / resume context). */
  loopSignal?: LoopSignal;
  /** Cumulative tokens consumed across all iterations so far. */
  cumulativeTokens?: number;
  createdAt: string;
  updatedAt: string;
}

/** Path to a run's checkpoint file: <runsDir>/<runId>/checkpoint.json. */
export function checkpointPath(runId: string): string {
  return path.join(getRunsDir(), runId, 'checkpoint.json');
}

/** Write a checkpoint atomically (temp file + rename) so a reader never sees a partial file. */
export function writeCheckpoint(c: Checkpoint, file?: string): void {
  const target = file ?? checkpointPath(c.id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), 'utf-8');
  fs.renameSync(tmp, target);
}

/** Read a checkpoint; null if missing or invalid JSON, which the caller treats as a fresh start. */
export function readCheckpoint(file: string): Checkpoint | null {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.id !== 'string' || typeof parsed.iteration !== 'number') return null;
    return parsed as Checkpoint;
  } catch {
    return null;
  }
}
