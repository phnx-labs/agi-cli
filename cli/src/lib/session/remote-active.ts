import { gatherRemoteAgentsJson, type RemoteAgentsJsonParseResult } from '../remote-agents-json.js';
import type { ActiveSession } from './active.js';
import { parseViewingIn } from './viewing-in.js';

export const NO_FANOUT_ENV = 'AGENTS_SESSIONS_LOCAL';

export function parseRemoteActive(stdout: string, machine: string): RemoteAgentsJsonParseResult<ActiveSession> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { items: [], valid: false };
  }
  if (!Array.isArray(parsed)) return { items: [], valid: false };
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
  return { items: out, valid: true };
}

interface RemoteActiveResult {
  sessions: ActiveSession[];
  deviceCount: number;
  skipped: string[];
  answered: string[];
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
    args: ['ps', '--local', '--json'],
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
    answered: result.answered,
    discoveryFailed: result.discoveryFailed,
  };
}
