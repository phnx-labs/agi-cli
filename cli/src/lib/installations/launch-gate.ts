
import { withFileLockAsync } from '../fs-atomic.js';
import * as fs from 'node:fs';
import { ensureInstallationLocked, installationDir } from './store.js';
import { recordLaunchLease } from './shims.js';
import type { AgentId } from '../types.js';
import { AGENTS } from '../agents.js';
import { VERSION_RE } from '../agent-spec/primitives.js';
import { installationLockTarget, INSTALLATION_LOCK_OPTIONS } from './installation-lock.js';

const LAUNCH_GATE_ACQUIRE_TIMEOUT_MS = 3 * 60_000;

// Launch shares update's lock and fails closed rather than entering a half-swapped tree.
export async function withLaunchGate<T>(agent: AgentId, label: string, fn: () => T): Promise<T> {
  if (!Object.hasOwn(AGENTS, agent) || !VERSION_RE.test(label)) throw new Error('Invalid managed installation.');
  if (!fs.existsSync(installationDir(agent, label))) throw new Error(`No installation directory for ${agent}@${label}.`);
  const recordPath = installationLockTarget(agent, label);
  return withFileLockAsync(recordPath, () => {
    ensureInstallationLocked(agent, label);
    return fn();
  }, {
    ...INSTALLATION_LOCK_OPTIONS,
    acquireTimeoutMs: LAUNCH_GATE_ACQUIRE_TIMEOUT_MS,
  });
}

async function acquireLaunchGate(agent: AgentId, label: string, pid: number): Promise<() => void> {
  return withLaunchGate(agent, label, () => recordLaunchLease(agent, label, pid));
}

export async function withInstallationLease<T>(agent: AgentId, label: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireLaunchGate(agent, label, process.pid);
  try { return await fn(); } finally { release(); }
}

export async function runLaunchLeaseCli(argv: string[]): Promise<number> {
  const [agentRaw, label, pidRaw] = argv;
  const pid = Number(pidRaw);
  if (!agentRaw || !label || !Number.isInteger(pid) || pid <= 0) {
    process.stderr.write('usage: agents __launch-lease <agent> <label> <pid>\n');
    return 2;
  }
  try {
    await acquireLaunchGate(agentRaw as AgentId, label, pid);
    return 0;
  } catch (err) {
    process.stderr.write(`agents __launch-lease: ${(err as Error).message}\n`);
    return 1;
  }
}
