/** Where a session may be resumed: the one place that decides whether a transcript belongs to
 * another machine and runs the resume there. Synced mirrors and live `_remote` rows are both
 * remote-owned (RUSH-2022); resuming locally started the harness on missing state. */

import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { isSelfHost } from '../devices/self-host.js';

/** Set on the SSH hop sending a resume to its owner: the far side must run it, never route again.
 * An env var, not a flag: old peers would die on an unknown `--here`. The far side clears it
 * (consumeResumePinned). */
export const RESUME_PINNED_ENV = 'AGENTS_RESUME_PINNED';

/** Whether this process was handed a resume by the owner-routing hop. Read once, then cleared
 * so a nested `agents sessions resume` inside the agent still routes normally. */
export function consumeResumePinned(): boolean {
  const pinned = process.env[RESUME_PINNED_ENV] === '1';
  delete process.env[RESUME_PINNED_ENV];
  return pinned;
}

/** The peer that owns the session's state, or undefined when this machine does. Also undefined
 * for an untagged row (`machine` unset): nothing to route to, so local behaviour is kept. */
export function sessionOwnerDevice(session: Pick<SessionMeta, 'machine'>): string | undefined {
  const owner = session.machine?.trim();
  if (!owner) return undefined;
  // `isSelfHost` matches every identity this box answers to (machineId, tailnet dnsName and short
  // form, loopback via `selfAliases`), so a mirror tagged with our tailnet name is local
  // (RUSH-2114). No separate machineId comparison needed.
  return isSelfHost(owner) ? undefined : owner;
}

