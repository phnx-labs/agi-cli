/**
 * Native-login inventory for `agents apply` and `agents fleet login`.
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
 * made. See also `remote-login.ts` and `usage.ts` for the per-machine-login policy.
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

/**
 * The shape of a login flow — enough for `agents fleet login` to drive a remote
 * box's device-code OAuth over SSH and scrape the verification URL + user code.
 *
 * `flowType` decides remotability:
 *  - `device-code` — the remote box prints a URL + short code the human enters in
 *    a browser on THIS machine. The only flow `fleet login` can orchestrate.
 *  - `loopback`    — the CLI opens a browser and listens on 127.0.0.1 on the
 *    remote box; the redirect must reach that box's own loopback, so it can only
 *    be completed with a browser on the same machine. Non-remotable.
 *  - `api-key`     — a pasted key, not an OAuth handshake. Non-remotable.
 *  - `unknown`     — flow not yet characterized (no captured output). Non-remotable
 *    until someone captures the real pattern and fills the regexes.
 */
export type LoginFlowType = 'device-code' | 'loopback' | 'api-key' | 'unknown';

export interface LoginFlow {
  /**
   * The exact command that starts the login flow on the remote box, run as
   * `ssh -tt <box> <loginCommand>`. Bare `<cli>` for agents whose device flow
   * starts on launch (droid, kimi, antigravity), `<cli> login` for
   * codex/grok, `<cli> auth login` for opencode.
   */
  loginCommand: string;
  flowType: LoginFlowType;
  /**
   * Keystrokes sent after launch to force the device-code path when the CLI
   * presents a menu (codex: pick "Sign in with Device Code") or requires a
   * sub-command inside a TUI (kimi: `/login`). Sent verbatim through the PTY,
   * so it must include the submitting CR (`\r`). Absent when the flow needs no
   * steering.
   */
  deviceCodeSelect?: string;
  /** Captures the verification URL from scraped login output (group 1 preferred). */
  verificationUrlRegex?: RegExp;
  /** Captures the user code from scraped login output (group 1 preferred). */
  userCodeRegex?: RegExp;
  /**
   * Home-relative credential file that appears / bumps mtime on success — the
   * completion signal. Mirrors {@link FLEET_AUTH_FILES} (first entry for agents
   * with several).
   */
  successFile: string;
}

/** The success-file for an agent — the primary portable credential (first spec). */
function successFileFor(agent: string): string {
  const specs = FLEET_AUTH_FILES[agent];
  if (!specs || specs.length === 0) throw new Error(`no auth file spec for agent '${agent}'`);
  return specs[0].rel;
}

/**
 * Per-agent login flows, populated from live login-output captures (the only
 * ground truth — no fixtures exist upstream). Agents whose real device-code
 * output has not been captured are marked honestly (`unknown` / no regexes) so
 * `fleet login` flags them non-remotable instead of guessing.
 *
 * Only the `device-code` entries are ones `fleet login` drives; the rest are
 * carried so the command can explain WHY a logged-out pair is not remotable.
 */
export const FLEET_LOGIN_FLOWS: Record<string, LoginFlow> = {
  // droid: launches its TUI and prints, verbatim:
  //   "If the link does not open automatically, please visit
  //    https://auth.factory.ai/device and enter code MJQW-NQRM to complete
  //    authentication." then "Waiting for authentication to complete...".
  droid: {
    loginCommand: 'droid',
    flowType: 'device-code',
    verificationUrlRegex: /please visit\s+(https:\/\/\S+?)\s+and enter code/i,
    userCodeRegex: /enter code\s+([A-Z0-9]{4}-[A-Z0-9]{4})/i,
    successFile: successFileFor('droid'),
  },
  // codex login shows a numbered menu; option 2 ("Sign in with Device Code",
  // "Sign in from another device with a one-time code") is the remotable one.
  // The post-selection URL/code output was not captured this session, so the
  // regexes are best-effort generic device-code patterns — TODO: tighten once a
  // real codex device-code screen is captured.
  codex: {
    loginCommand: 'codex login',
    flowType: 'device-code',
    deviceCodeSelect: '\x1b[B\r', // down-arrow once (to option 2) + Enter
    verificationUrlRegex: /(https:\/\/\S*(?:device|activate|login|auth)\S*)/i,
    userCodeRegex: /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/,
    successFile: successFileFor('codex'),
  },
  // kimi: launch bare `kimi`, then `/login` inside the TUI, which prints
  // "Select a platform and authenticate". Post-selection URL/code not captured —
  // best-effort regexes, TODO: tighten with a real capture.
  kimi: {
    loginCommand: 'kimi',
    flowType: 'device-code',
    deviceCodeSelect: '/login\r',
    verificationUrlRegex: /(https:\/\/\S+)/i,
    userCodeRegex: /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/,
    successFile: successFileFor('kimi'),
  },
  // grok: `grok login --device-auth` (grok 1.0.30, captured 2026-09-14) prints:
  //   "To sign in, open this URL in your browser:
  //      https://accounts.x.ai/oauth2/device?user_code=CSXW-TMHH
  //    Confirm this code in your browser:
  //      CSXW-TMHH
  //    ... Waiting for authorization..." then "✓ Signed in as <email>".
  // Bare `grok login` defaults to `--oauth`, the loopback browser flow, so the
  // flag is what guarantees the device-code screen over SSH.
  grok: {
    loginCommand: 'grok login --device-auth',
    flowType: 'device-code',
    verificationUrlRegex: /open this URL in your browser:\s+(https:\/\/\S+)/i,
    userCodeRegex: /Confirm this code in your browser:\s+([A-Z0-9]{4}-[A-Z0-9]{4})/i,
    successFile: successFileFor('grok'),
  },
  // antigravity: bare `agy`, Google OAuth. Keychain-bound on macOS and loopback
  // (browser + 127.0.0.1 listener on the box itself) — non-remotable.
  antigravity: {
    loginCommand: 'agy',
    flowType: 'loopback',
    successFile: successFileFor('antigravity'),
  },
  // opencode: `opencode auth login`. No captured pattern — unknown/non-remotable.
  opencode: {
    loginCommand: 'opencode auth login',
    flowType: 'unknown',
    successFile: successFileFor('opencode'),
  },
  // claude: interactive `/login` inside the TUI is a loopback browser flow, and
  // the token is keychain-bound on macOS. That native login stays per-box and
  // is never copied. The shareable `claude setup-token` mint is a different
  // credential class — minted by `agents accounts add claude [name]` /
  // `agents accounts login claude#<name>` (`lib/auth-mint.ts`), not as a
  // fleet-login device-code flow (a setup-token is account-scoped, not
  // per-machine).
  claude: {
    loginCommand: 'claude',
    flowType: 'loopback',
    successFile: successFileFor('claude'),
  },
};

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
