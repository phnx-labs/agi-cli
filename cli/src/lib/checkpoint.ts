
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from './types.js';
import { getRunsDir } from './state.js';
import type { LoopConfig, LoopSignal } from './loop.js';

export interface Checkpoint {
  id: string;
  agent: AgentId;
  version?: string;
  prompt?: string;
  sessionId?: string;
  iteration: number;
  loop: LoopConfig;
  loopSignal?: LoopSignal;
  cumulativeTokens?: number;
  createdAt: string;
  updatedAt: string;
}

export function checkpointPath(runId: string): string {
  return path.join(getRunsDir(), runId, 'checkpoint.json');
}

export function writeCheckpoint(c: Checkpoint, file?: string): void {
  const target = file ?? checkpointPath(c.id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), 'utf-8');
  fs.renameSync(tmp, target);
}

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
