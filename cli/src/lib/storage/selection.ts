// Managed storage is selected only for signed-in non-BYO callers; this is a decision, not a fallback chain.

import { readSession, type PhoenixSession } from '../identity/client.js';

export type StorageBackendKind = 'managed' | 'byo';

export interface StorageSelectionOpts {
  byoOverride?: boolean;
  session?: PhoenixSession | null;
}

export function selectStorageBackendKind(opts: StorageSelectionOpts = {}): StorageBackendKind {
  if (opts.byoOverride === true) return 'byo';
  const session = opts.session === undefined ? readSession() : opts.session;
  return session != null ? 'managed' : 'byo';
}

export function isManagedSelection(opts: StorageSelectionOpts = {}): boolean {
  return selectStorageBackendKind(opts) === 'managed';
}
