
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { isSelfHost } from '../devices/self-host.js';

// Mirror and live-peer rows are remote-owned; this mixed-version-safe pin prevents recursive rerouting.
export const RESUME_PINNED_ENV = 'AGENTS_RESUME_PINNED';

// Consume and delete once so the pin cannot leak into the resumed agent or nested session commands.
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
