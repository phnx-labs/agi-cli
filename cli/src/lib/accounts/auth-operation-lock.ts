import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { ensureLockTarget } from '../fs-atomic.js';
import { getRuntimeStateDir } from '../state.js';
import { isAgentId, type AgentId } from '../types.js';

export function authLockFilePath(agent: AgentId, stateDir?: string): string {
  if (!isAgentId(agent)) throw new Error('Unknown authentication harness.');
  return path.join(stateDir ?? getRuntimeStateDir(), `auth-op-lock-${agent}.json`);
}

export interface AuthOperationLock {
  readonly signal: AbortSignal;
  assertHeld(): void;
  release(): void;
}

export function acquireAuthOperationLock(agent: AgentId, stateDir?: string): AuthOperationLock {
  // Authentication is exclusive and fail-closed: never queue silently or continue after lock loss.
  const target = authLockFilePath(agent, stateDir);
  ensureLockTarget(target, '{}', 0o700);
  let compromised: Error | null = null;
  const controller = new AbortController();
  let unlock: () => void;
  try {
    unlock = lockfile.lockSync(target, {
      stale: 10 * 60_000,
      update: 1_000,
      onCompromised: (error) => {
        compromised = new Error(`Authentication lock was lost: ${error.message}`);
        controller.abort(compromised);
      },
    });
  } catch (error) {
    throw new Error(`Cannot safely start ${agent} authentication: another sign-in or sign-out may be in progress. ${(error as Error).message}`);
  }
  let released = false;
  return {
    signal: controller.signal,
    assertHeld() {
      controller.signal.throwIfAborted();
      if (released) throw new Error('Authentication lock was already released.');
    },
    release() {
      if (released) return;
      released = true;
      try { unlock(); } finally {
        if (compromised) throw new Error(`Authentication lock was lost: ${(compromised as Error).message}`);
      }
    },
  };
}
