import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderSessionsWorkerScript } from './worker-template.js';
import { SessionsHttpClient } from './net-client.js';
import {
  backupKeyCachePath,
  ESCROW_REL_KEY,
  readCachedBackupKey,
  resolveManagedBackupKey,
} from './managed-key.js';


const PREV_STATE = process.env.AGENTS_STATE_DIR;

describe('managed session backup DEK — real Worker escrow', () => {
  let mf: Miniflare | undefined;
  let identity: Server | undefined;
  let root = '';
  let baseUrl = '';

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-dek-'));
    process.env.AGENTS_STATE_DIR = path.join(root, 'device-a');

    identity = createServer((request, response) => {
      if (request.url !== '/api/v1/auth/me') {
        response.writeHead(404).end();
        return;
      }
      const token = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const userId = token === 'token-a' ? 'user-a' : token === 'token-b' ? 'user-b' : null;
      if (!userId) {
        response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ userId, email: `${userId}@example.com` }));
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
    baseUrl = (await mf.ready).toString().replace(/\/+$/, '');
  });

  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
    await new Promise<void>(resolve => identity?.close(() => resolve()) ?? resolve());
    identity = undefined;
    if (PREV_STATE === undefined) delete process.env.AGENTS_STATE_DIR;
    else process.env.AGENTS_STATE_DIR = PREV_STATE;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function client(userId: string, token: string): SessionsHttpClient {
    return new SessionsHttpClient({ baseUrl, userId, token });
  }

  it('mints, conditionally escrows, and persists a 0600 per-user key', async () => {
    const key = await resolveManagedBackupKey(client('user-a', 'token-a'), 'user-a');
    expect(key.length).toBe(32);
    expect(readCachedBackupKey('user-a')?.equals(key)).toBe(true);
    expect(fs.statSync(backupKeyCachePath()).mode & 0o777).toBe(0o600);

    const bucket = await mf!.getR2Bucket('BUCKET');
    const escrow = await bucket.get(`user-a/${ESCROW_REL_KEY}`);
    expect(escrow).not.toBeNull();
    expect(JSON.parse(await escrow!.text())).toMatchObject({ v: 1, userId: 'user-a' });
  });

  it('recovers the identical key on a fresh device with no local cache', async () => {
    const first = await resolveManagedBackupKey(client('user-a', 'token-a'), 'user-a');
    process.env.AGENTS_STATE_DIR = path.join(root, 'device-b');
    const recovered = await resolveManagedBackupKey(client('user-a', 'token-a'), 'user-a');
    expect(recovered.equals(first)).toBe(true);
    expect(readCachedBackupKey('user-a')?.equals(first)).toBe(true);
  });

  it('isolates accounts locally and rejects a bearer for the wrong owner path', async () => {
    const keyA = await resolveManagedBackupKey(client('user-a', 'token-a'), 'user-a');
    const keyB = await resolveManagedBackupKey(client('user-b', 'token-b'), 'user-b');
    expect(keyA.equals(keyB)).toBe(false);
    expect(readCachedBackupKey('user-a')?.equals(keyA)).toBe(true);
    expect(readCachedBackupKey('user-b')?.equals(keyB)).toBe(true);

    process.env.AGENTS_STATE_DIR = path.join(root, 'wrong-owner-device');
    await expect(resolveManagedBackupKey(client('user-a', 'token-b'), 'user-a')).rejects.toThrow(/403/);
  });

  it('concurrent first-use devices converge on one immutable escrow key', async () => {
    const [a, b] = await Promise.all([
      resolveManagedBackupKey(client('user-a', 'token-a'), 'user-a'),
      resolveManagedBackupKey(client('user-a', 'token-a'), 'user-a'),
    ]);
    expect(a.equals(b)).toBe(true);
  });

  it('fails loud on corrupt escrow instead of replacing it and orphaning old backups', async () => {
    const bucket = await mf!.getR2Bucket('BUCKET');
    await bucket.put(`user-a/${ESCROW_REL_KEY}`, 'not-json');
    await expect(resolveManagedBackupKey(client('user-a', 'token-a'), 'user-a')).rejects.toThrow(/escrow is corrupt/);
    expect(await (await bucket.get(`user-a/${ESCROW_REL_KEY}`))!.text()).toBe('not-json');
  });
});
