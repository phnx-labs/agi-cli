
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { isSelfHost } from '../devices/self-host.js';

export function sessionOwnerDevice(session: Pick<SessionMeta, 'machine'>): string | undefined {
  const owner = session.machine?.trim();
  if (!owner) return undefined;
  return isSelfHost(owner) ? undefined : owner;
}
