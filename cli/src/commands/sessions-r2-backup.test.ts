/**
 * Direct coverage for the R2 backup COMMAND layer (RUSH-2437) — the functions
 * `agents sessions export --to-r2` / `import --from-r2` actually call, not just
 * the low-level R2Client (that is `lib/session/sync/r2.test.ts`). Two tiers:
 *
 *  - Pure, always-run: the fail-loud gates (`r2ExportGateError`,
 *    `r2ImportGateError`), the object-key selection (`r2KeyForRecord`), and the
 *    backup-key resolution (`resolveR2BackupKey`) against the real standalone
 *    `secrets` engine (PHNX-3989) in a fresh, isolated store — no mocking of
 *    the resolver.
 *  - MinIO-gated round-trip: `uploadToR2` → `pullFromR2` against a real
 *    S3-compatible endpoint, so the ACTUAL command functions (not a hand-copied
 *    wire format) are exercised end-to-end. SKIPS when AGENTS_TEST_R2_ENDPOINT is
 *    unset — see r2.test.ts for the MinIO one-liner.
 *
 * No HTTP mocking anywhere (repo "real services only" rule). Precedent for
 * importing + unit-testing a command helper directly: sessions-export-resolve.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Miniflare } from 'miniflare';
import {
  r2ExportGateError,
  r2KeyForRecord,
  resolveR2BackupKey,
  uploadToR2,
  managedUploadEncryptionError,
} from './sessions-export.js';
import { r2ImportGateError, pullFromR2 } from './sessions-import.js';
import { buildRecord, makeHeader, parseBundle, type BundleRecord } from '../lib/session/bundle.js';
import { clearR2ConfigCache, SYNC_BUNDLE } from '../lib/session/sync/config.js';
import { R2Client } from '../lib/session/sync/r2.js';
import { decryptTranscriptBody, generateSyncEncKey, isTranscriptEnvelope } from '../lib/session/sync/transcript-crypto.js';
import { renderSessionsWorkerScript } from '../lib/session/sync/worker-template.js';
import { SessionsHttpClient } from '../lib/session/sync/net-client.js';
import { resolveManagedBackupKey, backupKeyCachePath } from '../lib/session/sync/managed-key.js';
import { writeBundle } from '../lib/secrets-client.js';
import type { SecretsBundle } from '../lib/secrets-types.js';
import { useFreshSecretsHome } from '../../tests/secrets-standalone.js';

async function writeR2Bundle(vars: Record<string, string>): Promise<void> {
  const b: SecretsBundle = { name: SYNC_BUNDLE, policy: 'never', vars };
  await writeBundle(b);
}

// ── pure gate + key helpers (always run) ──────────────────────────────────────

describe('R2 backup gates (pure)', () => {
  it('r2ExportGateError: no error when --to-r2 is absent', () => {
    expect(r2ExportGateError({}, false)).toBeNull();
    expect(r2ExportGateError({ toR2: false, host: ['boxB'] }, false)).toBeNull();
  });

  it('r2ExportGateError: --to-r2 + --device is rejected before anything runs', () => {
    const err = r2ExportGateError({ toR2: true, host: ['boxB'] }, true);
    expect(err).toBeTruthy();
    expect(err).toContain('cannot be combined with --device');
  });

  it('r2ExportGateError: --to-r2 with an unconfigured bundle fails loud', () => {
    const err = r2ExportGateError({ toR2: true }, false);
    expect(err).toBeTruthy();
    expect(err).toContain('not configured');
    expect(err).toContain('agents secrets add r2.backups');
  });

  it('r2ExportGateError: --to-r2 configured, no host → proceed (null)', () => {
    expect(r2ExportGateError({ toR2: true }, true)).toBeNull();
  });

  it('r2ImportGateError: only fails loud when --from-r2 and unconfigured', () => {
    expect(r2ImportGateError(false, false)).toBeNull();
    expect(r2ImportGateError(true, true)).toBeNull();
    const err = r2ImportGateError(true, false);
    expect(err).toContain('not configured');
    expect(err).toContain('agents secrets add r2.backups');
  });
});

describe('r2KeyForRecord (object-key selection)', () => {
  const base = { size: 0, hash: 'h', encrypted: false, body: '' };

  it('file-shaped agent keys by session, ignoring relKey', () => {
    const rec: BundleRecord = { ...base, agent: 'claude', machine: 'm1', sessionId: 'sid', relKey: 'projects/p/sid.jsonl' };
    expect(r2KeyForRecord(rec)).toBe('sessions/m1/claude/sid.jsonl');
  });

  it('dir-shaped agent (kimi) keys by relKey under the session dir', () => {
    const rec: BundleRecord = { ...base, agent: 'kimi', machine: 'm1', sessionId: 'session_x', relKey: 'session_x/state.json' };
    expect(r2KeyForRecord(rec)).toBe('sessions/m1/kimi/session_x/session_x/state.json');
  });
});

describe('managed upload encryption boundary', () => {
  const record: BundleRecord = {
    agent: 'claude', machine: 'm1', sessionId: 's1', relKey: 's1.jsonl',
    size: 9, hash: 'h', encrypted: true, body: 'plaintext',
  };

  it('rejects a record that claims encryption without carrying an AES-GCM envelope', () => {
    const header = makeHeader({
      origin: 'm1', exportedAt: new Date(0).toISOString(), encrypted: true,
      redacted: true, records: [record],
    });
    expect(managedUploadEncryptionError(header, [record])).toMatch(/refusing to upload plaintext/);
  });
});

describe('resolveR2BackupKey (real standalone secrets store)', () => {
  useFreshSecretsHome();

  beforeEach(() => {
    clearR2ConfigCache();
  });
  afterEach(() => {
    clearR2ConfigCache();
  });

  it('returns the shared 32-byte key when R2_SYNC_ENC_KEY is present', async () => {
    const enc = generateSyncEncKey();
    await writeR2Bundle({
      R2_ACCOUNT_ID: 'acct', R2_BUCKET_NAME: 'b', R2_ACCESS_KEY_ID: 'ak', R2_SECRET_ACCESS_KEY: 'sk',
      R2_SYNC_ENC_KEY: enc,
    });
    const key = resolveR2BackupKey();
    expect(key).not.toBeNull();
    expect(key!.length).toBe(32);
    expect(key!.toString('base64')).toBe(enc);
  });

  it('returns null (unencrypted, warned) when the bundle carries no enc key', async () => {
    await writeR2Bundle({ R2_ACCOUNT_ID: 'acct', R2_BUCKET_NAME: 'b', R2_ACCESS_KEY_ID: 'ak', R2_SECRET_ACCESS_KEY: 'sk' });
    expect(resolveR2BackupKey()).toBeNull();
  });
});

// ── MinIO-gated round-trip through the real command functions ──────────────────

const ENDPOINT = process.env.AGENTS_TEST_R2_ENDPOINT ?? '';
const BUCKET = process.env.AGENTS_TEST_R2_BUCKET ?? '';
const ACCESS = process.env.AGENTS_TEST_R2_ACCESS_KEY_ID ?? '';
const SECRET = process.env.AGENTS_TEST_R2_SECRET_ACCESS_KEY ?? '';
const ACCOUNT = process.env.AGENTS_TEST_R2_ACCOUNT_ID ?? 'test-account';
const CONFIGURED = Boolean((ENDPOINT || ACCOUNT !== 'test-account') && BUCKET && ACCESS && SECRET);
const suite = CONFIGURED ? describe : describe.skip;

// Unique machine per run so this test's objects are isolated from r2.test.ts's,
// which also targets the same bucket in parallel.
const RUN = `r2cmd-${process.pid}-${Math.floor(Number(process.hrtime.bigint() % 1_000_000n))}`;

suite('uploadToR2 → pullFromR2 round-trip (AGENTS_TEST_R2_ENDPOINT)', () => {
  const rawClient = new R2Client({
    accountId: ACCOUNT, bucket: BUCKET, accessKeyId: ACCESS, secretAccessKey: SECRET,
    endpoint: ENDPOINT || `https://${ACCOUNT}.r2.cloudflarestorage.com`,
  });

  useFreshSecretsHome();

  beforeEach(async () => {
    clearR2ConfigCache();
    // A real r2.backups bundle pointing at the test endpoint, so the command
    // functions' own loadR2Config() resolves it — no injection, real path.
    await writeR2Bundle({
      R2_ACCOUNT_ID: ACCOUNT, R2_BUCKET_NAME: BUCKET, R2_ACCESS_KEY_ID: ACCESS,
      R2_SECRET_ACCESS_KEY: SECRET, R2_ENDPOINT: ENDPOINT || '',
      R2_SYNC_ENC_KEY: generateSyncEncKey(),
    });
  });
  afterEach(() => {
    clearR2ConfigCache();
  });

  afterAll(async () => {
    for (const key of await rawClient.list(`sessions/${RUN}/`)) {
      try { await rawClient.delete(key); } catch { /* already gone */ }
    }
  });

  it('backs up an encrypted + a plaintext session, skips a non-bundle object, restores both', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r2cmd-'));
    const encAbs = path.join(tmp, 'enc.jsonl');
    const plainAbs = path.join(tmp, 'plain.jsonl');
    const encPlain = '{"role":"user","content":"secret token sk-XYZ"}\n';
    const plainPlain = '{"role":"user","content":"no secret here"}\n';
    fs.writeFileSync(encAbs, encPlain, 'utf-8');
    fs.writeFileSync(plainAbs, plainPlain, 'utf-8');

    // Encrypted record via the command's OWN key resolution.
    const key = resolveR2BackupKey();
    expect(key).not.toBeNull();
    const encRec = buildRecord(
      { agent: 'claude', machine: RUN, sessionId: 'enc-1', relKey: 'projects/p/enc-1.jsonl', absPath: encAbs },
      { redact: true, encryptKey: key },
    );
    const plainRec = buildRecord(
      { agent: 'codex', machine: RUN, sessionId: 'plain-1', relKey: 'plain-1.jsonl', absPath: plainAbs },
      { redact: true, encryptKey: null },
    );
    expect(encRec.encrypted).toBe(true);
    expect(plainRec.encrypted).toBe(false);

    // Upload through the REAL command function.
    const header = makeHeader({
      origin: RUN, exportedAt: new Date().toISOString(),
      encrypted: true, redacted: true, records: [encRec, plainRec],
    });
    await uploadToR2(header, [encRec, plainRec]);

    // Objects landed at the shared key layout.
    const listed = await rawClient.list(`sessions/${RUN}/`);
    expect(listed).toContain('sessions/' + RUN + '/claude/enc-1.jsonl');
    expect(listed).toContain('sessions/' + RUN + '/codex/plain-1.jsonl');

    // A non-bundle object under the same prefix must be skipped, not fatal.
    const junkKey = `sessions/${RUN}/claude/junk-not-a-bundle.jsonl`;
    await rawClient.put(junkKey, 'this is not json at all', 'text/plain');

    // Restore through the REAL command function.
    const restored = await pullFromR2();
    const mine = restored.records.filter(r => r.machine === RUN);
    const enc = mine.find(r => r.sessionId === 'enc-1');
    const plain = mine.find(r => r.sessionId === 'plain-1');
    expect(enc).toBeTruthy();
    expect(plain).toBeTruthy();
    // Header reflects that at least one record is encrypted.
    expect(restored.header.encrypted).toBe(true);
    // The junk object was skipped — no restored record carries its body.
    expect(mine.some(r => r.body.includes('not json at all'))).toBe(false);
    // The encrypted body decrypts back to the original with the shared key.
    expect(enc!.encrypted).toBe(true);
    expect(enc!.body).not.toContain('sk-XYZ');
    expect(decryptTranscriptBody(enc!.body, key)).toBe(encPlain);
    // The plaintext body round-trips verbatim.
    expect(plain!.body).toBe(plainPlain);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ── MANAGED round-trip through the real Worker (workerd/miniflare) ─────────────
// The managed path uploads through SessionsHttpClient to the real managed Worker
// source in workerd, whose default verifier calls a real local Phoenix HTTP
// service. It proves every uploaded record body is an ENCRYPTED envelope, restore
// round-trips, and a fresh box recovers the escrowed DEK without r2.backups.

describe('managed backup round-trip (real workerd, escrowed DEK)', () => {
  let mf: Miniflare | undefined;
  let identity: Server | undefined;
  let base = '';
  let stateDir = '';
  const PREV_STATE = process.env.AGENTS_STATE_DIR;
  const USER = 'managed-user';

  beforeEach(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msess-state-'));
    process.env.AGENTS_STATE_DIR = stateDir; // isolates the DEK cache
    identity = createServer((request, response) => {
      if (request.url !== '/api/v1/auth/me' || request.headers.authorization !== 'Bearer managed-token') {
        response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ userId: USER, email: 'managed@example.com' }));
    });
    await new Promise<void>((resolve, reject) => {
      identity!.once('error', reject);
      identity!.listen(0, '127.0.0.1', resolve);
    });
    const port = (identity.address() as AddressInfo).port;
    mf = new Miniflare({
      modules: [{ type: 'ESModule', path: 'worker.js', contents: renderSessionsWorkerScript() }],
      r2Buckets: ['BUCKET'],
      bindings: { PHOENIX_ID_BASE: `http://127.0.0.1:${port}` },
    });
    base = (await mf.ready).toString().replace(/\/+$/, '');
  });
  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
    await new Promise<void>(resolve => identity?.close(() => resolve()) ?? resolve());
    identity = undefined;
    if (PREV_STATE === undefined) delete process.env.AGENTS_STATE_DIR;
    else process.env.AGENTS_STATE_DIR = PREV_STATE;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('uploads only ciphertext, restores it, and a fresh box recovers the DEK', async () => {
    const client = new SessionsHttpClient({ baseUrl: base, userId: USER, token: 'managed-token' });
    const dek = await resolveManagedBackupKey(client, USER);
    expect(dek.length).toBe(32);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msess-'));
    const a = path.join(tmp, 'a.jsonl');
    const b = path.join(tmp, 'b.jsonl');
    const aPlain = '{"role":"user","content":"secret token sk-ABC"}\n';
    const bPlain = '{"role":"user","content":"nothing here"}\n';
    fs.writeFileSync(a, aPlain);
    fs.writeFileSync(b, bPlain);

    // Managed ALWAYS encrypts — every record is sealed under the DEK.
    const recA = buildRecord({ agent: 'claude', machine: 'boxA', sessionId: 'm1', relKey: 'projects/p/m1.jsonl', absPath: a }, { redact: true, encryptKey: dek });
    const recB = buildRecord({ agent: 'codex', machine: 'boxA', sessionId: 'm2', relKey: 'm2.jsonl', absPath: b }, { redact: true, encryptKey: dek });
    expect(recA.encrypted).toBe(true);
    expect(recB.encrypted).toBe(true);
    // The record body is a ciphertext envelope, never the plaintext.
    expect(isTranscriptEnvelope(recA.body)).toBe(true);
    expect(recA.body).not.toContain('sk-ABC');

    const header = makeHeader({ origin: 'boxA', exportedAt: new Date().toISOString(), encrypted: true, redacted: true, records: [recA, recB] });
    await uploadToR2(header, [recA, recB], client);

    // The RAW stored objects are envelopes — Cloudflare only ever sees ciphertext.
    const rawA = await client.get('sessions/boxA/claude/m1.jsonl');
    expect(rawA).not.toBeNull();
    const rawBundle = parseBundle(rawA!);
    expect(rawBundle.records).toHaveLength(1);
    expect(rawBundle.records[0]?.encrypted).toBe(true);
    expect(isTranscriptEnvelope(rawBundle.records[0]?.body ?? '')).toBe(true);
    expect(rawA!).not.toContain('sk-ABC');

    // Restore through the real command function against the real Worker.
    const restored = await pullFromR2(client);
    expect(restored.header.encrypted).toBe(true);
    const rM1 = restored.records.find(r => r.sessionId === 'm1');
    expect(rM1).toBeTruthy();
    expect(decryptTranscriptBody(rM1!.body, dek)).toBe(aPlain);

    // Fresh box: wipe the local DEK cache, re-resolve — it must RECOVER the same
    // escrowed key (zero setup), and decrypt the restored backup identically.
    fs.rmSync(backupKeyCachePath(), { force: true });
    const client2 = new SessionsHttpClient({ baseUrl: base, userId: USER, token: 'managed-token' });
    const dek2 = await resolveManagedBackupKey(client2, USER);
    expect(dek2.equals(dek)).toBe(true);
    const restored2 = await pullFromR2(client2);
    const rM1b = restored2.records.find(r => r.sessionId === 'm1');
    expect(decryptTranscriptBody(rM1b!.body, dek2)).toBe(aPlain);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
