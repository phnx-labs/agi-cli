/** Native-login inventory for `agents apply`: native OAuth/session files are identified only to
 * report readiness and never serialized or materialized elsewhere. */

import * as fs from 'fs';
import * as path from 'path';
import type { AuthFilePayload, AuthSnapshotResult } from './types.js';

/** A portable credential file location, relative to $HOME. */
interface AuthFileSpec {
  rel: string;
  mode: number;
}

/** Verified portable auth-file locations per agent (home-relative), from live inspection of a
 * Linux fleet box and the agent registry. Agents absent here have no portable credential file. */
export const FLEET_AUTH_FILES: Record<string, AuthFileSpec[]> = {
  claude: [{ rel: '.claude/.credentials.json', mode: 0o600 }],
  codex: [{ rel: '.codex/auth.json', mode: 0o600 }],
  grok: [{ rel: '.grok/auth.json', mode: 0o600 }],
  kimi: [{ rel: '.kimi-code/credentials/kimi-code.json', mode: 0o600 }],
  opencode: [{ rel: '.local/share/opencode/auth.json', mode: 0o600 }],
  droid: [
    { rel: '.factory/auth.v2.file', mode: 0o600 },
    { rel: '.factory/auth.v2.key', mode: 0o600 },
  ],
  antigravity: [{ rel: '.gemini/antigravity-cli/antigravity-oauth-token', mode: 0o600 }],
};

/** Agents whose macOS credentials live in the ACL-bound login keychain. */
export const KEYCHAIN_BOUND_ON_MAC: ReadonlySet<string> = new Set(['claude', 'antigravity']);

/** Agents whose OAuth uses single-use refresh tokens rotated server-side on every exchange.
 * Copying them is fatal: the first refresh on any box invalidates every other holder
 * (droid/WorkOS collapsed 10 boxes to 1, RUSH-1958). */
export const SINGLE_USE_ROTATING_REFRESH_AGENTS: ReadonlySet<string> = new Set(['droid']);

/** Whether `agent`'s login may be copied between machines by `apply`: always false (RUSH-2527).
 * Every FLEET_AUTH_FILES entry is a rotating native login SING-1b forbids copying between devices. */
export function isCredentialSafeToPropagate(_agent: string): boolean {
  return false;
}

/** True when the agent stores credentials in portable files we can read. This
 *  does NOT mean it is safe to propagate — check {@link isCredentialSafeToPropagate}. */
export function hasPortableAuthFiles(agent: string): boolean {
  return agent in FLEET_AUTH_FILES;
}

/** Which agents `apply` can propagate auth for at all. */
export function isPropagatableAgent(agent: string): boolean {
  return hasPortableAuthFiles(agent) && isCredentialSafeToPropagate(agent);
}

export interface SnapshotOptions {
  /** Home directory to read credential files from. */
  home: string;
  /** Platform of the source machine (`process.platform`). */
  platform: NodeJS.Platform;
}

/** Captures portable credential files for the given agents from a source home. Returns readable
 * payloads plus agents whose auth is device-bound (macOS keychain) and uncaptureable; agents
 * with no file on disk are silently omitted. */
export function snapshotAuth(agents: string[], opts: SnapshotOptions): AuthSnapshotResult {
  const files: AuthFilePayload[] = [];
  const bound: string[] = [];

  for (const agent of agents) {
    const specs = FLEET_AUTH_FILES[agent];
    if (!specs) continue; // no portable file — caller surfaces separately if desired
    if (!isCredentialSafeToPropagate(agent)) continue; // single-use rotating refresh tokens are never copied
    if (opts.platform === 'darwin' && KEYCHAIN_BOUND_ON_MAC.has(agent)) {
      bound.push(agent);
      continue;
    }
    for (const spec of specs) {
      const abs = path.join(opts.home, spec.rel);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue; // not signed in for this agent — nothing to carry
      }
      if (!stat.isFile()) continue;
      const content = fs.readFileSync(abs); // follows symlinks into version homes
      files.push({
        agent,
        rel: spec.rel,
        contentB64: content.toString('base64'),
        mode: (stat.mode & 0o777) || spec.mode,
      });
    }
  }

  return { files, bound };
}
