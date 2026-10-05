import * as fs from 'fs';
import { parseState, stateFilePath } from './state-file.js';
import {
  findStateByLaunchId,
  findStateByTerminalId,
  findStateInTree,
} from './reader.js';
import type {
  DetectionResult,
  LookupInput,
  SessionState,
  TrackSpawnInput,
} from './types.js';

export * from './types.js';
export * from './state-file.js';
export * from './writer.js';
export * from './install-hook.js';
export {
  descendantPids,
  findStateByPid,
  findStateInTree,
  findStateByTerminalId,
  findStateByLaunchId,
  pruneStaleSessionState,
} from './reader.js';

export interface TrackSpawnOptions {
  /** Max time to wait for the SessionStart hook to land the state file. Default 5000ms. */
  timeoutMs?: number;
  /** Poll interval. Default 50ms. */
  pollIntervalMs?: number;
}

/** Wait for the polyglot SessionStart hook (src/hook.sh) to drop a state file at
 * stateFilePath(input.agentPid); resolves when it appears, or confidence='low' / sessionId=null on
 * timeout. */
export async function trackSpawn(
  input: TrackSpawnInput,
  opts: TrackSpawnOptions = {},
): Promise<DetectionResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollIntervalMs = opts.pollIntervalMs ?? 50;
  const start = Date.now();
  const targetPath = stateFilePath(input.agentPid);

  while (Date.now() - start < timeoutMs) {
    const state = await readStateIfPresent(targetPath);
    if (state) {
      return {
        sessionId: state.session_id,
        method: state.method,
        latencyMs: Date.now() - start,
        confidence: 'high',
      };
    }
    await sleep(pollIntervalMs);
  }

  return {
    sessionId: null,
    method: null,
    latencyMs: Date.now() - start,
    confidence: 'low',
  };
}

export async function getLiveSession(input: LookupInput): Promise<SessionState | null> {
  if (input.launchId) {
    const byLaunch = await findStateByLaunchId(input.launchId);
    if (byLaunch) return byLaunch;
  }
  if (input.terminalId) {
    const byTerm = await findStateByTerminalId(input.terminalId);
    if (byTerm) return byTerm;
  }
  if (input.shellPid) {
    return findStateInTree(input.shellPid);
  }
  return null;
}

async function readStateIfPresent(p: string): Promise<SessionState | null> {
  try {
    const raw = await fs.promises.readFile(p, 'utf8');
    return parseState(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
