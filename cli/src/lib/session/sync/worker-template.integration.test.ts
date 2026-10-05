import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderSessionsWorkerScript } from './worker-template.js';


const USER_A = 'user-a';
const USER_B = 'user-b';
const MAX_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_OBJECTS = 200_000;

function mutationPathId(objectPath: string): string {
  return createHash('sha256').update(objectPath).digest('hex');
}

function mutationLeaseKey(owner: string, objectPath: string): string {
  return `__mutation/${owner}/${mutationPathId(objectPath)}`;
}

describe('managed sessions Worker in real workerd', () => {
  let mf: Miniflare | undefined;
  let identity: Server | undefined;

  beforeEach(async () => {
    identity = createServer((request, response) => {
      if (request.url !== '/api/v1/auth/me') {
        response.writeHead(404).end();
        return;
      }
      const token = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const userId = token === 'token-a' ? USER_A : token === 'token-b' ? USER_B : null;
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
    await mf.ready;
  });

  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
    await new Promise<void>(resolve => identity?.close(() => resolve()) ?? resolve());
    identity = undefined;
  });

  const url = (path: string) => `https://sessions.test/${path}`;
  const auth = (token = 'token-a') => ({ authorization: `Bearer ${token}` });
  const encBody = (marker: string) => {
    const env = JSON.stringify({ v: 1, alg: 'aes-256-gcm', iv: 'AAAAAAAAAAAAAAAA', ct: Buffer.from(marker).toString('base64'), tag: 'AAAAAAAAAAAAAAAAAAAAAA==' });
    const header = JSON.stringify({
      kind: 'agents-session-bundle', version: 1, exportedAt: '2026-09-01T00:00:00.000Z',
      origin: 'test', encrypted: true, redacted: true, count: 1, sessions: 1,
    });
    const record = JSON.stringify({
      agent: 'claude', machine: 'test', sessionId: marker, relKey: `${marker}.jsonl`,
      size: marker.length, hash: 'test', encrypted: true, body: env,
    });
    return `${header}\n${record}\n`;
  };

  it('PUT / GET / LIST / DELETE round-trips in the verified owner namespace', async () => {
    const keyA = `${USER_A}/sessions/mac/claude/s1.jsonl`;
    const keyB = `${USER_A}/sessions/mac/codex/s2.jsonl`;
    const bodyA = encBody('s1');
    const put = await mf!.dispatchFetch(url(keyA), {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: bodyA,
    });
    expect(put.status).toBe(200);

    const get = await mf!.dispatchFetch(url(keyA), { headers: auth() });
    expect(get.status).toBe(200);
    expect(await get.text()).toBe(bodyA);
    expect(get.headers.get('cache-control')).toBe('private, no-store');

    await mf!.dispatchFetch(url(keyB), { method: 'PUT', headers: auth(), body: encBody('s2') });
    const list = await mf!.dispatchFetch(url(`${USER_A}/?list`), { headers: auth() });
    expect(list.status).toBe(200);
    expect((await list.json() as { keys: string[] }).keys).toEqual([
      'sessions/mac/claude/s1.jsonl',
      'sessions/mac/codex/s2.jsonl',
    ]);

    expect((await mf!.dispatchFetch(url(keyA), { method: 'DELETE', headers: auth() })).status).toBe(200);
    expect((await mf!.dispatchFetch(url(keyA), { headers: auth() })).status).toBe(404);
    const afterDelete = await mf!.dispatchFetch(url(`${USER_A}/?list`), { headers: auth() });
    expect((await afterDelete.json() as { keys: string[] }).keys).toEqual([
      'sessions/mac/codex/s2.jsonl',
    ]);
  });

  it('rejects a plaintext (non-envelope) body with 422', async () => {
    const key = `${USER_A}/sessions/mac/claude/plain.jsonl`;
    for (const body of ['{"env":"v1"}', 'x']) {
      const put = await mf!.dispatchFetch(url(key), { method: 'PUT', headers: auth(), body });
      expect(put.status).toBe(422);
    }
    const list = await mf!.dispatchFetch(url(`${USER_A}/?list`), { headers: auth() });
    expect((await list.json() as { keys: string[] }).keys).toEqual([]);
  });

  it('rejects a readable fake envelope with the wrong algorithm and dimensions', async () => {
    const key = `${USER_A}/sessions/mac/claude/fake.jsonl`;
    const header = JSON.stringify({
      kind: 'agents-session-bundle', version: 1, exportedAt: '2026-09-01T00:00:00.000Z',
      origin: 'test', encrypted: true, redacted: true, count: 1, sessions: 1,
    });
    const fake = JSON.stringify({
      agent: 'claude', machine: 'test', sessionId: 'fake', relKey: 'fake.jsonl',
      size: 18, hash: 'test', encrypted: true,
      body: JSON.stringify({ v: 1, alg: 'not-aes', iv: 'x', ct: 'READABLE PLAINTEXT', tag: 'x' }),
    });
    const put = await mf!.dispatchFetch(url(key), {
      method: 'PUT', headers: auth(), body: `${header}\n${fake}\n`,
    });
    expect(put.status).toBe(422);
    expect(await (await mf!.dispatchFetch(url(key), { headers: auth() })).status).toBe(404);
  });

  it('has no public object/list GET and rejects a verified wrong owner', async () => {
    const key = `${USER_A}/sessions/mac/claude/s1.jsonl`;
    expect((await mf!.dispatchFetch(url(''))).status).toBe(401);
    expect((await mf!.dispatchFetch(url(key))).status).toBe(401);
    expect((await mf!.dispatchFetch(url(`${USER_A}/?list`))).status).toBe(401);
    expect((await mf!.dispatchFetch(url(key), { headers: auth('token-b') })).status).toBe(403);
    expect((await mf!.dispatchFetch(url(key), {
      method: 'PUT', headers: auth('token-b'), body: encBody('x'),
    })).status).toBe(403);
  });

  it('keeps __key/__usage out of LIST and makes the backup DEK immutable', async () => {
    const escrow = `${USER_A}/__key/backup-dek`;
    const first = await mf!.dispatchFetch(url(escrow), {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json', 'if-none-match': '*' },
      body: '{"v":1,"userId":"user-a","dek":"first"}',
    });
    expect(first.status).toBe(200);
    const overwrite = await mf!.dispatchFetch(url(escrow), {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json', 'if-none-match': '*' },
      body: '{"v":1,"userId":"user-a","dek":"second"}',
    });
    expect(overwrite.status).toBe(409);
    expect((await mf!.dispatchFetch(url(escrow), {
      method: 'DELETE', headers: auth(),
    })).status).toBe(403);
    expect((await mf!.dispatchFetch(url(`${USER_A}/__key/unbounded`), {
      method: 'PUT', headers: auth(), body: 'hidden payload',
    })).status).toBe(403);
    expect(await (await mf!.dispatchFetch(url(escrow), { headers: auth() })).text()).toContain('"dek":"first"');

    const bucket = await mf!.getR2Bucket('BUCKET');
    await bucket.put(`${USER_A}/__usage/decoy`, '{}');
    await mf!.dispatchFetch(url(`${USER_A}/sessions/mac/claude/s1.jsonl`), {
      method: 'PUT', headers: auth(), body: encBody('s1'),
    });
    const listed = await mf!.dispatchFetch(url(`${USER_A}/?list`), { headers: auth() });
    expect((await listed.json() as { keys: string[] }).keys).toEqual(['sessions/mac/claude/s1.jsonl']);
  });

  it('returns 413 over the real quota ledger and refunds bytes/count on DELETE', async () => {
    const key = `${USER_A}/sessions/mac/claude/a.jsonl`;
    const body = encBody('a');
    const charged = Buffer.byteLength(body);
    expect((await mf!.dispatchFetch(url(key), { method: 'PUT', headers: auth(), body })).status).toBe(200);

    const bucket = await mf!.getR2Bucket('BUCKET');
    expect(JSON.parse(await (await bucket.get(`__usage/${USER_A}`))!.text())).toMatchObject({ bytes: charged, count: 1 });
    expect((await mf!.dispatchFetch(url(key), { method: 'DELETE', headers: auth() })).status).toBe(200);
    expect(JSON.parse(await (await bucket.get(`__usage/${USER_A}`))!.text())).toMatchObject({ bytes: 0, count: 0 });

    await bucket.put(`__usage/${USER_A}`, JSON.stringify({ bytes: MAX_BYTES, count: 0 }));
    const over = await mf!.dispatchFetch(url(`${USER_A}/sessions/mac/claude/over.jsonl`), {
      method: 'PUT', headers: auth(), body: encBody('over'),
    });
    expect(over.status).toBe(413);
    expect(await over.json()).toMatchObject({ error: 'storage limit reached', maxBytes: MAX_BYTES });
  });

  it('hard-caps historical paths before persistent lease/tombstone state can grow', async () => {
    const bucket = await mf!.getR2Bucket('BUCKET');
    for (const id of ['one', 'two', 'three']) {
      const key = `${USER_A}/sessions/mac/claude/${id}.jsonl`;
      expect((await mf!.dispatchFetch(url(key), {
        method: 'PUT', headers: auth(), body: encBody(id),
      })).status).toBe(200);
      expect((await mf!.dispatchFetch(url(key), {
        method: 'DELETE', headers: auth(),
      })).status).toBe(200);
    }

    const ledger = JSON.parse(await (await bucket.get(`__usage/${USER_A}`))!.text()) as {
      bytes: number; count: number; pathCount: number; settled: Record<string, number>;
    };
    expect(ledger).toMatchObject({ bytes: 0, count: 0, pathCount: 3 });
    expect(Object.keys(ledger.settled)).toHaveLength(3);
    expect((await bucket.list()).objects).toHaveLength(7);

    await bucket.put(`__usage/${USER_A}`, JSON.stringify({
      bytes: 0, count: 0, pathCount: MAX_OBJECTS, settled: ledger.settled,
    }));
    const blockedKey = `${USER_A}/sessions/mac/claude/blocked.jsonl`;
    const blocked = await mf!.dispatchFetch(url(blockedKey), {
      method: 'PUT', headers: auth(), body: encBody('blocked'),
    });
    expect(blocked.status).toBe(413);
    expect(await blocked.json()).toMatchObject({
      error: 'historical path limit reached', maxPaths: MAX_OBJECTS,
    });
    expect(await bucket.head(blockedKey)).toBeNull();
    expect(await bucket.head(mutationLeaseKey(USER_A, blockedKey))).toBeNull();
  });

  it('refunds only once when the same key is DELETEd again sequentially', async () => {
    const k1 = `${USER_A}/sessions/mac/claude/x1.jsonl`;
    const k2 = `${USER_A}/sessions/mac/claude/x2.jsonl`;
    const b1 = encBody('x1');
    const b2 = encBody('x2');
    await mf!.dispatchFetch(url(k1), { method: 'PUT', headers: auth(), body: b1 });
    await mf!.dispatchFetch(url(k2), { method: 'PUT', headers: auth(), body: b2 });

    const bucket = await mf!.getR2Bucket('BUCKET');
    expect(JSON.parse(await (await bucket.get(`__usage/${USER_A}`))!.text()))
      .toMatchObject({ bytes: Buffer.byteLength(b1) + Buffer.byteLength(b2), count: 2 });

    expect((await mf!.dispatchFetch(url(k1), { method: 'DELETE', headers: auth() })).status).toBe(200);
    expect((await mf!.dispatchFetch(url(k1), { method: 'DELETE', headers: auth() })).status).toBe(200);
    expect(JSON.parse(await (await bucket.get(`__usage/${USER_A}`))!.text()))
      .toMatchObject({ bytes: Buffer.byteLength(b2), count: 1 });
  });

  it('serializes concurrent DELETEs so one object is refunded exactly once', async () => {
    const keyA = `${USER_A}/sessions/mac/claude/concurrent.jsonl`;
    const keyB = `${USER_A}/sessions/mac/claude/keeper.jsonl`;
    const bodyA = encBody('concurrent');
    const bodyB = encBody('keeper');
    expect((await mf!.dispatchFetch(url(keyA), { method: 'PUT', headers: auth(), body: bodyA })).status).toBe(200);
    expect((await mf!.dispatchFetch(url(keyB), { method: 'PUT', headers: auth(), body: bodyB })).status).toBe(200);

    const deletes = await Promise.all(Array.from({ length: 8 }, () =>
      mf!.dispatchFetch(url(keyA), { method: 'DELETE', headers: auth() })));
    expect(deletes.some(response => response.status === 200)).toBe(true);
    expect(deletes.every(response => response.status === 200 || response.status === 409)).toBe(true);

    const bucket = await mf!.getR2Bucket('BUCKET');
    expect(JSON.parse(await (await bucket.get(`__usage/${USER_A}`))!.text())).toMatchObject({
      bytes: Buffer.byteLength(bodyB), count: 1,
    });
    expect((await bucket.head(keyA))?.customMetadata).toMatchObject({ deleted: 'true' });
    expect(await bucket.head(keyB)).not.toBeNull();
  });

  it('serializes same-key PUT and DELETE and keeps the ledger equal to stored objects', async () => {
    const keyA = `${USER_A}/sessions/mac/claude/raced.jsonl`;
    const keyB = `${USER_A}/sessions/mac/claude/keeper.jsonl`;
    const original = encBody('raced-original');
    const replacement = encBody('raced-replacement-body-is-larger');
    const keeper = encBody('keeper');
    expect((await mf!.dispatchFetch(url(keyA), { method: 'PUT', headers: auth(), body: original })).status).toBe(200);
    expect((await mf!.dispatchFetch(url(keyB), { method: 'PUT', headers: auth(), body: keeper })).status).toBe(200);

    const [put, del] = await Promise.all([
      mf!.dispatchFetch(url(keyA), { method: 'PUT', headers: auth(), body: replacement }),
      mf!.dispatchFetch(url(keyA), { method: 'DELETE', headers: auth() }),
    ]);
    expect([put.status, del.status].every(status => status === 200 || status === 409)).toBe(true);

    const bucket = await mf!.getR2Bucket('BUCKET');
    const storedA = await bucket.head(keyA);
    const liveA = storedA?.customMetadata?.deleted === 'true' ? null : storedA;
    expect(JSON.parse(await (await bucket.get(`__usage/${USER_A}`))!.text())).toMatchObject({
      bytes: Buffer.byteLength(keeper) + (liveA?.size ?? 0),
      count: liveA ? 2 : 1,
    });
  });

  it('reclaims an expired lease and reconciles an interrupted refund before PUT', async () => {
    const key = `${USER_A}/sessions/mac/claude/recover.jsonl`;
    const original = encBody('recover-original-body');
    const replacement = encBody('recover-replacement-body');
    expect((await mf!.dispatchFetch(url(key), { method: 'PUT', headers: auth(), body: original })).status).toBe(200);

    const bucket = await mf!.getR2Bucket('BUCKET');
    const originalHead = await bucket.head(key);
    const staleToken = 'stale-delete-token';
    await bucket.put(`__usage/${USER_A}`, JSON.stringify({
      bytes: 0,
      count: 0,
      pending: {
        [staleToken]: {
          bytes: -Buffer.byteLength(original), count: -1,
          pathId: mutationPathId(key), generation: 1,
        },
      },
      settled: {},
    }));
    await bucket.put(mutationLeaseKey(USER_A, key), JSON.stringify({
      v: 2,
      generation: 1,
      holder: 'dead-worker',
      expiresAt: 0,
      operation: {
        token: staleToken, kind: 'delete', path: key,
        pathId: mutationPathId(key), generation: 1, priorEtag: originalHead!.etag,
      },
    }));

    const recovered = await mf!.dispatchFetch(url(key), {
      method: 'PUT', headers: auth(), body: replacement,
    });
    expect({ status: recovered.status, body: await recovered.text() }).toMatchObject({ status: 200 });
    expect(await (await bucket.get(key))!.text()).toBe(replacement);
    expect(await bucket.put(key, new Uint8Array(0), {
      customMetadata: { deleted: 'true', mutationToken: staleToken },
      onlyIf: { etagMatches: originalHead!.etag },
    })).toBeNull();
    expect(await (await bucket.get(key))!.text()).toBe(replacement);
    expect(JSON.parse(await (await bucket.get(`__usage/${USER_A}`))!.text())).toMatchObject({
      bytes: Buffer.byteLength(replacement), count: 1,
    });
  });

  it('persists a terminal generation so a predecessor cannot CAS a late quota delta', async () => {
    const key = `${USER_A}/sessions/mac/claude/late.jsonl`;
    const original = encBody('late-original');
    const replacement = encBody('late-replacement');
    expect((await mf!.dispatchFetch(url(key), { method: 'PUT', headers: auth(), body: original })).status).toBe(200);

    const bucket = await mf!.getR2Bucket('BUCKET');
    const originalHead = await bucket.head(key);
    const staleLedger = await bucket.get(`__usage/${USER_A}`);
    const pathId = mutationPathId(key);
    const staleToken = 'late-predecessor';
    await bucket.put(mutationLeaseKey(USER_A, key), JSON.stringify({
      v: 2,
      generation: 2,
      holder: staleToken,
      expiresAt: 0,
      operation: {
        token: staleToken, kind: 'delete', path: key,
        pathId, generation: 2, priorEtag: originalHead!.etag,
      },
    }));

    const successor = await mf!.dispatchFetch(url(key), {
      method: 'PUT', headers: auth(), body: replacement,
    });
    const successorBody = await successor.text();
    if (successor.status !== 200) throw new Error(`successor ${successor.status}: ${successorBody}`);

    const late = await bucket.put(`__usage/${USER_A}`, JSON.stringify({
      bytes: 0,
      count: 0,
      pending: { [staleToken]: { bytes: -Buffer.byteLength(original), count: -1, pathId, generation: 2 } },
    }), { onlyIf: { etagMatches: staleLedger!.etag } });
    expect(late).toBeNull();
    expect(JSON.parse(await (await bucket.get(`__usage/${USER_A}`))!.text())).toMatchObject({
      bytes: Buffer.byteLength(replacement), count: 1,
      settled: { [pathId]: 3 },
    });
  });
});
