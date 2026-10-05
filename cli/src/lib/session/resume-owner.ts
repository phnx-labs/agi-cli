
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { isSelfHost } from '../devices/self-host.js';

export const RESUME_PINNED_ENV = 'AGENTS_RESUME_PINNED';

export function consumeResumePinned(): boolean {
  const pinned = process.env[RESUME_PINNED_ENV] === '1';
  delete process.env[RESUME_PINNED_ENV];
  return pinned;
}

export function sessionOwnerDevice(session: Pick<SessionMeta, 'machine'>): string | undefined {
  const owner = session.machine?.trim();
  if (!owner) return undefined;
  return isSelfHost(owner) ? undefined : owner;
}
