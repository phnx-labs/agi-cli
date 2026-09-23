/**
 * Freshness of the fleet state exchange, for auth-sync's credential-push gate.
 *
 * This module used to be the bounded Git exchange (commit/rebase/push of the
 * user repo under a cross-process lock) and wrote a `.last-success` marker
 * beside its lock. The exchange now runs over SSH (PHNX-4116,
 * `accounting/usage-sync.ts`) and stamps `receivedAt` into every peer envelope
 * it stores, so the freshness signal is read from those files instead of a
 * marker. auth-sync still gates its pushes on this reading; PR 5 (PHNX-4116)
 * moves that gate onto the per-peer `receivedAt` and retires this module.
 */
import { newestPeerReceivedAtMs } from './fleet-shared-state.js';

/**
 * When a peer envelope last arrived on this box, in epoch ms — the last reply a
 * headed publisher collected, or the last push a worker received — or `null`
 * when no exchange has ever landed here.
 */
export function readLastSuccessfulExchangeMs(): number | null {
  return newestPeerReceivedAtMs();
}
