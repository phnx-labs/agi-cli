/**
 * Where a session may be resumed — the one place that answers "does this
 * transcript belong to another machine?" and, when it does, runs the resume
 * THERE instead of here.
 *
 * A session's agent state lives on the box that produced it: the harness keeps
 * its own conversation store under that machine's home, and `machine` on a
 * SessionMeta records where the transcript originated (see session/types.ts).
 * A row can reach this box two ways and BOTH are remote-owned:
 *
 *  - a **synced mirror** — locally readable at `backups/<agent>/<machine>/…`,
 *    which is exactly why the old code could not tell: the transcript file is
 *    right there, so nothing failed until the harness was asked to resume a
 *    conversation it has never seen;
 *  - a **live fan-out row** (`_remote`), whose `filePath` is on the peer's disk.
 *
 * Resuming either one locally starts the harness against state it does not
 * have. Before RUSH-2022 that happened silently — `sessions-resume.ts` even fell
 * back to `process.cwd()` when the recorded cwd did not exist locally, so a
 * remote session resumed in whatever directory the user happened to be in.
 *
 * Callers act on the answer differently, and the difference is deliberate:
 * `agents sessions resume` and `agents sessions attach` HOP to the owner over SSH, while
 * `resumeSessionInPlace` — the local takeover every routed caller reaches only
 * after deciding — REFUSES. The batch `sessions resume` needs no check of its
 * own: each of its tabs runs the canonical `agents sessions resume <id>`
 * (lib/session/resume-command.ts), which routes itself.
 */

import type { SessionMeta } from './types.js';
import { isSelfHost } from '../devices/self-host.js';

/**
 * Set on the SSH hop that sends a resume to its owning device: the far side must
 * run it, never route again.
 *
 * An env var rather than a flag, deliberately. The fleet is mixed-version — a
 * peer on the released CLI would die on an unknown `--here` with
 * `error: unknown option '--here'`, breaking the very hop this feature adds. An
 * unrecognized exported variable is inert on every version, so routing works
 * against old and new peers alike. The far side deletes it after reading
 * ({@link consumeResumePinned}) so it cannot leak into the agent's own children.
 */
export const RESUME_PINNED_ENV = 'AGENTS_RESUME_PINNED';

/**
 * Whether this process was handed a resume by its owner-routing hop — read once,
 * then cleared so a nested `agents sessions resume` inside the running agent still routes
 * normally.
 */
export function consumeResumePinned(): boolean {
  const pinned = process.env[RESUME_PINNED_ENV] === '1';
  delete process.env[RESUME_PINNED_ENV];
  return pinned;
}

/**
 * The peer that owns `session`'s state, or `undefined` when this machine does.
 *
 * Undefined is also the answer for an untagged row (`machine` unset — a session
 * obtained outside `discoverSessions`): there is nothing to route to, so the
 * caller keeps the local behaviour rather than inventing a target.
 */
export function sessionOwnerDevice(session: Pick<SessionMeta, 'machine'>): string | undefined {
  const owner = session.machine?.trim();
  if (!owner) return undefined;
  // `isSelfHost` matches every identity this box answers to — `machineId()`
  // itself, the tailnet dnsName and its short form, loopback (devices/
  // self-host.ts `selfAliases`) — so a mirror tagged with this machine's tailnet
  // name is local, not a peer (cf. RUSH-2114). No separate `machineId()`
  // comparison: it is one of those aliases.
  return isSelfHost(owner) ? undefined : owner;
}

