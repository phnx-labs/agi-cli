/**
 * Managed backup encryption key (DEK) — mint, cache, escrow, recover.
 *
 * On the MANAGED path, a session backup is NEVER uploaded in plaintext. Every
 * transcript body is sealed with AES-256-GCM (the same `transcript-crypto.ts`
 * primitives BYO uses) under a 32-byte data-encryption key (DEK) minted per
 * Phoenix user.
 *
 * Where the DEK lives, and the honest trust boundary:
 *   - **Local cache** at `~/.agents/.cache/state/sessions-backup-key.json`
 *     (mode 0600), a `{ [userId]: <base64-dek> }` map so several Phoenix
 *     accounts on one box stay isolated. The Worker escrow remains authoritative.
 *   - **Escrow** at the bearer-gated Worker key `<userId>/__key/backup-dek`, so
 *     a FRESH box that signs in with the same Phoenix account recovers the DEK
 *     with zero setup and can decrypt its own prior backups.
 *
 * Trust boundary (documented honestly — SES-51):
 *   - Confidential vs a raw R2 / Cloudflare bucket read: objects at rest are
 *     ciphertext envelopes (SES-24 holds), and the DEK escrow object is itself
 *     only reachable with the owner's bearer.
 *   - NOT zero-knowledge vs Phoenix: the DEK is escrowed on Phoenix-operated
 *     infrastructure, so the operator *can* recover the key and read a backup.
 *     A user who needs a key Phoenix can never see uses BYO (`--byo`), which
 *     keeps the DEK only in their own `r2.backups` bundle — that is the
 *     zero-knowledge path.
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFileSync, ensureLockTarget, withFileLock } from '../../fs-atomic.js';
import { getRuntimeStateDir } from '../../state.js';
import { generateSyncEncKey } from './transcript-crypto.js';
import type { ManagedSessionsBackupClient } from './net-client.js';

const KEY_LEN = 32; // AES-256
/** Worker key (relative to the `<userId>/` namespace prefix the client prepends). */
export const ESCROW_REL_KEY = '__key/backup-dek';

/** Local per-user DEK cache file — a `{ [userId]: base64 }` map, mode 0600. */
export function backupKeyCachePath(): string {
  return path.join(getRuntimeStateDir(), 'sessions-backup-key.json');
}

interface DekCache {
  [userId: string]: string;
}

function readCache(): DekCache {
  try {
    const raw = fs.readFileSync(backupKeyCachePath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const cache = Object.create(null) as DekCache;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return cache;
    for (const [userId, value] of Object.entries(parsed)) {
      if (typeof value === 'string') cache[userId] = value;
    }
    return cache;
  } catch {
    return Object.create(null) as DekCache;
  }
}

/** Decode a base64/hex DEK into a 32-byte key, or null when it is malformed. */
function decodeDek(raw: string | undefined): Buffer | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const key = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  return key.length === KEY_LEN ? key : null;
}

/** The DEK cached locally for this Phoenix user, or null. */
export function readCachedBackupKey(userId: string): Buffer | null {
  return decodeDek(readCache()[userId]);
}

/** Persist a DEK (base64) for this Phoenix user in the local 0600 cache. */
function cacheBackupKey(userId: string, b64: string): void {
  const file = backupKeyCachePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  ensureLockTarget(file, '{}', 0o700);
  fs.chmodSync(file, 0o600);
  withFileLock(file, () => {
    const cache = readCache();
    cache[userId] = b64;
    atomicWriteFileSync(file, JSON.stringify(cache, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.chmodSync(file, 0o600);
  });
}

/** Serialized escrow object body stored at `<userId>/__key/backup-dek`. */
interface EscrowEnvelope {
  v: 1;
  userId: string;
  /** base64 of the 32-byte DEK. */
  dek: string;
}

function parseEscrow(body: string, expectedUserId: string): Buffer | null {
  try {
    const obj = JSON.parse(body) as EscrowEnvelope;
    if (
      obj && obj.v === 1 && obj.userId === expectedUserId &&
      typeof obj.dek === 'string'
    ) return decodeDek(obj.dek);
  } catch {
    /* not an escrow envelope */
  }
  return null;
}

/**
 * Resolve the managed backup DEK for `userId`, minting + escrowing one on first
 * use. NEVER returns null — the managed path must not upload plaintext.
 *
 * The escrow is authoritative. On a missing escrow, the local cache (if any) is
 * restored with a conditional create; otherwise a new key is minted. Concurrent
 * first-use devices race that create, then every loser reads the one winner
 * before encrypting anything, so no backup can be orphaned under a losing DEK.
 */
export async function resolveManagedBackupKey(
  client: ManagedSessionsBackupClient,
  userId: string,
): Promise<Buffer> {
  const escrowed = await client.get(ESCROW_REL_KEY);
  if (escrowed !== null) {
    const key = parseEscrow(escrowed, userId);
    if (key) {
      cacheBackupKey(userId, key.toString('base64'));
      return key;
    }
    throw new Error(
      'Managed session backup key escrow is corrupt or belongs to another account; ' +
      'refusing to replace it because that would orphan existing encrypted backups.',
    );
  }

  const cached = readCachedBackupKey(userId);
  const b64 = cached?.toString('base64') ?? generateSyncEncKey();
  const envelope: EscrowEnvelope = { v: 1, userId, dek: b64 };
  const created = await client.putIfAbsent(
    ESCROW_REL_KEY,
    JSON.stringify(envelope),
    'application/json',
  );
  if (created) {
    cacheBackupKey(userId, b64);
    return Buffer.from(b64, 'base64');
  }

  const winnerBody = await client.get(ESCROW_REL_KEY);
  const winner = winnerBody === null ? null : parseEscrow(winnerBody, userId);
  if (!winner) {
    throw new Error('Managed session backup key escrow was contended but no valid winning key could be recovered.');
  }
  cacheBackupKey(userId, winner.toString('base64'));
  return winner;
}
