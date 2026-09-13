/**
 * Client-side (zero-knowledge) encryption for session transcripts before they
 * leave this machine for R2.
 *
 * R2 encrypts objects at rest server-side (AES-256, Cloudflare default), but
 * that key is Cloudflare's — anyone with bucket-read access (or Cloudflare
 * itself) can read the plaintext. Transcripts carry secrets, tokens, and
 * absolute file paths, so "encrypted at rest by the provider" is not enough. We
 * seal each transcript BODY client-side with AES-256-GCM under a key that never
 * leaves the machines that share the sync bundle; Cloudflare only ever stores
 * ciphertext.
 *
 * The key is a 32-byte secret (`R2_SYNC_ENC_KEY`) held in the same
 * keychain-backed `r2.backups` bundle as the R2 credentials. Every machine in
 * the sync fabric shares that bundle, so every machine derives the identical key
 * and can decrypt its peers' objects. The key is deliberately SEPARATE from the
 * R2 access key so that rotating the R2 token (RUSH-1464) never orphans
 * transcripts already encrypted under the old one.
 *
 * Identity for CRDT merge stays over PLAINTEXT: the manifest hash is computed on
 * the cleartext transcript (sync.ts), and pull decrypts before the G-Set union
 * (crdt.ts) ever sees the bytes. Ciphertext is non-deterministic (a fresh random
 * IV per seal), so it is never usable as an identity — which is exactly why the
 * manifest, not the object body, carries the hash.
 */

import * as crypto from 'crypto';
import type { R2Config } from './config.js';

const ALG = 'aes-256-gcm';
const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // GCM standard nonce
const TAG_LEN = 16;

/** Serialized envelope stored as the R2 object body when encryption is on. */
interface TranscriptEnvelope {
  /** Envelope format version. */
  v: 1;
  alg: 'aes-256-gcm';
  /** base64 12-byte GCM nonce, fresh per object. */
  iv: string;
  /** base64 ciphertext. */
  ct: string;
  /** base64 16-byte GCM auth tag. */
  tag: string;
}

/**
 * Decode the configured `R2_SYNC_ENC_KEY` into a 32-byte key, or null when the
 * bundle does not carry one (encryption off — see pushOwn's warning path).
 *
 * Accepts hex (64 chars) or base64; both must decode to exactly 32 bytes. A key
 * that is present but the wrong length THROWS rather than silently truncating —
 * a malformed key is a configuration bug, not a reason to fall back to a weaker
 * or wrong key.
 */
export function resolveSyncEncKey(cfg: Pick<R2Config, 'syncEncKey'>): Buffer | null {
  const raw = cfg.syncEncKey?.trim();
  if (!raw) return null;

  let key: Buffer;
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }
  if (key.length !== KEY_LEN) {
    throw new Error(
      `R2_SYNC_ENC_KEY must decode to ${KEY_LEN} bytes (got ${key.length}). ` +
      `Provide 32 random bytes as hex (64 chars) or base64. ` +
      `Generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

/** Generate a fresh 32-byte transcript key, base64-encoded (for provisioning). */
export function generateSyncEncKey(): string {
  return crypto.randomBytes(KEY_LEN).toString('base64');
}

/** Seal a transcript body. Returns the serialized envelope to store in R2. */
export function encryptTranscript(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope: TranscriptEnvelope = {
    v: 1,
    alg: ALG,
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: tag.toString('base64'),
  };
  return JSON.stringify(envelope);
}

/**
 * Parse a stored object body into an envelope, or null when it is not one.
 *
 * A plaintext transcript is NDJSON — many JSON objects, one per line — so it
 * never parses as a single object carrying our `v`/`alg`/`ct`/`tag` fields. That
 * makes envelope-vs-plaintext detection unambiguous and lets a puller read BOTH
 * encrypted objects and any legacy plaintext already in the bucket (the beta
 * uploaded plaintext before this landed). This is format-version handling for a
 * real migration, not a "just in case" fallback.
 */
export function parseEnvelope(body: string): TranscriptEnvelope | null {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith('{')) return null; // NDJSON first line is an object too, but…
  let obj: unknown;
  try {
    obj = JSON.parse(body); // …the WHOLE body must be one JSON value to be an envelope
  } catch {
    return null;
  }
  if (
    obj && typeof obj === 'object' &&
    (obj as TranscriptEnvelope).v === 1 &&
    (obj as TranscriptEnvelope).alg === ALG &&
    typeof (obj as TranscriptEnvelope).iv === 'string' &&
    typeof (obj as TranscriptEnvelope).ct === 'string' &&
    typeof (obj as TranscriptEnvelope).tag === 'string'
  ) {
    return obj as TranscriptEnvelope;
  }
  return null;
}

/** True when a stored object body is one of our encryption envelopes. */
export function isTranscriptEnvelope(body: string): boolean {
  return parseEnvelope(body) !== null;
}

/** Open a sealed envelope. Throws on a wrong key / tampered body (GCM tag mismatch). */
export function decryptEnvelope(envelope: TranscriptEnvelope, key: Buffer): string {
  const iv = Buffer.from(envelope.iv, 'base64');
  const ct = Buffer.from(envelope.ct, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  if (tag.length !== TAG_LEN) {
    throw new Error(`Transcript envelope has a malformed auth tag (${tag.length} bytes).`);
  }
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
  } catch {
    throw new Error('Transcript decryption failed — wrong R2_SYNC_ENC_KEY or corrupt object.');
  }
}

/**
 * Return the plaintext transcript for a fetched object body, transparently
 * decrypting when it is an envelope.
 *
 *  - Envelope + key  → decrypted plaintext.
 *  - Envelope + no key → throws (the object is encrypted but this machine has no
 *    key to read it — surfacing that beats silently mis-merging ciphertext).
 *  - Plaintext body  → returned verbatim (legacy/unencrypted object).
 */
export function decryptTranscriptBody(body: string, key: Buffer | null): string {
  const envelope = parseEnvelope(body);
  if (!envelope) return body; // legacy plaintext object
  if (!key) {
    throw new Error(
      'Fetched an encrypted transcript but R2_SYNC_ENC_KEY is not set in the r2.backups bundle. ' +
      'Add the shared key so this machine can decrypt peers\' sessions.',
    );
  }
  return decryptEnvelope(envelope, key);
}
