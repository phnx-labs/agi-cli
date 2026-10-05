import { describe, expect, it } from 'vitest';
import { renderTracesWorkerScript } from './worker-template.js';


function makeWorker(opts: {
  verifyResult: { userId: string; email: string } | null;
  bucket?: Map<string, { body: string; httpMetadata?: Record<string, string> }>;
  writeToken?: string;
  tracesNamespace?: string;
}) {
  const bucket = opts.bucket ?? new Map();
  const env: Record<string, unknown> = {
    PHOENIX_ID_BASE: 'https://id.test',
    BUCKET: {
      async get(key: string) {
        const item = bucket.get(key);
        if (!item) return null;
        return {
          body: item.body,
          httpMetadata: item.httpMetadata ?? {},
          async text() {
            return item.body;
          },
        };
      },
      async list(opts: { prefix?: string; delimiter?: string }) {
        const prefix = opts?.prefix ?? '';
        const delimiter = opts?.delimiter;
        const objects: Array<{ key: string }> = [];
        const delimitedPrefixes = new Set<string>();
        for (const key of bucket.keys()) {
          if (!key.startsWith(prefix)) continue;
          if (delimiter) {
            const rest = key.slice(prefix.length);
            const idx = rest.indexOf(delimiter);
            if (idx >= 0) {
              delimitedPrefixes.add(prefix + rest.slice(0, idx + 1));
              continue;
            }
          }
          objects.push({ key });
        }
        return { objects, delimitedPrefixes: Array.from(delimitedPrefixes), truncated: false };
      },
      async put(
        key: string,
        body: ReadableStream | string,
        meta: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> },
      ) {
        let text = '';
        if (typeof body === 'string') {
          text = body;
        } else {
          const chunks: Uint8Array[] = [];
          const reader = (body as ReadableStream).getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value as Uint8Array);
          }
          text = new TextDecoder().decode(Buffer.concat(chunks));
        }
        bucket.set(key, { body: text, httpMetadata: meta.httpMetadata });
      },
    },
  };
  if (opts.writeToken !== undefined) env['WRITE_TOKEN'] = opts.writeToken;
  if (opts.tracesNamespace !== undefined) env['TRACES_NAMESPACE'] = opts.tracesNamespace;

  const src = renderTracesWorkerScript();
  const fn = new Function(
    'fetchImpl',
    src
      .replace(/export const hooks.*?};/s, `const hooks = { verifyPhoenixToken: async () => (${JSON.stringify(opts.verifyResult)}) };`)
      .replace(/export default \{/, 'return {')
      .replace(/^export /gm, 'const '),
  );
  const handler = fn(null) as { fetch: (req: Request, env: unknown) => Promise<Response> };

  return {
    async fetch(url: string, init?: RequestInit) {
      const req = new Request(url, init);
      return handler!.fetch(req, env);
    },
    bucket,
  };
}

const userId = 'usr-abc123';
const otherUserId = 'usr-xyz999';

describe('traces worker — auth on every route', () => {
  it('GET without any bearer → 401', async () => {
    const w = makeWorker({ verifyResult: null });
    const res = await w.fetch(`https://traces/${userId}/index.json`);
    expect(res.status).toBe(401);
  });

  it('GET with wrong owner bearer → 403', async () => {
    const bucket = new Map([
      [`${userId}/index.json`, { body: '{"sessionCount":1}' }],
    ]);
    const w = makeWorker({ verifyResult: { userId: otherUserId, email: '' }, bucket });
    const res = await w.fetch(`https://traces/${userId}/index.json`, {
      headers: { authorization: `Bearer tok` },
    });
    expect(res.status).toBe(403);
  });

  it('GET with correct owner bearer → 200 with private no-store', async () => {
    const bucket = new Map([
      [`${userId}/index.json`, { body: '{"sessionCount":1}' }],
    ]);
    const w = makeWorker({ verifyResult: { userId, email: '' }, bucket });
    const res = await w.fetch(`https://traces/${userId}/index.json`, {
      headers: { authorization: `Bearer tok` },
    });
    expect(res.status).toBe(200);
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toBe('private, no-store');
    expect(cc).not.toContain('public');
    expect(cc).not.toMatch(/max-age/i);
  });

  it('GET non-existent path → 404 (not a 200 with empty body)', async () => {
    const w = makeWorker({ verifyResult: { userId, email: '' } });
    const res = await w.fetch(`https://traces/${userId}/sessions/does-not-exist.json`, {
      headers: { authorization: `Bearer tok` },
    });
    expect(res.status).toBe(404);
  });

  it('PUT without bearer → 401', async () => {
    const w = makeWorker({ verifyResult: null });
    const res = await w.fetch(`https://traces/${userId}/index.json`, {
      method: 'PUT',
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('PUT with correct phoenix bearer to own prefix → 200', async () => {
    const w = makeWorker({ verifyResult: { userId, email: '' } });
    const res = await w.fetch(`https://traces/${userId}/device1/index.json`, {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionCount: 5 }),
    });
    expect(res.status).toBe(200);
    expect(w.bucket.has(`${userId}/device1/index.json`)).toBe(true);
  });

  it('PUT with correct phoenix bearer to wrong prefix → 403', async () => {
    const w = makeWorker({ verifyResult: { userId, email: '' } });
    const res = await w.fetch(`https://traces/${otherUserId}/device1/index.json`, {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('PUT response always sets private no-store', async () => {
    const w = makeWorker({ verifyResult: { userId, email: '' } });
    const res = await w.fetch(`https://traces/${userId}/index.json`, {
      method: 'PUT',
      headers: { authorization: 'Bearer tok' },
      body: '{}',
    });
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toBe('private, no-store');
    expect(cc).not.toContain('public');
  });

  it('root path → 200 text description (no data exposure)', async () => {
    const w = makeWorker({ verifyResult: null });
    const res = await w.fetch('https://traces/');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('agents traces');
    expect(body).not.toContain('{');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('unsupported method → 405', async () => {
    const w = makeWorker({ verifyResult: { userId, email: '' } });
    const res = await w.fetch(`https://traces/${userId}/index.json`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.status).toBe(405);
  });
});

describe('traces worker — no public cache header anywhere', () => {
  it('error responses never set public cache-control', async () => {
    const w = makeWorker({ verifyResult: null });
    const res = await w.fetch(`https://traces/${userId}/index.json`);
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).not.toContain('public');
    expect(cc).not.toMatch(/max-age=(?!0)/i);
  });
});

describe('traces worker — BYO static write-token namespace enforcement', () => {
  it('PUT with BYO token to own namespace → 200', async () => {
    const w = makeWorker({ verifyResult: null, writeToken: 'secret', tracesNamespace: 'byo' });
    const res = await w.fetch(`https://traces/byo/device1/index.json`, {
      method: 'PUT',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });

  it('PUT with BYO token to a foreign prefix → 403', async () => {
    const w = makeWorker({ verifyResult: null, writeToken: 'secret', tracesNamespace: 'byo' });
    const res = await w.fetch(`https://traces/${userId}/index.json`, {
      method: 'PUT',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });
});

describe('traces worker — /all cross-device aggregation (PHNX-3397)', () => {
  const shard = (device: string, over: Record<string, unknown> = {}) => ({
    schema: 1,
    device,
    owner: userId,
    syncedAt: 1000,
    stats: { sessionsImported: 10, medianMs: 100, p90Ms: 900, needAttention: 3, toolErrorRate: 0.05 },
    needsAttention: [{ id: `s-${device}`, title: 't', device, severity: 5, flags: [] }],
    topics: [{ key: 'code', label: 'Code', count: 4, group: 'code' }],
    failures: { byToolError: [{ tool: 'Bash', desc: 'x', cause: 'real', count: 2 }], byCause: { real: 2, guard: 0, hook: 0, behavioral: 1 } },
    failurePatterns: [{ id: 'bash-x', label: 'Bash: x', wastedMs: 60000, sessions: 3, occurrences: 5, exampleSessionIds: [`ex-${device}`] }],
    wastedMsTotal: 120000,
    latency: { firstToolMs: { p50: 100, p90: 900, p99: 5000, max: 9000 } },
    bucketHistory: [],
    driftSignals: [],
    sessions: [{ id: `sess-${device}`, title: 't', harness: 'claude', model: 'm', repo: 'r', mode: 'headless', projectType: 'code', startedAt: 1, durationMs: 100, toolCount: 5, errorCount: 0, needsAttention: false }],
    ...over,
  });

  it('single device → exact passthrough, relabelled device:"all"', async () => {
    const bucket = new Map([
      [`${userId}/zion/index.json`, { body: JSON.stringify(shard('zion')) }],
    ]);
    const w = makeWorker({ verifyResult: { userId, email: '' }, bucket });
    const res = await w.fetch(`https://traces/${userId}/all/index.json`, {
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.device).toBe('all');
    expect(body.stats.sessionsImported).toBe(10);
    expect(body.wastedMsTotal).toBe(120000);
    expect(body.failurePatterns).toHaveLength(1);
    expect(body.latency.firstToolMs.p50).toBe(100);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe('sess-zion');
  });

  it('two devices → summed counts, concatenated lists, summed wasted time', async () => {
    const bucket = new Map([
      [`${userId}/zion/index.json`, { body: JSON.stringify(shard('zion')) }],
      [`${userId}/mac/index.json`, { body: JSON.stringify(shard('mac', { syncedAt: 2000 })) }],
    ]);
    const w = makeWorker({ verifyResult: { userId, email: '' }, bucket });
    const res = await w.fetch(`https://traces/${userId}/all/index.json`, {
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.device).toBe('all');
    expect(body.stats.sessionsImported).toBe(20);
    expect(body.stats.needAttention).toBe(6);
    expect(body.wastedMsTotal).toBe(240000);
    expect(body.needsAttention).toHaveLength(2);
    expect(body.topics.find((t: { key: string }) => t.key === 'code').count).toBe(8);
    expect(body.failures.byCause).toEqual({ real: 4, guard: 0, hook: 0, behavioral: 2 });
    expect(body.syncedAt).toBe(2000);
    expect(body.failurePatterns).toHaveLength(1);
    const p = body.failurePatterns[0];
    expect(p.id).toBe('bash-x');
    expect(p.wastedMs).toBe(120000);
    expect(p.sessions).toBe(6);
    expect(p.occurrences).toBe(10);
    expect(p.exampleSessionIds).toEqual(expect.arrayContaining(['ex-zion', 'ex-mac']));
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(
      expect.arrayContaining(['sess-zion', 'sess-mac']),
    );
  });

  it('all/sessions/<id> → served from whichever device owns it', async () => {
    const bucket = new Map([
      [`${userId}/zion/index.json`, { body: JSON.stringify(shard('zion')) }],
      [`${userId}/mac/index.json`, { body: JSON.stringify(shard('mac')) }],
      [`${userId}/mac/sessions/abc.json`, { body: '{"id":"abc","device":"mac"}' }],
    ]);
    const w = makeWorker({ verifyResult: { userId, email: '' }, bucket });
    const res = await w.fetch(`https://traces/${userId}/all/sessions/abc.json`, {
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'abc', device: 'mac' });
  });

  it('all/sessions/<id> for a missing id → 404', async () => {
    const bucket = new Map([
      [`${userId}/zion/index.json`, { body: JSON.stringify(shard('zion')) }],
    ]);
    const w = makeWorker({ verifyResult: { userId, email: '' }, bucket });
    const res = await w.fetch(`https://traces/${userId}/all/sessions/nope.json`, {
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.status).toBe(404);
  });

  it('no synced devices → 404 (not a fabricated empty shard)', async () => {
    const w = makeWorker({ verifyResult: { userId, email: '' }, bucket: new Map() });
    const res = await w.fetch(`https://traces/${userId}/all/index.json`, {
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.status).toBe(404);
  });

  it('aggregation still enforces owner — foreign bearer on /all → 403', async () => {
    const bucket = new Map([
      [`${userId}/zion/index.json`, { body: JSON.stringify(shard('zion')) }],
    ]);
    const w = makeWorker({ verifyResult: { userId: otherUserId, email: '' }, bucket });
    const res = await w.fetch(`https://traces/${userId}/all/index.json`, {
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.status).toBe(403);
  });
});
