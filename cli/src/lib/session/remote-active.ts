/** Cross-machine fan-out for `agents sessions --active`: runs `--active --json --local` on each
 * online peer over SSH, tagging rows by machine; `--local` stops recursion. A dead host is skipped
 * with a note, never fatal. */
import { gatherRemoteAgentsJson } from '../remote-agents-json.js';
import type { ActiveSession } from './active.js';
import { parseViewingIn } from './viewing-in.js';

/** Recursion guard passed as an env var, not a CLI flag, so an older remote `agents` ignores it
 * instead of erroring on an unknown option. */
export const NO_FANOUT_ENV = 'AGENTS_SESSIONS_LOCAL';

/** Parse a peer's `--active --json` stdout into sessions tagged with `machine`; bad or non-array
 * input yields `[]`. `viewingIn` is normalized here from a string or the older `{app, tab}`
 * object. Exported for tests. */
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
      // The dialed machine wins: peers report their hostname but we key on the registered device
      // name, else `--device` scopes return zero rows. Exception: offloaded runs (`offloadedFrom`)
      // keep their own host (RUSH-2479).
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
  /** How many peer machines we attempted to reach (drives the empty-fleet tip). */
  deviceCount: number;
  /** Peers that were unreachable, timed out or lacked the CLI, distinct from a peer that
   * answered with zero sessions, so an empty result can name who went unheard (RUSH-2507). */
  skipped: string[];
  /** True when the device list itself could not be loaded — no peer was even attempted. */
  discoveryFailed: boolean;
}

/** Gather active sessions from other machines: exactly the `--device` hosts, else every registered
 * online device with an address except this one, in parallel. `opts.quiet` suppresses the
 * per-device stderr line for callers that report skipped peers themselves. */
export async function gatherRemoteActive(
  hosts?: string[],
  opts?: {
    quiet?: boolean;
    /** Opt-in first-hit abort. Off by default so `--active`, projects and bare `focus` wait for
     * all peers; detach/stop pass it for a unique live id so a reachable hit does not wait on
     * sleeping peers. */
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
