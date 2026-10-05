import { gatherRemoteAgentsJson } from '../remote-agents-json.js';
import type { ActiveSession } from './active.js';
import { parseViewingIn } from './viewing-in.js';

export const NO_FANOUT_ENV = 'AGENTS_SESSIONS_LOCAL';

export function parseRemoteActive(stdout: string, machine: string): ActiveSession[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ActiveSession[] = [];
  for (const x of parsed) {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      const reported = x as ActiveSession;
      const row = {
        ...reported,
        machine: reported.offloadedFrom && reported.machine ? reported.machine : machine,
      };
      row.viewingIn = parseViewingIn((x as { viewingIn?: unknown }).viewingIn);
      out.push(row);
    }
  }
  return out;
}

interface RemoteActiveResult {
  sessions: ActiveSession[];
  deviceCount: number;
  skipped: string[];
  discoveryFailed: boolean;
}

export async function gatherRemoteActive(
  hosts?: string[],
  opts?: {
    quiet?: boolean;
    earlyExit?: { isDefinitive: (item: ActiveSession, machine: string) => boolean };
  },
): Promise<RemoteActiveResult> {
  const result = await gatherRemoteAgentsJson({
    args: ['sessions', '--active', '--json'],
    noFanoutEnv: NO_FANOUT_ENV,
    hosts,
    parse: parseRemoteActive,
    quiet: opts?.quiet,
    earlyExit: opts?.earlyExit,
  });
  return {
    sessions: result.items,
    deviceCount: result.deviceCount,
    skipped: result.skipped,
    discoveryFailed: result.discoveryFailed,
  };
}
