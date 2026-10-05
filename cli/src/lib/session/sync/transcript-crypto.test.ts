import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import {
  resolveSyncEncKey,
  generateSyncEncKey,
  encryptTranscript,
  decryptEnvelope,
  parseEnvelope,
  isTranscriptEnvelope,
  decryptTranscriptBody,
} from './transcript-crypto.js';

const KEY = crypto.randomBytes(32);
const TRANSCRIPT =
  JSON.stringify({ type: 'user', text: 'sk-secret-token-abc123', timestamp: '2026-07-01T00:00:00Z' }) + '\n' +
  JSON.stringify({ type: 'assistant', text: '/Users/muqsit/private/path', timestamp: '2026-07-01T00:00:01Z' }) + '\n';

describe('resolveSyncEncKey', () => {
  it('returns null when no key is configured', () => {
    expect(resolveSyncEncKey({ syncEncKey: undefined })).toBeNull();
    expect(resolveSyncEncKey({ syncEncKey: '   ' })).toBeNull();
  });

  it('decodes a 32-byte base64 key', () => {
    const b64 = KEY.toString('base64');
    expect(resolveSyncEncKey({ syncEncKey: b64 })!.equals(KEY)).toBe(true);
  });

  it('decodes a 64-char hex key', () => {
    const hex = KEY.toString('hex');
    expect(resolveSyncEncKey({ syncEncKey: hex })!.equals(KEY)).toBe(true);
  });

  it('throws on a key that decodes to the wrong length (no silent truncation)', () => {
    expect(() => resolveSyncEncKey({ syncEncKey: Buffer.alloc(16).toString('base64') })).toThrow(/32 bytes/);
  });

  it('generateSyncEncKey produces a usable 32-byte key', () => {
    const gen = generateSyncEncKey();
    expect(resolveSyncEncKey({ syncEncKey: gen })!.length).toBe(32);
  });
});

describe('encrypt/decrypt round-trip', () => {
  it('recovers the exact plaintext', () => {
    const sealed = encryptTranscript(TRANSCRIPT, KEY);
    const env = parseEnvelope(sealed)!;
    expect(decryptEnvelope(env, KEY)).toBe(TRANSCRIPT);
  });

  it('ciphertext does NOT leak plaintext secrets', () => {
    const sealed = encryptTranscript(TRANSCRIPT, KEY);
    expect(sealed).not.toContain('sk-secret-token-abc123');
    expect(sealed).not.toContain('/Users/muqsit/private/path');
  });

  it('a fresh IV per seal makes ciphertext non-deterministic', () => {
    const a = encryptTranscript(TRANSCRIPT, KEY);
    const b = encryptTranscript(TRANSCRIPT, KEY);
    expect(a).not.toBe(b);
    expect(decryptEnvelope(parseEnvelope(a)!, KEY)).toBe(decryptEnvelope(parseEnvelope(b)!, KEY));
  });

  it('wrong key fails the GCM auth tag (no plaintext leak)', () => {
    const sealed = encryptTranscript(TRANSCRIPT, KEY);
    const wrong = crypto.randomBytes(32);
    expect(() => decryptEnvelope(parseEnvelope(sealed)!, wrong)).toThrow(/decryption failed/i);
  });

  it('a tampered ciphertext fails the auth tag', () => {
    const env = parseEnvelope(encryptTranscript(TRANSCRIPT, KEY))!;
    const ctBytes = Buffer.from(env.ct, 'base64');
    ctBytes[0] ^= 0xff;
    const tampered = { ...env, ct: ctBytes.toString('base64') };
    expect(() => decryptEnvelope(tampered, KEY)).toThrow();
  });

  it('two machines sharing the key decrypt each other (deterministic key derivation)', () => {
    const b64 = KEY.toString('base64');
    const keyA = resolveSyncEncKey({ syncEncKey: b64 })!;
    const keyB = resolveSyncEncKey({ syncEncKey: b64 })!;
    const sealedByA = encryptTranscript(TRANSCRIPT, keyA);
    expect(decryptTranscriptBody(sealedByA, keyB)).toBe(TRANSCRIPT);
  });
});

describe('envelope detection (migration-safe pull)', () => {
  it('recognizes our envelope', () => {
    expect(isTranscriptEnvelope(encryptTranscript(TRANSCRIPT, KEY))).toBe(true);
  });

  it('does NOT mistake NDJSON plaintext for an envelope', () => {
    expect(isTranscriptEnvelope(TRANSCRIPT)).toBe(false);
    expect(isTranscriptEnvelope(JSON.stringify({ type: 'user', v: 1 }) + '\n')).toBe(false);
  });

  it('decryptTranscriptBody passes plaintext through verbatim', () => {
    expect(decryptTranscriptBody(TRANSCRIPT, KEY)).toBe(TRANSCRIPT);
    expect(decryptTranscriptBody(TRANSCRIPT, null)).toBe(TRANSCRIPT);
  });

  it('decryptTranscriptBody throws on an envelope when the machine has no key', () => {
    const sealed = encryptTranscript(TRANSCRIPT, KEY);
    expect(() => decryptTranscriptBody(sealed, null)).toThrow(/R2_SYNC_ENC_KEY is not set/);
  });
});
