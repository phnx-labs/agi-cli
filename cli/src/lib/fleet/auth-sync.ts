/**
 * Native-login inventory for `agents apply`.
 * Native OAuth/session files are identified only to report device readiness;
 * agents-cli never serializes or materializes them on another device.
 *
 * Honest boundary: on macOS, claude and antigravity keep their tokens in the
 * login keychain, ACL-bound to the harness process — unreadable by us. Those are
 * classified `bound` and surfaced for a one-time manual login, never faked.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AuthFilePayload, AuthSnapshotResult } from './types.js';

/** A portable credential file location, relative to $HOME. */
interface AuthFileSpec {
  rel: string;
  mode: number;
}

/**
 * Verified portable auth-file locations per agent (home-relative). Sourced from
 * live inspection of a Linux fleet box + the agent registry. Agents absent here
 * have no portable credential file we can propagate.
 */
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

/**
 * Agents whose OAuth credentials rely on single-use refresh tokens that rotate
 * server-side on every exchange. Copying these credential files across machines
 * is fatal: the first refresh on any box invalidates every other holder's token,
 * collapsing the fleet to a single working login (droid/WorkOS collapsed 10 boxes
 * to 1 overnight — RUSH-1958). Add any newly-discovered single-use-rotation
 * harness here; the predicate below is the one place the propagation decision is
 * made. See also `usage.ts` for the per-machine-login policy.
 */
export const SINGLE_USE_ROTATING_REFRESH_AGENTS: ReadonlySet<string> = new Set(['droid']);

/**
 * Whether `agent`'s login may be copied between machines by `apply`. Always
 * **false** now (RUSH-2527): every `FLEET_AUTH_FILES` entry is a native,
 * rotating OAuth / session login, and the fleet-auth contract forbids copying any
 * of them between devices (`docs/specifications.md` SING-1b) — not just the
 * single-use-rotating subset (`SINGLE_USE_ROTATING_REFRESH_AGENTS`) that first
 * motivated this gate. `apply` therefore never propagates a login; it surfaces
 * per-box login / portable-account guidance instead. `snapshotAuth` reads no
 * credential file as a result, so a native login never leaves its origin box.
 * The `agent` parameter is retained for the stable call signature.
 */
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

/**
 * Capture portable credential files for the given agents from a source home.
 * Returns the readable file payloads plus the list of agents whose auth is
 * device-bound (macOS keychain) and therefore cannot be captured. Agents that
 * are simply not signed in (no file on disk) are silently omitted — nothing to
 * propagate, not an error.
 */
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
