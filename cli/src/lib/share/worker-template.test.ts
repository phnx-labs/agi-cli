import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWorkerScript } from './worker-template.js';

// The Worker source is emitted as a string. Import it as an ES module (temp
// file — the script is past bun's data: URI NameTooLong limit) and drive its
// `fetch` handler against an in-memory BUCKET so the real route logic is
// exercised — no mocking of the listing/format code under test.

interface StoredObject {
  body: Buffer;
  httpMetadata: { contentType?: string };
  customMetadata: Record<string, string>;
  uploaded: string;
  size: number;
  etag: string;
}

function makeEnv() {
  const store = new Map<string, StoredObject>();
  let etagSeq = 0;
  const env = {
    WRITE_TOKEN: 'secret',
    BUCKET: {
      put: async (
        key: string,
        body: BodyInit | null,
        opts: {
          httpMetadata?: { contentType?: string };
          customMetadata?: Record<string, string>;
          onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
        },
      ) => {
        const current = store.get(key);
        if (opts.onlyIf?.etagMatches) {
          // R2 returns null when the precondition fails (Workers API).
          // etagMatches compares against the BARE hash (R2Object#etag), not
          // the quoted HTTP header form (R2Object#httpEtag) — real R2 500s
          // ("Conditional ETag should not be wrapped in quotes") if a caller
          // passes the quoted form, which a fake that conflated the two
          // would never catch.
          if (!current || current.etag !== opts.onlyIf.etagMatches) return null;
        }
        if (opts.onlyIf?.etagDoesNotMatch === '*' && current) return null;
        // The Worker forwards request.body (a ReadableStream) — consume it so the
        // fake records a real byte size, exactly as R2 would.
        const buf = body == null ? Buffer.alloc(0) : Buffer.from(await new Response(body as BodyInit).arrayBuffer());
        // Consuming the body yielded the event loop, so re-verify the precondition
        // right before the write — real R2 CAS is atomic, and without this
        // re-check two concurrent conditional puts could both pass the earlier
        // check and clobber each other (a TOCTOU the fake would otherwise add).
        if (opts.onlyIf?.etagMatches) {
          const now = store.get(key);
          if (!now || now.etag !== opts.onlyIf.etagMatches) return null;
        }
        if (opts.onlyIf?.etagDoesNotMatch === '*' && store.has(key)) return null;
        const rawHttp = opts.httpMetadata as { contentType?: string } | Headers | undefined;
        const httpMetadata = rawHttp instanceof Headers
          ? { contentType: rawHttp.get('content-type') ?? undefined }
          : (rawHttp ?? {});
        etagSeq += 1;
        const etag = `etag-${etagSeq}`;
        store.set(key, {
          body: buf,
          httpMetadata,
          customMetadata: opts.customMetadata ?? {},
          uploaded: new Date().toISOString(),
          size: buf.length,
          etag,
        });
        return { etag, httpEtag: `"${etag}"`, size: buf.length };
      },
      // Real R2 head() returns the object's metadata (incl. size) with no body —
      // the Worker uses it to size a page before DELETE for the quota refund.
      head: async (key: string) => {
        const item = store.get(key);
        if (!item) return null;
        return {
          customMetadata: item.customMetadata,
          uploaded: new Date(item.uploaded),
          etag: item.etag,
          httpEtag: `"${item.etag}"`,
          size: item.size,
        };
      },
      get: async (key: string) => {
        const item = store.get(key);
        if (!item) return null;
        return {
          body: item.body,
          customMetadata: item.customMetadata,
          uploaded: new Date(item.uploaded),
          etag: item.etag,
          httpEtag: `"${item.etag}"`,
          // Real R2 get() exposes size on the returned body object; the Worker
          // reads existing.size for the quota charge math and obj.size on the
          // expiry lazy-delete refund.
          size: item.size,
          // R2 objects expose text()/arrayBuffer(); the Worker reads text() to
          // inject the attribution bar, so the fake must too.
          text: async () => Buffer.from(item.body).toString('utf8'),
          arrayBuffer: async () => Buffer.from(item.body).buffer,
          writeHttpMetadata(headers: Headers) {
            if (item.httpMetadata.contentType) headers.set('content-type', item.httpMetadata.contentType);
          },
        };
      },
      delete: async (key: string) => {
        store.delete(key);
      },
      list: async (opts: { prefix?: string; limit?: number; include?: string[] }) => {
        const objects = Array.from(store.entries())
          .filter(([k]) => !opts.prefix || k.startsWith(opts.prefix))
          .map(([key, value]) => ({
            key,
            uploaded: value.uploaded,
            httpMetadata: value.httpMetadata,
            customMetadata: value.customMetadata,
            size: value.size,
          }));
        return { objects: opts.limit ? objects.slice(0, opts.limit) : objects };
      },
    },
  };
  return { env, store };
}

let loadedWorker: Promise<any> | undefined;
let originalHooks: Record<string, unknown> | undefined;

async function loadWorker() {
  // The Worker source is an ES module. A data: URI used to work, but HMAC
  // cookie helpers pushed it past bun's NameTooLong limit for data URLs.
  if (!loadedWorker) {
    const src = renderWorkerScript();
    const dir = mkdtempSync(join(tmpdir(), 'share-worker-'));
    const file = join(dir, 'worker.mjs');
    writeFileSync(file, src);
    loadedWorker = import(pathToFileURL(file).href);
  }
  const worker = await loadedWorker;
  if (!originalHooks) originalHooks = { ...worker.hooks };
  Object.assign(worker.hooks, originalHooks);
  // PHNX-3542: enforcement measures the REAL request body (readBodyBounded), so
  // no size header needs simulating — a test's actual body length IS what the
  // quota/size-cap logic sees, exactly as in production.
  return worker;
}

async function put(worker: any, env: any, key: string, body: string, headers: Record<string, string> = {}) {
  const res = await worker.default.fetch(
    new Request(`https://share.test/${key}`, {
      method: 'PUT',
      headers: { authorization: 'Bearer secret', 'content-type': 'text/html; charset=utf-8', ...headers },
      body,
    }),
    env,
  );
  expect(res.status).toBe(200);
}

describe('lazy managed OG cover', () => {
  it('renders a real 1200x630 PNG once and serves the cached R2 object thereafter', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    await put(worker, env, 'octocat/plan', '<!doctype html><title>Launch plan</title><meta name="description" content="Ship it safely">', {
      'x-share-og-title': 'Launch plan',
      'x-share-og-description': 'Ship it safely',
    });

    const first = await worker.default.fetch(new Request('https://share.test/octocat/plan.png', { headers: { accept: 'image/png' } }), env);
    const png = Buffer.from(await first.arrayBuffer());
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('image/png');
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.length).toBeGreaterThan(10_000);
    expect(store.get('octocat/plan.png')?.customMetadata).toMatchObject({ visibility: 'public', 'og-title': 'Launch plan', 'og-generated': 'true' });

    worker.hooks.renderOgCard = async () => { throw new Error('cache miss'); };
    const cached = await worker.default.fetch(new Request('https://share.test/octocat/plan.png?raw=1', { headers: { accept: 'image/png' } }), env);
    expect(Buffer.from(await cached.arrayBuffer())).toEqual(png);

    await put(worker, env, 'octocat/plan', '<title>Updated plan</title>', { 'x-share-og-title': 'Updated plan' });
    expect(store.has('octocat/plan.png')).toBe(false);
  });

  it('returns a diagnostic 500 when the renderer fails', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/broken', '<title>Broken</title>');
    worker.hooks.renderOgCard = async () => { throw new Error('renderer unavailable'); };

    const cover = await worker.default.fetch(new Request('https://share.test/octocat/broken.png'), env);
    expect(cover.status).toBe(500);
    expect(cover.headers.get('content-type')).toContain('text/plain');
    expect(await cover.text()).toBe('OG card render failed: renderer unavailable');
  });

  it('applies the canonical me visibility gate before rendering a missing cover', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    (env as any).PHOENIX_ID_BASE = 'https://phoenix.test';
    worker.hooks.verifyPhoenixToken = async (request: Request) => request.headers.get('authorization')
      ? { userId: 'u1', email: 'octocat@acme.com' }
      : null;
    const putPrivate = await worker.default.fetch(new Request('https://share.test/octocat/private', {
      method: 'PUT',
      headers: { authorization: 'Bearer phoenix', 'content-type': 'text/html', 'x-share-visibility': 'me' },
      body: '<title>Private</title>',
    }), env);
    expect(putPrivate.status).toBe(200);
    worker.hooks.verifyPhoenixToken = async () => null;
    const page = await worker.default.fetch(new Request('https://share.test/octocat/private'), env);
    const cover = await worker.default.fetch(new Request('https://share.test/octocat/private.png'), env);
    expect(cover.status).toBe(page.status);
    expect(store.has('octocat/private.png')).toBe(false);
  });

  it('invalidates generated covers across public→me→public visibility changes', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    (env as any).PHOENIX_ID_BASE = 'https://phoenix.test';
    const owner = { userId: 'u1', email: 'octocat@acme.com' };
    worker.hooks.verifyPhoenixToken = async (request: Request) => request.headers.get('authorization') ? owner : null;
    const published = await worker.default.fetch(new Request('https://share.test/octocat/plan', {
      method: 'PUT',
      headers: { authorization: 'Bearer phoenix', 'content-type': 'text/html', 'x-share-visibility': 'public' },
      body: '<title>Plan</title>',
    }), env);
    expect(published.status).toBe(200);

    const publicCover = await worker.default.fetch(new Request('https://share.test/octocat/plan.png'), env);
    expect(publicCover.status).toBe(200);
    expect(store.get('octocat/plan.png')?.customMetadata['og-generated']).toBe('true');

    const makePrivate = await worker.default.fetch(new Request('https://share.test/octocat/plan', {
      method: 'PATCH',
      headers: { authorization: 'Bearer phoenix', 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'me' }),
    }), env);
    expect(makePrivate.status).toBe(200);
    expect(store.has('octocat/plan.png')).toBe(false);

    worker.hooks.verifyPhoenixToken = async () => null;
    const anonymousPrivateCover = await worker.default.fetch(new Request('https://share.test/octocat/plan.png'), env);
    expect(anonymousPrivateCover.status).not.toBe(200);
    expect(store.has('octocat/plan.png')).toBe(false);

    worker.hooks.verifyPhoenixToken = async (request: Request) => request.headers.get('authorization') ? owner : null;
    const ownerPrivateCover = await worker.default.fetch(new Request('https://share.test/octocat/plan.png', {
      headers: { authorization: 'Bearer phoenix' },
    }), env);
    expect(ownerPrivateCover.status).toBe(200);
    expect(store.get('octocat/plan.png')?.customMetadata).toMatchObject({ visibility: 'me', 'og-generated': 'true' });

    const makePublic = await worker.default.fetch(new Request('https://share.test/octocat/plan', {
      method: 'PATCH',
      headers: { authorization: 'Bearer phoenix', 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public' }),
    }), env);
    expect(makePublic.status).toBe(200);
    expect(store.has('octocat/plan.png')).toBe(false);

    worker.hooks.verifyPhoenixToken = async () => null;
    const regeneratedPublicCover = await worker.default.fetch(new Request('https://share.test/octocat/plan.png'), env);
    expect(regeneratedPublicCover.status).toBe(200);
    expect(store.get('octocat/plan.png')?.customMetadata).toMatchObject({ visibility: 'public', 'og-generated': 'true' });
  });

  it('re-gates an in-flight anonymous render when PATCH changes public to me', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    (env as any).PHOENIX_ID_BASE = 'https://phoenix.test';
    const owner = { userId: 'u1', email: 'octocat@acme.com' };
    worker.hooks.verifyPhoenixToken = async (request: Request) => request.headers.get('authorization') ? owner : null;
    const published = await worker.default.fetch(new Request('https://share.test/octocat/race', {
      method: 'PUT',
      headers: { authorization: 'Bearer phoenix', 'content-type': 'text/html', 'x-share-visibility': 'public' },
      body: '<title>Race</title>',
    }), env);
    expect(published.status).toBe(200);

    const realRender = worker.hooks.renderOgCard;
    let signalStarted!: () => void;
    let resumeRender!: () => void;
    const renderStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const renderMayFinish = new Promise<void>((resolve) => { resumeRender = resolve; });
    worker.hooks.renderOgCard = async (input: unknown) => {
      signalStarted();
      await renderMayFinish;
      return realRender(input);
    };

    const anonymousGet = worker.default.fetch(new Request('https://share.test/octocat/race.png'), env);
    await renderStarted;
    const makePrivate = await worker.default.fetch(new Request('https://share.test/octocat/race', {
      method: 'PATCH',
      headers: { authorization: 'Bearer phoenix', 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'me' }),
    }), env);
    expect(makePrivate.status).toBe(200);
    resumeRender();

    const racedResponse = await anonymousGet;
    expect(racedResponse.status).not.toBe(200);
    expect(store.has('octocat/race.png')).toBe(false);

    worker.hooks.renderOgCard = realRender;
    const ownerCover = await worker.default.fetch(new Request('https://share.test/octocat/race.png', {
      headers: { authorization: 'Bearer phoenix' },
    }), env);
    expect(ownerCover.status).toBe(200);
    expect(store.get('octocat/race.png')?.customMetadata).toMatchObject({
      visibility: 'me',
      'og-generated': 'true',
      'og-source-etag': store.get('octocat/race')?.etag,
    });

    const laterAnonymous = await worker.default.fetch(new Request('https://share.test/octocat/race.png'), env);
    expect(laterAnonymous.status).not.toBe(200);
  });

  it('retains an explicitly uploaded sibling when canonical visibility changes', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    (env as any).PHOENIX_ID_BASE = 'https://phoenix.test';
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'u1', email: 'octocat@acme.com' });
    const published = await worker.default.fetch(new Request('https://share.test/octocat/byo', {
      method: 'PUT',
      headers: { authorization: 'Bearer phoenix', 'content-type': 'text/html', 'x-share-visibility': 'public' },
      body: '<title>BYO</title>',
    }), env);
    expect(published.status).toBe(200);
    await put(worker, env, 'octocat/byo.png', 'EXPLICIT', { 'content-type': 'image/png' });

    const patch = await worker.default.fetch(new Request('https://share.test/octocat/byo', {
      method: 'PATCH',
      headers: { authorization: 'Bearer phoenix', 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'me' }),
    }), env);
    expect(patch.status).toBe(200);
    expect(store.get('octocat/byo.png')?.body.toString()).toBe('EXPLICIT');
    expect(store.get('octocat/byo.png')?.customMetadata['og-generated']).toBeUndefined();
  });
});

describe('worker JSON listing route (GET /<user>?format=json)', () => {
  afterEach(() => vi.useRealTimers());

  it('returns the active shares as JSON with slug/url/size/contentType/publishedAt/expiresAt', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();

    await put(worker, env, 'octocat/plan-one', '<h1>one</h1>');
    await put(worker, env, 'octocat/plan-two', '<h1>two is longer</h1>');
    // A non-HTML asset keeps its own content type.
    await put(worker, env, 'octocat/data-json', '{"a":1}', { 'content-type': 'application/json' });

    const res = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);

    const payload = await res.json();
    expect(payload.user).toBe('octocat');
    expect(payload.count).toBe(3);
    const bySlug = Object.fromEntries(payload.objects.map((o: any) => [o.slug, o]));
    expect(Object.keys(bySlug).sort()).toEqual(['data-json', 'plan-one', 'plan-two']);
    expect(bySlug['plan-one'].url).toBe('https://share.test/octocat/plan-one');
    expect(bySlug['plan-one'].contentType).toBe('text/html; charset=utf-8');
    expect(bySlug['data-json'].contentType).toBe('application/json');
    expect(bySlug['plan-two'].size).toBeGreaterThan(bySlug['plan-one'].size);
    expect(bySlug['plan-one'].expiresAt).toBeNull();
    expect(typeof bySlug['plan-one'].publishedAt).toBe('string');
    expect(() => new Date(bySlug['plan-one'].publishedAt).toISOString()).not.toThrow();
  });

  it('omits the sibling .png OG covers and expired pages, like the gallery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T00:00:00.000Z'));
    const worker = await loadWorker();
    const { env } = makeEnv();

    await put(worker, env, 'octocat/live', '<h1>live</h1>');
    await put(worker, env, 'octocat/live.png', 'PNGDATA', { 'content-type': 'image/png' });
    await put(worker, env, 'octocat/stale', '<h1>stale</h1>', { 'x-share-expires-at': '2026-08-07T00:00:00.000Z' });

    const res = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    const payload = await res.json();
    expect(payload.objects.map((o: any) => o.slug)).toEqual(['live']);
    expect(payload.count).toBe(1);
  });

  it('reports expiresAt for a page published with an expiry', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/temp', '<h1>temp</h1>', { 'x-share-expires-at': '2099-01-01T00:00:00.000Z' });

    const res = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    const payload = await res.json();
    expect(payload.objects[0].expiresAt).toBe('2099-01-01T00:00:00.000Z');
  });

  it('serves a legacy flat-slug page even with ?format=json — never a fake empty listing (regression)', async () => {
    // A legacy flat slug (pre per-user namespaces) is an object at a bare
    // single-segment key. GET /<slug>?format=json must serve the real page, not
    // hijack it into an empty JSON listing — the `?format=json` branch must gate
    // on the same "namespace has objects" check as the gallery. (publish.test.ts
    // covers the plain legacy GET; this adds the ?format=json query param.)
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'legacy-plan-a1b2', '<h1>legacy page</h1>');

    const res = await worker.default.fetch(new Request('https://share.test/legacy-plan-a1b2?format=json'), env);
    expect(res.status).toBe(200);
    // The real HTML page, NOT a JSON listing.
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const text = await res.text();
    expect(text).toContain('legacy page');
    expect(text).not.toContain('"count"');
  });

  it('404s a single-segment path with nothing under it (empty/nonexistent namespace)', async () => {
    // With no objects under `nobody/` and no legacy object at the bare key, the
    // path falls through to a 404 — the CLI reads this (on a current template) as
    // "nothing published", not a missing route.
    const worker = await loadWorker();
    const { env } = makeEnv();
    const res = await worker.default.fetch(new Request('https://share.test/nobody?format=json'), env);
    expect(res.status).toBe(404);
  });

  it('answers HEAD with JSON content type and no body', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/plan', '<h1>plan</h1>');
    const res = await worker.default.fetch(new Request('https://share.test/octocat?format=json', { method: 'HEAD' }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.text()).toBe('');
  });

  it('leaves the HTML gallery untouched — no ?format=json still renders HTML', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/plan', '<h1>plan</h1>');

    const gallery = await worker.default.fetch(new Request('https://share.test/octocat'), env);
    expect(gallery.status).toBe(200);
    expect(gallery.headers.get('content-type')).toMatch(/text\/html/);
    expect(await gallery.text()).toContain('@octocat');
  });

  it('stores and returns provenance + label metadata (RUSH-2683)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/plan', '<h1>plan</h1>', {
      'x-share-agent': 'claude',
      'x-share-session': 'sess-1',
      'x-share-host': 'zion',
      'x-share-repo': 'agents-cli',
      'x-share-date': '2026-08-14',
      'x-share-label': 'Fleet Plan',
      'x-share-label-source': 'explicit',
    });

    const res = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    const payload = await res.json();
    expect(payload.objects[0]).toMatchObject({
      slug: 'plan',
      label: 'Fleet Plan',
      agent: 'claude',
      session: 'sess-1',
      host: 'zion',
      repo: 'agents-cli',
      revisionCount: 0,
    });
  });

  it('leaves provenance/label null when the CLI sent none (a human publish outside git)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/plain', '<h1>plain</h1>');
    const res = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    const payload = await res.json();
    expect(payload.objects[0]).toMatchObject({ label: null, agent: null, session: null, host: null, repo: null });
  });

  it('strips a same-named --meta key even when the CLI sent NO provenance header at all (RUSH-2683 review fix)', async () => {
    // Regression guard: the reserved-key merge used to be
    // `customMetadata = { ...extraMeta }` followed by `if (agent)
    // customMetadata.agent = agent` — an overwrite that only fires when the
    // real provenance header is PRESENT. A human publishing outside an agent
    // session and outside a git checkout sends no x-share-agent/session/host/
    // repo/date headers at all, so a smuggled --meta agent=… (or session=…,
    // host=…, repo=…, date=…) previously survived untouched into public
    // customMetadata. The fix strips every reserved key unconditionally
    // before re-applying the real headers, so this must come back null/absent
    // regardless of whether the CLI sent any provenance.
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/no-provenance', '<h1>no provenance</h1>', {
      'x-share-meta': JSON.stringify({
        kind: 'plan',
        agent: 'smuggled-agent',
        session: 'smuggled-session',
        host: 'smuggled-host',
        repo: 'smuggled-repo',
        date: 'smuggled-date',
        label: 'smuggled-label',
        'label-source': 'smuggled-source',
      }),
    });
    const res = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    const payload = await res.json();
    expect(payload.objects[0]).toMatchObject({
      label: null, agent: null, session: null, host: null, repo: null,
    });
  });

  it('accepts arbitrary --meta entries via x-share-meta, and a real provenance header always wins over a same-named --meta key', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/meta', '<h1>meta</h1>', {
      'x-share-agent': 'claude',
      'x-share-meta': JSON.stringify({ kind: 'plan', ticket: 'RUSH-2683', agent: 'someone-else' }),
    });
    const res = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    const payload = await res.json();
    // The CLI already rejects a --meta collision client-side (parseMetaEntries);
    // this pins the Worker's independent defense — reserved fields are applied
    // AFTER meta, so a genuine x-share-agent header always wins.
    expect(payload.objects[0].agent).toBe('claude');
  });

  it('returns arbitrary --meta entries under objects[].meta, with reserved keys excluded (RUSH-2683 review fix)', async () => {
    // --meta was write-only before this fix: stored in customMetadata but never
    // returned by any read route, so a value published with `--meta kind=plan
    // --meta ticket=RUSH-2683` couldn't be read back via `share list --list-json`.
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/meta-visible', '<h1>meta</h1>', {
      'x-share-agent': 'claude',
      'x-share-label': 'Fleet Plan',
      'x-share-meta': JSON.stringify({ kind: 'plan', ticket: 'RUSH-2683' }),
    });
    const res = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    const payload = await res.json();
    expect(payload.objects[0].meta).toEqual({ kind: 'plan', ticket: 'RUSH-2683' });
    // Reserved keys never leak into the meta map even though they live in the
    // same customMetadata object under the hood.
    expect(payload.objects[0].meta.agent).toBeUndefined();
    expect(payload.objects[0].meta.label).toBeUndefined();
  });

  it('meta is {} when no --meta entries were sent', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/no-meta', '<h1>plain</h1>');
    const res = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    const payload = await res.json();
    expect(payload.objects[0].meta).toEqual({});
  });

  it('omits unlisted pages from the JSON listing and HTML gallery, but still serves the direct URL (RUSH-2443)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();

    await put(worker, env, 'octocat/public-page', '<h1>public</h1>');
    await put(worker, env, 'octocat/secret-report', '<h1>secret</h1>', {
      'x-share-visibility': 'unlisted',
    });

    // Direct URL still works — unlisted, not secret — and GET is noindex.
    const direct = await worker.default.fetch(new Request('https://share.test/octocat/secret-report'), env);
    expect(direct.status).toBe(200);
    expect(direct.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(await direct.text()).toContain('secret');

    // Listing and gallery hide it.
    const listing = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    const payload = await listing.json();
    expect(payload.objects.map((o: any) => o.slug)).toEqual(['public-page']);
    expect(payload.count).toBe(1);

    const gallery = await worker.default.fetch(new Request('https://share.test/octocat'), env);
    const html = await gallery.text();
    expect(html).toContain('public-page');
    expect(html).not.toContain('secret-report');
  });
});

describe('worker metadata edit route (PATCH /<user>/<slug>)', () => {
  it('preserves exact body and reserved metadata, changes only requested metadata, and creates no revision', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    const body = '<html>\n<body>exact bytes</body>\n</html>';
    await put(worker, env, 'octocat/plan', body, {
      'content-type': 'text/html; charset=iso-8859-1',
      'x-share-visibility': 'unlisted',
      'x-share-expires-at': '2099-01-01T00:00:00.000Z',
      'x-share-agent': 'claude',
      'x-share-label': 'Old',
      'x-share-meta': JSON.stringify({ kind: 'plan', status: 'draft' }),
    });
    store.get('octocat/plan')!.uploaded = '2026-08-01T00:00:00.000Z';
    const before = Buffer.from(store.get('octocat/plan')!.body);
    const res = await worker.default.fetch(new Request('https://share.test/octocat/plan', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'New', metaMode: 'merge', meta: { status: 'final' }, removeMeta: ['kind'] }),
    }), env);
    expect(res.status).toBe(200);
    const saved = store.get('octocat/plan')!;
    expect(saved.body.equals(before)).toBe(true);
    expect(saved.httpMetadata.contentType).toBe('text/html; charset=iso-8859-1');
    expect(saved.customMetadata).toMatchObject({ visibility: 'unlisted', 'expires-at': '2099-01-01T00:00:00.000Z', 'published-at': '2026-08-01T00:00:00.000Z', agent: 'claude', label: 'New', status: 'final' });
    expect(saved.customMetadata.kind).toBeUndefined();
    expect(Array.from(store.keys()).filter((key) => key.includes('/rev-'))).toEqual([]);
  });

  it('fails loud for a missing target and reserved metadata key', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    const missing = await worker.default.fetch(new Request('https://share.test/octocat/missing', { method: 'PATCH', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: '{}' }), env);
    expect(missing.status).toBe(404);
    await put(worker, env, 'octocat/plan', 'body');
    const reserved = await worker.default.fetch(new Request('https://share.test/octocat/plan', { method: 'PATCH', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify({ meta: { visibility: 'public' } }) }), env);
    expect(reserved.status).toBe(400);
  });

  it('lets the endpoint-owner WRITE_TOKEN repair metadata across historical managed owners', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    await put(worker, env, 'octocat/legacy', 'exact');
    store.get('octocat/legacy')!.customMetadata.owner = 'old-phoenix-user-id';
    const res = await worker.default.fetch(new Request('https://share.test/octocat/legacy', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ meta: { project: 'AGI' } }),
    }), env);
    expect(res.status).toBe(200);
    expect(store.get('octocat/legacy')!.customMetadata).toMatchObject({ owner: 'old-phoenix-user-id', project: 'AGI' });
  });

  it('enforces label and metadata limits at the Worker boundary', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/plan', 'body');
    const longLabel = await worker.default.fetch(new Request('https://share.test/octocat/plan', { method: 'PATCH', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify({ label: 'x'.repeat(201) }) }), env);
    expect(longLabel.status).toBe(400);
    const largeMeta = await worker.default.fetch(new Request('https://share.test/octocat/plan', { method: 'PATCH', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify({ meta: { note: 'x'.repeat(2100) } }) }), env);
    expect(largeMeta.status).toBe(400);
    await put(worker, env, 'octocat/existing-meta', 'body', { 'x-share-meta': JSON.stringify({ note: 'x'.repeat(2000) }) });
    const largeMergedMeta = await worker.default.fetch(new Request('https://share.test/octocat/existing-meta', { method: 'PATCH', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify({ meta: { second: 'y'.repeat(100) } }) }), env);
    expect(largeMergedMeta.status).toBe(400);
  });

  it('returns 409 when a concurrent republish changes the object between PATCH get and put', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    await put(worker, env, 'octocat/plan', 'v1-body');
    const origGet = env.BUCKET.get;
    env.BUCKET.get = async (key: string) => {
      const obj = await origGet(key);
      const cur = store.get(key);
      if (cur) {
        store.set(key, { ...cur, body: Buffer.from('v2-body'), etag: 'etag-raced', size: 7 });
      }
      return obj;
    };
    const res = await worker.default.fetch(new Request('https://share.test/octocat/plan', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ meta: { status: 'final' } }),
    }), env);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'conflict' });
    expect(store.get('octocat/plan')!.body.toString()).toBe('v2-body');
  });

  it('Phoenix PATCH: the handle owner edits an ownerless object (stamp untouched), a rival userId is refused; WRITE_TOKEN still repairs', async () => {
    const worker = await loadWorker();
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'alice', email: 'alice@example.com' });
    const { env, store } = makeEnv();
    await put(worker, env, 'alice/legacy', 'exact');
    delete store.get('alice/legacy')!.customMetadata.owner;

    // Ownership is the handle claim's call, exactly as on DELETE: with no rival
    // userId under alice/, alice owns the namespace and may edit a page that
    // predates the owner stamp. The stamp is NOT rewritten — the anonymous
    // expiry path refunds the stamped owner's ledger, and this page was never
    // charged to alice's.
    const ownerless = await worker.default.fetch(new Request('https://share.test/alice/legacy', {
      method: 'PATCH',
      headers: { authorization: 'Bearer phoenix-token', 'content-type': 'application/json' },
      body: JSON.stringify({ meta: { project: 'AGI' } }),
    }), env);
    expect(ownerless.status).toBe(200);
    expect(store.get('alice/legacy')!.customMetadata.owner).toBeUndefined();
    expect(store.get('alice/legacy')!.customMetadata.project).toBe('AGI');

    store.get('alice/legacy')!.customMetadata.owner = 'someone-else';
    const other = await worker.default.fetch(new Request('https://share.test/alice/legacy', {
      method: 'PATCH',
      headers: { authorization: 'Bearer phoenix-token', 'content-type': 'application/json' },
      body: JSON.stringify({ meta: { project: 'AGI' } }),
    }), env);
    expect(other.status).toBe(403);

    const admin = await worker.default.fetch(new Request('https://share.test/alice/legacy', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ meta: { project: 'AGI' } }),
    }), env);
    expect(admin.status).toBe(200);
    expect(store.get('alice/legacy')!.customMetadata.project).toBe('AGI');

    store.get('alice/legacy')!.customMetadata.owner = 'alice';
    const own = await worker.default.fetch(new Request('https://share.test/alice/legacy', {
      method: 'PATCH',
      headers: { authorization: 'Bearer phoenix-token', 'content-type': 'application/json' },
      body: JSON.stringify({ meta: { status: 'final' } }),
    }), env);
    expect(own.status).toBe(200);
    expect(store.get('alice/legacy')!.customMetadata.status).toBe('final');
  });
});

describe('owner-scoped hidden listing (GET /<user>?format=json&scope=mine)', () => {
  async function putAsPhoenix(
    worker: any,
    env: any,
    key: string,
    body: string,
    identity: { userId: string; email: string },
    visibility: 'public' | 'unlisted' | 'me' | 'org',
  ) {
    worker.hooks.verifyPhoenixToken = async () => identity;
    (env as { PHOENIX_ID_BASE?: string }).PHOENIX_ID_BASE = env.PHOENIX_ID_BASE || 'https://phoenix.test';
    const res = await worker.default.fetch(
      new Request(`https://share.test/${key}`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer phoenix-token',
          'content-type': 'text/html; charset=utf-8',
          'x-share-visibility': visibility,
        },
        body,
      }),
      env,
    );
    expect(res.status, `PUT ${key} as ${identity.email} vis=${visibility}`).toBe(200);
  }

  it('includes me/org/unlisted pages for the verified owner and hides them from anonymous callers', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await putAsPhoenix(worker, env, 'alice/public-page', '<h1>public</h1>', { userId: 'alice', email: 'alice@example.com' }, 'public');
    await putAsPhoenix(worker, env, 'alice/only-me', '<h1>me</h1>', { userId: 'alice', email: 'alice@example.com' }, 'me');
    await putAsPhoenix(worker, env, 'alice/team', '<h1>org</h1>', { userId: 'alice', email: 'alice@example.com' }, 'org');
    await putAsPhoenix(worker, env, 'alice/unlisted-page', '<h1>unlisted</h1>', { userId: 'alice', email: 'alice@example.com' }, 'unlisted');

    // Anonymous listing stays public-only.
    const anon = await worker.default.fetch(new Request('https://share.test/alice?format=json'), env);
    expect(anon.status).toBe(200);
    expect(anon.headers.get('cache-control')).toBe('public, max-age=30');
    const anonPayload = await anon.json();
    expect(anonPayload.objects.map((o: any) => o.slug)).toEqual(['public-page']);

    // Owner with scope=mine sees every active page, newest first.
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'alice', email: 'alice@example.com' });
    const owner = await worker.default.fetch(
      new Request('https://share.test/alice?format=json&scope=mine', {
        headers: { authorization: 'Bearer phoenix-token' },
      }),
      env,
    );
    expect(owner.status).toBe(200);
    expect(owner.headers.get('cache-control')).toBe('private, no-store');
    expect(owner.headers.get('X-Robots-Tag')).toBe('noindex');
    const ownerPayload = await owner.json();
    const slugs = ownerPayload.objects.map((o: any) => o.slug).sort();
    expect(slugs).toEqual(['only-me', 'public-page', 'team', 'unlisted-page']);
    const bySlug = Object.fromEntries(ownerPayload.objects.map((o: any) => [o.slug, o]));
    expect(bySlug['only-me'].visibility).toBe('me');
    expect(bySlug['team'].visibility).toBe('org');
    expect(bySlug['unlisted-page'].visibility).toBe('unlisted');
    expect(bySlug['public-page'].visibility).toBe('public');
  });

  it('401s when scope=mine is requested without a bearer', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/public-page', '<h1>public</h1>');
    const res = await worker.default.fetch(new Request('https://share.test/octocat?format=json&scope=mine'), env);
    expect(res.status).toBe(401);
  });

  it('403s when a different authenticated user requests scope=mine for a namespace', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await putAsPhoenix(worker, env, 'alice/only-me', '<h1>me</h1>', { userId: 'alice', email: 'alice@example.com' }, 'me');
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'bob', email: 'bob@example.com' });
    const res = await worker.default.fetch(
      new Request('https://share.test/alice?format=json&scope=mine', {
        headers: { authorization: 'Bearer bob-token' },
      }),
      env,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('namespace mismatch');
  });

  it('lets BYO WRITE_TOKEN list hidden pages with scope=mine without namespace enforcement', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/public-page', '<h1>public</h1>');
    await put(worker, env, 'octocat/byo-unlisted', '<h1>byo unlisted</h1>', { 'x-share-visibility': 'unlisted' });

    const anon = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    expect((await anon.json()).objects.map((o: any) => o.slug)).toEqual(['public-page']);

    const byo = await worker.default.fetch(
      new Request('https://share.test/octocat?format=json&scope=mine', {
        headers: { authorization: 'Bearer secret' },
      }),
      env,
    );
    expect(byo.status).toBe(200);
    expect(byo.headers.get('cache-control')).toBe('private, no-store');
    const payload = await byo.json();
    const slugs = payload.objects.map((o: any) => o.slug).sort();
    expect(slugs).toEqual(['byo-unlisted', 'public-page']);
  });
});

describe('revision retention (RUSH-2683 — R2 has no native object versioning)', () => {
  it('creates no revision on a FIRST publish', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    await put(worker, env, 'octocat/first', '<h1>v1</h1>');
    expect(Array.from(store.keys())).toEqual(['octocat/first']);
  });

  it('republishing an EXISTING slug copies the prior version to <slug>/rev-<ts>-<rand> and leaves the canonical key at the new content', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    await put(worker, env, 'octocat/plan', '<h1>v1</h1>', { 'x-share-label': 'v1' });
    await put(worker, env, 'octocat/plan', '<h1>v2</h1>', { 'x-share-label': 'v2' });

    const keys = Array.from(store.keys());
    expect(keys).toContain('octocat/plan');
    const revKeys = keys.filter((k) => k.startsWith('octocat/plan/rev-'));
    expect(revKeys).toHaveLength(1);

    // Canonical key is the LATEST content.
    const canonical = await worker.default.fetch(new Request('https://share.test/octocat/plan'), env);
    expect(await canonical.text()).toContain('v2');

    // The revision key holds the OLD content and its own metadata.
    const rev = await worker.default.fetch(new Request(`https://share.test/${revKeys[0]}`), env);
    expect(await rev.text()).toContain('v1');
  });

  it('--no-revision overwrites in place with no backup copy', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    await put(worker, env, 'octocat/plan', '<h1>v1</h1>');
    await put(worker, env, 'octocat/plan', '<h1>v2</h1>', { 'x-share-no-revision': '1' });
    expect(Array.from(store.keys())).toEqual(['octocat/plan']);
    const canonical = await worker.default.fetch(new Request('https://share.test/octocat/plan'), env);
    expect(await canonical.text()).toContain('v2');
  });

  it('two rapid republishes each get their own revision key (no collision)', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    await put(worker, env, 'octocat/plan', '<h1>v1</h1>');
    await put(worker, env, 'octocat/plan', '<h1>v2</h1>');
    await put(worker, env, 'octocat/plan', '<h1>v3</h1>');
    const revKeys = Array.from(store.keys()).filter((k) => k.startsWith('octocat/plan/rev-'));
    expect(revKeys).toHaveLength(2);
    expect(new Set(revKeys).size).toBe(2);
  });

  it('revisions never appear in the JSON listing or gallery — only as a revisionCount', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/plan', '<h1>v1</h1>');
    await put(worker, env, 'octocat/plan', '<h1>v2</h1>');

    const listing = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    const payload = await listing.json();
    expect(payload.objects.map((o: any) => o.slug)).toEqual(['plan']);
    expect(payload.objects[0].revisionCount).toBe(1);

    const gallery = await worker.default.fetch(new Request('https://share.test/octocat'), env);
    const html = await gallery.text();
    expect(html).not.toContain('/rev-');
  });

  it('GET /<user>/<slug>?revisions=json returns the retained versions newest-first with their metadata', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-10T00:00:00.000Z'));
      const worker = await loadWorker();
      const { env } = makeEnv();
      await put(worker, env, 'octocat/plan', '<h1>v1</h1>', { 'x-share-agent': 'claude', 'x-share-label': 'v1' });
      vi.setSystemTime(new Date('2026-08-11T00:00:00.000Z'));
      await put(worker, env, 'octocat/plan', '<h1>v2</h1>', { 'x-share-agent': 'codex', 'x-share-label': 'v2' });
      vi.setSystemTime(new Date('2026-08-12T00:00:00.000Z'));
      await put(worker, env, 'octocat/plan', '<h1>v3</h1>', { 'x-share-agent': 'claude', 'x-share-label': 'v3' });

      const res = await worker.default.fetch(new Request('https://share.test/octocat/plan?revisions=json'), env);
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.key).toBe('octocat/plan');
      expect(payload.count).toBe(2);
      // Newest revision (the one that replaced v2, carrying v2's own metadata) leads.
      expect(payload.revisions[0].label).toBe('v2');
      expect(payload.revisions[1].label).toBe('v1');
      expect(payload.revisions.every((r: any) => typeof r.uploadedAt === 'string')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns arbitrary --meta entries under revisions[].meta, with reserved keys excluded (RUSH-2683 review fix)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/plan-meta', '<h1>v1</h1>', {
      'x-share-agent': 'claude',
      'x-share-meta': JSON.stringify({ kind: 'plan', ticket: 'RUSH-2683' }),
    });
    await put(worker, env, 'octocat/plan-meta', '<h1>v2</h1>');

    const res = await worker.default.fetch(new Request('https://share.test/octocat/plan-meta?revisions=json'), env);
    const payload = await res.json();
    expect(payload.revisions[0].meta).toEqual({ kind: 'plan', ticket: 'RUSH-2683' });
    expect(payload.revisions[0].meta.agent).toBeUndefined();
  });

  it('returns an empty revisions array for a slug that was only ever published once', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/solo', '<h1>only</h1>');
    const res = await worker.default.fetch(new Request('https://share.test/octocat/solo?revisions=json'), env);
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.count).toBe(0);
    expect(payload.revisions).toEqual([]);
  });

  it('a retained revision honors its OWN expiry independently of the canonical page', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
      const worker = await loadWorker();
      const { env } = makeEnv();
      await put(worker, env, 'octocat/plan', '<h1>v1</h1>', { 'x-share-expires-at': '2026-08-02T00:00:00.000Z' });
      await put(worker, env, 'octocat/plan', '<h1>v2</h1>');

      const res = await worker.default.fetch(new Request('https://share.test/octocat/plan?revisions=json'), env);
      const payload = await res.json();
      expect(payload.revisions[0].expiresAt).toBe('2026-08-02T00:00:00.000Z');

      vi.setSystemTime(new Date('2026-08-03T00:00:00.000Z'));
      const revUrl = 'https://share.test/' + payload.revisions[0].key;
      const gone = await worker.default.fetch(new Request(revUrl), env);
      expect(gone.status).toBe(410);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Phoenix PUT auth + visibility (RUSH-3135)', () => {
  it('accepts a valid Phoenix bearer, stamps owner, and namespaces the key', async () => {
    const worker = await loadWorker();
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'alice', email: 'alice@example.com' });
    const { env, store } = makeEnv();

    const res = await worker.default.fetch(
      new Request('https://share.test/alice/plan', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer phoenix-token',
          'content-type': 'text/html; charset=utf-8',
          'x-share-visibility': 'public',
        },
        body: '<h1>managed</h1>',
      }),
      env,
    );
    expect(res.status).toBe(200);
    const obj = store.get('alice/plan');
    expect(obj).toBeDefined();
    expect(obj?.customMetadata.owner).toBe('alice');
    expect(obj?.customMetadata.visibility).toBe('public');
  });

  it('401s when the bearer is absent', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    const res = await worker.default.fetch(
      new Request('https://share.test/alice/plan', {
        method: 'PUT',
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<h1>no auth</h1>',
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('401s when the bearer is invalid (Phoenix verify returns nothing, not the WRITE_TOKEN)', async () => {
    const worker = await loadWorker();
    worker.hooks.verifyPhoenixToken = async () => null;
    const { env } = makeEnv();
    const res = await worker.default.fetch(
      new Request('https://share.test/alice/plan', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer not-a-real-token',
          'content-type': 'text/html; charset=utf-8',
        },
        body: '<h1>nope</h1>',
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('403s a Phoenix PUT whose first path segment is not the verified handle', async () => {
    const worker = await loadWorker();
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'alice', email: 'a@b.com' });
    const { env, store } = makeEnv();
    const res = await worker.default.fetch(
      new Request('https://share.test/octocat/stolen', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer phoenix-token',
          'content-type': 'text/html; charset=utf-8',
        },
        body: '<h1>stolen</h1>',
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'namespace mismatch', owner: 'a' });
    expect(store.has('octocat/stolen')).toBe(false);
  });

  it('namespaces a Phoenix PUT under the email handle, not the userId UUID (RUSH-3224)', async () => {
    const worker = await loadWorker();
    worker.hooks.verifyPhoenixToken = async () => ({
      userId: '7b28a4b7-1fb0-4abe-948d-32daf2ff7298',
      email: 'muqsitnawaz@gmail.com',
    });
    const { env, store } = makeEnv();
    const res = await worker.default.fetch(
      new Request('https://share.test/muqsitnawaz/plan', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer phoenix-token',
          'content-type': 'text/html; charset=utf-8',
          'x-share-visibility': 'public',
        },
        body: '<h1>ok</h1>',
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(store.get('muqsitnawaz/plan')?.customMetadata.owner).toBe(
      '7b28a4b7-1fb0-4abe-948d-32daf2ff7298',
    );
    expect(store.has('7b28a4b7-1fb0-4abe-948d-32daf2ff7298/plan')).toBe(false);
  });

  it('409s a second Phoenix user whose email local-part collides (handle claim)', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    let who: { userId: string; email: string } = { userId: 'user-1', email: 'john@a.com' };
    worker.hooks.verifyPhoenixToken = async () => who;
    const first = await worker.default.fetch(
      new Request('https://share.test/john/one', {
        method: 'PUT',
        headers: { authorization: 'Bearer t', 'content-type': 'text/html' },
        body: 'one',
      }),
      env,
    );
    expect(first.status).toBe(200);
    who = { userId: 'user-2', email: 'john@b.com' };
    const second = await worker.default.fetch(
      new Request('https://share.test/john/two', {
        method: 'PUT',
        headers: { authorization: 'Bearer t', 'content-type': 'text/html' },
        body: 'two',
      }),
      env,
    );
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: 'handle taken', handle: 'john' });
    expect(store.has('john/two')).toBe(false);
  });

  it('409s a DELETE from the colliding local-part against the claimed handle', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    let who: { userId: string; email: string } = { userId: 'user-1', email: 'john@a.com' };
    worker.hooks.verifyPhoenixToken = async () => who;
    const first = await worker.default.fetch(
      new Request('https://share.test/john/one', {
        method: 'PUT',
        headers: { authorization: 'Bearer t', 'content-type': 'text/html' },
        body: 'one',
      }),
      env,
    );
    expect(first.status).toBe(200);
    who = { userId: 'user-2', email: 'john@b.com' };
    const del = await worker.default.fetch(
      new Request('https://share.test/john/one', {
        method: 'DELETE',
        headers: { authorization: 'Bearer t' },
      }),
      env,
    );
    expect(del.status).toBe(409);
    expect(await del.json()).toMatchObject({ error: 'handle taken', handle: 'john' });
    expect(store.has('john/one')).toBe(true);
  });

  it('404s GET of the internal handle-claim prefix', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    const res = await worker.default.fetch(new Request('https://share.test/__handles/alice'), env);
    expect(res.status).toBe(404);
  });

  it('lets the same Phoenix user DELETE a leftover userId-prefixed P1 object', async () => {
    const worker = await loadWorker();
    worker.hooks.verifyPhoenixToken = async () => ({
      userId: '7b28a4b7-1fb0-4abe-948d-32daf2ff7298',
      email: 'muqsitnawaz@gmail.com',
    });
    const { env, store } = makeEnv();
    store.set('7b28a4b7-1fb0-4abe-948d-32daf2ff7298/old', {
      body: Buffer.from('old'),
      httpMetadata: { contentType: 'text/html' },
      customMetadata: { owner: '7b28a4b7-1fb0-4abe-948d-32daf2ff7298' },
      uploaded: new Date().toISOString(),
      size: 3,
    });
    const res = await worker.default.fetch(
      new Request('https://share.test/7b28a4b7-1fb0-4abe-948d-32daf2ff7298/old', {
        method: 'DELETE',
        headers: { authorization: 'Bearer phoenix-token' },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(store.has('7b28a4b7-1fb0-4abe-948d-32daf2ff7298/old')).toBe(false);
  });

  it('400s org visibility on BYO WRITE_TOKEN PUT (Phoenix identity required)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    const res = await worker.default.fetch(
      new Request('https://share.test/octocat/plan', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'text/html; charset=utf-8',
          'x-share-visibility': 'org',
        },
        body: '<h1>org</h1>',
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'visibility me/org requires Phoenix identity' });
  });

  it('BYO WRITE_TOKEN path still publishes and stamps owner from the path namespace', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    await put(worker, env, 'octocat/byo-page', '<h1>byo</h1>');
    const obj = store.get('octocat/byo-page');
    expect(obj?.customMetadata.owner).toBe('octocat');
    expect(obj?.customMetadata.visibility).toBe('public');
  });

  it('does not lock the Phoenix handle owner out because a BYO page stamped owner=namespace (PHNX-3291)', async () => {
    // The exact regression: the handle is legitimately claimed by a Phoenix
    // userId, but a later BYO WRITE_TOKEN publish stamps owner = the namespace
    // string. The old page-owner scan then 409'd the rightful claim holder on
    // every subsequent publish. The claim object must stay authoritative.
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'user-1', email: 'octocat@a.com' });
    const first = await worker.default.fetch(
      new Request('https://share.test/octocat/one', {
        method: 'PUT',
        headers: { authorization: 'Bearer phoenix', 'content-type': 'text/html' },
        body: 'one',
      }),
      env,
    );
    expect(first.status).toBe(200);
    // A BYO publish lands under the same namespace, owner = 'octocat' (not a userId).
    await put(worker, env, 'octocat/byo-page', '<h1>byo</h1>');
    expect(store.get('octocat/byo-page')?.customMetadata.owner).toBe('octocat');
    // The rightful Phoenix owner republishes — must succeed, not 409.
    const again = await worker.default.fetch(
      new Request('https://share.test/octocat/two', {
        method: 'PUT',
        headers: { authorization: 'Bearer phoenix', 'content-type': 'text/html' },
        body: 'two',
      }),
      env,
    );
    expect(again.status).toBe(200);
    expect(store.has('octocat/two')).toBe(true);
  });

  it('lets a first Phoenix publish claim a handle used only by BYO WRITE_TOKEN pages (PHNX-3291)', async () => {
    // No claim object yet, only BYO pages (owner = namespace). The fallback
    // page-owner scan must ignore the BYO namespace stamp so the first Phoenix
    // publish can claim its own handle instead of 409ing on its own BYO pages.
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    await put(worker, env, 'octocat/byo-a', '<h1>a</h1>');
    expect(store.get('octocat/byo-a')?.customMetadata.owner).toBe('octocat');
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'user-1', email: 'octocat@a.com' });
    const res = await worker.default.fetch(
      new Request('https://share.test/octocat/first', {
        method: 'PUT',
        headers: { authorization: 'Bearer phoenix', 'content-type': 'text/html' },
        body: 'first',
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(store.has('octocat/first')).toBe(true);
  });

  it('unlisted GET carries X-Robots-Tag: noindex; public GET does not', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/public-page', '<h1>public</h1>');
    await put(worker, env, 'octocat/secret-report', '<h1>secret</h1>', {
      'x-share-visibility': 'unlisted',
    });

    const unlisted = await worker.default.fetch(new Request('https://share.test/octocat/secret-report'), env);
    expect(unlisted.status).toBe(200);
    expect(unlisted.headers.get('X-Robots-Tag')).toBe('noindex');

    const listed = await worker.default.fetch(new Request('https://share.test/octocat/public-page'), env);
    expect(listed.status).toBe(200);
    expect(listed.headers.get('X-Robots-Tag')).toBeNull();
  });

  it('honors WRITE_TOKEN equality first when both principals could apply', async () => {
    // Platform endpoint may set both WRITE_TOKEN and PHOENIX_ID_BASE. A bearer
    // that equals WRITE_TOKEN is the BYO/admin principal — it must not be sent
    // to Phoenix.
    const worker = await loadWorker();
    let phoenixCalls = 0;
    worker.hooks.verifyPhoenixToken = async () => {
      phoenixCalls++;
      return { userId: 'alice', email: 'a@b.com' };
    };
    const { env, store } = makeEnv();
    env.PHOENIX_ID_BASE = 'https://phoenix.test';
    await put(worker, env, 'octocat/admin', '<h1>admin</h1>');
    expect(phoenixCalls).toBe(0);
    expect(store.get('octocat/admin')?.customMetadata.owner).toBe('octocat');
  });
});

describe('defaultVerifyPhoenixToken real fetch/parse (RUSH-3135)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(handler: (req: Request) => Response | Promise<Response>): Array<{ url: string; method: string; authorization: string | null }> {
    const seen: Array<{ url: string; method: string; authorization: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      seen.push({ url: req.url, method: req.method, authorization: req.headers.get('authorization') });
      return handler(req);
    }) as typeof fetch;
    return seen;
  }

  it('200 {userId,email} yields claims and GETs ${PHOENIX_ID_BASE}/api/v1/auth/me with the bearer', async () => {
    const worker = await loadWorker();
    const seen = stubFetch(
      () => new Response(JSON.stringify({ userId: 'alice', email: 'alice@example.com' }), { status: 200 }),
    );
    const claims = await worker.hooks.verifyPhoenixToken(
      new Request('https://share.test/alice/plan', { headers: { authorization: 'Bearer pid_alice' } }),
      { PHOENIX_ID_BASE: 'https://phoenix.test/' },
    );
    expect(claims).toEqual({ userId: 'alice', email: 'alice@example.com' });
    expect(seen).toEqual([
      { url: 'https://phoenix.test/api/v1/auth/me', method: 'GET', authorization: 'Bearer pid_alice' },
    ]);
  });

  it('401 / non-ok yields null (does not trust a non-2xx body)', async () => {
    const worker = await loadWorker();
    stubFetch(
      () => new Response(JSON.stringify({ userId: 'attacker', email: 'x@y.z' }), { status: 401 }),
    );
    const claims = await worker.hooks.verifyPhoenixToken(
      new Request('https://share.test/alice/plan', { headers: { authorization: 'Bearer bad' } }),
      { PHOENIX_ID_BASE: 'https://phoenix.test' },
    );
    expect(claims).toBeNull();
  });

  it('malformed body / missing userId yields null', async () => {
    const worker = await loadWorker();
    const env = { PHOENIX_ID_BASE: 'https://phoenix.test' };
    const req = new Request('https://share.test/alice/plan', { headers: { authorization: 'Bearer pid' } });

    stubFetch(() => new Response('not-json', { status: 200 }));
    expect(await worker.hooks.verifyPhoenixToken(req, env)).toBeNull();

    stubFetch(() => new Response(JSON.stringify({ email: 'a@b.com' }), { status: 200 }));
    expect(await worker.hooks.verifyPhoenixToken(req, env)).toBeNull();

    stubFetch(() => new Response(JSON.stringify({ userId: 123 }), { status: 200 }));
    expect(await worker.hooks.verifyPhoenixToken(req, env)).toBeNull();

    stubFetch(() => new Response(JSON.stringify({ userId: '' }), { status: 200 }));
    expect(await worker.hooks.verifyPhoenixToken(req, env)).toBeNull();
  });

  it('PUT through the un-stubbed hook: Phoenix 200 publishes, Phoenix 401 does not', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    (env as { PHOENIX_ID_BASE?: string }).PHOENIX_ID_BASE = 'https://phoenix.test';

    stubFetch(
      () => new Response(JSON.stringify({ userId: 'alice', email: 'alice@example.com' }), { status: 200 }),
    );
    const ok = await worker.default.fetch(
      new Request('https://share.test/alice/plan', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer pid_alice',
          'content-type': 'text/html; charset=utf-8',
        },
        body: '<h1>managed</h1>',
      }),
      env,
    );
    expect(ok.status).toBe(200);
    expect(store.get('alice/plan')?.customMetadata.owner).toBe('alice');

    stubFetch(() => new Response('nope', { status: 401 }));
    const denied = await worker.default.fetch(
      new Request('https://share.test/alice/other', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer pid_alice',
          'content-type': 'text/html; charset=utf-8',
        },
        body: '<h1>nope</h1>',
      }),
      env,
    );
    expect(denied.status).toBe(401);
    expect(store.has('alice/other')).toBe(false);
  });
});

describe('me/org GET identity gate (PHNX-3260)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(handler: (req: Request) => Response | Promise<Response>): Array<{ url: string; method: string; body: string }> {
    const seen: Array<{ url: string; method: string; body: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      seen.push({ url: req.url, method: req.method, body: await req.clone().text() });
      return handler(req);
    }) as typeof fetch;
    return seen;
  }

  async function putAsPhoenix(
    worker: any,
    env: any,
    key: string,
    body: string,
    identity: { userId: string; email: string },
    visibility: 'me' | 'org' | 'public' | 'unlisted',
  ) {
    worker.hooks.verifyPhoenixToken = async () => identity;
    (env as { PHOENIX_ID_BASE?: string }).PHOENIX_ID_BASE = env.PHOENIX_ID_BASE || 'https://phoenix.test';
    const handle = identity.email.split('@')[0].split('+')[0];
    const res = await worker.default.fetch(
      new Request(`https://share.test/${key}`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer phoenix-token',
          'content-type': 'text/html; charset=utf-8',
          'x-share-visibility': visibility,
        },
        body,
      }),
      env,
    );
    expect(res.status, `PUT ${key} as ${handle} vis=${visibility}`).toBe(200);
    return res;
  }

  function setCookieHeader(res: Response): string {
    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (cookies.length > 0) return cookies[0]!;
    return res.headers.get('set-cookie') || '';
  }

  it('public and unlisted GET stay anonymous 200', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/public-page', '<h1>public</h1>');
    await put(worker, env, 'octocat/secret-report', '<h1>secret</h1>', {
      'x-share-visibility': 'unlisted',
    });

    const listed = await worker.default.fetch(new Request('https://share.test/octocat/public-page'), env);
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('public, max-age=60');
    expect(listed.headers.get('X-Robots-Tag')).toBeNull();

    const unlisted = await worker.default.fetch(new Request('https://share.test/octocat/secret-report'), env);
    expect(unlisted.status).toBe(200);
    expect(unlisted.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('me GET with no auth 302s to Phoenix login?return=<this url>', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await putAsPhoenix(worker, env, 'alice/secret', '<h1>mine</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'me');
    worker.hooks.verifyPhoenixToken = async () => null;

    const res = await worker.default.fetch(new Request('https://share.test/alice/secret'), env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://phoenix.test/login?return=' + encodeURIComponent('https://share.test/alice/secret'),
    );
  });

  it('me GET with no PHOENIX_ID_BASE 401s loud instead of bouncing', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    store.set('alice/secret', {
      body: Buffer.from('<h1>mine</h1>'),
      httpMetadata: { contentType: 'text/html' },
      customMetadata: { visibility: 'me', owner: 'alice' },
      uploaded: new Date().toISOString(),
      size: 12,
    });
    worker.hooks.verifyPhoenixToken = async () => null;

    const res = await worker.default.fetch(new Request('https://share.test/alice/secret'), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'phoenix login is not configured' });
  });

  it('phoenix_ticket redeem sets HMAC cookie and 302s stripping the ticket (keeps other query)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await putAsPhoenix(worker, env, 'alice/secret', '<h1>mine</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'me');
    worker.hooks.verifyPhoenixToken = async () => null;
    const seen = stubFetch(
      () => new Response(JSON.stringify({ userId: 'alice', email: 'alice@acme.com' }), { status: 200 }),
    );

    const res = await worker.default.fetch(
      new Request('https://share.test/alice/secret?ref=slack&phoenix_ticket=tix-1'),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://share.test/alice/secret?ref=slack');
    expect(seen).toEqual([
      { url: 'https://phoenix.test/api/v1/auth/ticket', method: 'POST', body: JSON.stringify({ ticket: 'tix-1' }) },
    ]);

    const setCookie = setCookieHeader(res);
    expect(setCookie).toContain('__Host-phoenix_share=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=604800');

    const cookieValue = setCookie.split(';')[0]!;
    const follow = await worker.default.fetch(
      new Request('https://share.test/alice/secret', { headers: { cookie: cookieValue } }),
      env,
    );
    expect(follow.status).toBe(200);
    expect(await follow.text()).toContain('mine');
    expect(follow.headers.get('cache-control')).toBe('private, no-store');
    expect(follow.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('me GET by a second identity 404s with the same body as a missing object', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await putAsPhoenix(worker, env, 'alice/secret', '<h1>mine</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'me');
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'bob', email: 'bob@acme.com' });

    const denied = await worker.default.fetch(
      new Request('https://share.test/alice/secret', { headers: { authorization: 'Bearer bob' } }),
      env,
    );
    expect(denied.status).toBe(404);
    expect(denied.headers.get('content-type')).toBe('text/plain');
    expect(await denied.text()).toBe('not found');

    const missing = await worker.default.fetch(new Request('https://share.test/alice/does-not-exist'), env);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('not found');
  });

  it('org GET 200s same-domain and 404s a mismatched domain', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    await putAsPhoenix(worker, env, 'alice/team', '<h1>org</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'org');
    expect(store.get('alice/team')?.customMetadata.org_domain).toBe('acme.com');

    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'carol', email: 'carol@acme.com' });
    const ok = await worker.default.fetch(
      new Request('https://share.test/alice/team', { headers: { authorization: 'Bearer carol' } }),
      env,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect(ok.headers.get('X-Robots-Tag')).toBe('noindex');

    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'dave', email: 'dave@other.com' });
    const denied = await worker.default.fetch(
      new Request('https://share.test/alice/team', { headers: { authorization: 'Bearer dave' } }),
      env,
    );
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe('not found');
  });

  it('org PUT from gmail 400s (public inbox)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    (env as { PHOENIX_ID_BASE?: string }).PHOENIX_ID_BASE = 'https://phoenix.test';
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'alice', email: 'alice@gmail.com' });
    const res = await worker.default.fetch(
      new Request('https://share.test/alice/plan', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer phoenix-token',
          'content-type': 'text/html; charset=utf-8',
          'x-share-visibility': 'org',
        },
        body: '<h1>org</h1>',
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'org visibility cannot use a public email domain',
      domain: 'gmail.com',
    });
  });

  it('valid bearer skips the login redirect on me GET', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await putAsPhoenix(worker, env, 'alice/secret', '<h1>mine</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'me');
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'alice', email: 'alice@acme.com' });

    const res = await worker.default.fetch(
      new Request('https://share.test/alice/secret', { headers: { authorization: 'Bearer phoenix-token' } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain('mine');
  });

  it('gallery and JSON listing omit me and org pages', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await putAsPhoenix(worker, env, 'alice/public-page', '<h1>public</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'public');
    await putAsPhoenix(worker, env, 'alice/only-me', '<h1>me</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'me');
    await putAsPhoenix(worker, env, 'alice/team', '<h1>org</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'org');

    const listing = await worker.default.fetch(new Request('https://share.test/alice?format=json'), env);
    const payload = await listing.json();
    expect(payload.objects.map((o: any) => o.slug)).toEqual(['public-page']);
    expect(payload.count).toBe(1);

    const gallery = await worker.default.fetch(new Request('https://share.test/alice'), env);
    const html = await gallery.text();
    expect(html).toContain('public-page');
    expect(html).not.toContain('only-me');
    expect(html).not.toContain('team');
  });

  it('unsigned cookie is not accepted as identity (HMAC required)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await putAsPhoenix(worker, env, 'alice/secret', '<h1>mine</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'me');
    worker.hooks.verifyPhoenixToken = async () => null;

    const exp = Math.floor(Date.now() / 1000) + 604800;
    const payload = `alice|alice@acme.com|${exp}`;
    const unsigned = Buffer.from(payload).toString('base64url');
    const res = await worker.default.fetch(
      new Request('https://share.test/alice/secret', {
        headers: { cookie: `__Host-phoenix_share=${unsigned}.deadbeef` },
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/login?return=');
  });

  it('me ?revisions=json is identity-gated the same way as the page GET', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await putAsPhoenix(worker, env, 'alice/secret', '<h1>v1</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'me');
    await putAsPhoenix(worker, env, 'alice/secret', '<h1>v2</h1>', { userId: 'alice', email: 'alice@acme.com' }, 'me');
    worker.hooks.verifyPhoenixToken = async () => null;

    const anon = await worker.default.fetch(new Request('https://share.test/alice/secret?revisions=json'), env);
    expect(anon.status).toBe(302);
    expect(anon.headers.get('location')).toContain('/login?return=');
    expect(anon.headers.get('location')).toContain(encodeURIComponent('https://share.test/alice/secret?revisions=json'));

    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'bob', email: 'bob@acme.com' });
    const other = await worker.default.fetch(
      new Request('https://share.test/alice/secret?revisions=json', { headers: { authorization: 'Bearer bob' } }),
      env,
    );
    expect(other.status).toBe(404);
    expect(await other.text()).toBe('not found');

    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'alice', email: 'alice@acme.com' });
    const ok = await worker.default.fetch(
      new Request('https://share.test/alice/secret?revisions=json', { headers: { authorization: 'Bearer alice' } }),
      env,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect(ok.headers.get('X-Robots-Tag')).toBe('noindex');
    const payload = await ok.json();
    expect(payload.count).toBe(1);
  });

  it('me PUT without PHOENIX_ID_BASE 400s even with a Phoenix hook', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'alice', email: 'alice@acme.com' });
    const res = await worker.default.fetch(
      new Request('https://share.test/alice/secret', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer phoenix-token',
          'content-type': 'text/html; charset=utf-8',
          'x-share-visibility': 'me',
        },
        body: '<h1>mine</h1>',
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'visibility me/org requires Phoenix identity' });
  });
});

describe('attribution bar injected on served HTML pages', () => {
  it('injects a Public visibility chip + author + agent into a served public page', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/report', '<!doctype html><html><body><h1>the page</h1></body></html>', {
      'x-share-agent': 'Claude',
      'x-share-date': '2026-08-27',
    });
    const res = await worker.default.fetch(new Request('https://share.test/octocat/report'), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('agents-share-bar');
    expect(html).toContain('Public');
    expect(html).toContain('Shared by <strong>octocat</strong>');
    expect(html).toContain('Made with Claude');
    expect(html).toContain('2026-08-27');
    // the bar is prepended INSIDE <body>, before the page's own content
    expect(html.indexOf('agents-share-bar')).toBeGreaterThan(-1);
    expect(html.indexOf('agents-share-bar')).toBeLessThan(html.indexOf('the page'));
    // and the etag is dropped since the body was rewritten
    expect(res.headers.get('etag')).toBeNull();
  });

  it('shows the "Only you" chip on an owner-viewed me page', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    (env as { PHOENIX_ID_BASE?: string }).PHOENIX_ID_BASE = 'https://phoenix.test';
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'u1', email: 'octocat@a.com' });
    const put1 = await worker.default.fetch(
      new Request('https://share.test/octocat/secret', {
        method: 'PUT',
        headers: { authorization: 'Bearer p', 'content-type': 'text/html', 'x-share-visibility': 'me' },
        body: '<html><body>mine</body></html>',
      }),
      env,
    );
    expect(put1.status).toBe(200);
    const res = await worker.default.fetch(
      new Request('https://share.test/octocat/secret', { headers: { authorization: 'Bearer p' } }),
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Only you');
    expect(html).toContain('agents-share-bar');
  });

  it('shows "Anyone at <domain>" on an org page for a same-domain viewer', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    (env as { PHOENIX_ID_BASE?: string }).PHOENIX_ID_BASE = 'https://phoenix.test';
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'u1', email: 'octocat@acme.com' });
    const put1 = await worker.default.fetch(
      new Request('https://share.test/octocat/plan', {
        method: 'PUT',
        headers: { authorization: 'Bearer p', 'content-type': 'text/html', 'x-share-visibility': 'org' },
        body: '<html><body>team</body></html>',
      }),
      env,
    );
    expect(put1.status).toBe(200);
    const res = await worker.default.fetch(
      new Request('https://share.test/octocat/plan', { headers: { authorization: 'Bearer p' } }),
      env,
    );
    const html = await res.text();
    expect(html).toContain('Anyone at acme.com');
  });

  it('renders as fixed full-viewport-width chrome and pushes page content down (not a floating box)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    // a page whose body is a narrow centered column — the case that previously
    // constrained the bar into a floating box.
    await put(worker, env, 'octocat/narrow', '<html><head><style>body{max-width:600px;margin:40px auto}</style></head><body><h1>x</h1></body></html>');
    const res = await worker.default.fetch(new Request('https://share.test/octocat/narrow'), env);
    const html = await res.text();
    expect(html).toContain('position:fixed');
    expect(html).toContain('width:100%');
    // pushes the page down so the fixed bar never overlaps content
    expect(html).toContain('html{padding-top:');
  });

  it('does NOT inject the bar into a non-HTML asset', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/data', '{"a":1}', { 'content-type': 'application/json' });
    const res = await worker.default.fetch(new Request('https://share.test/octocat/data'), env);
    const body = await res.text();
    expect(body).toBe('{"a":1}');
    expect(body).not.toContain('agents-share-bar');
  });

  it('escapes metadata in the bar — no HTML injection via a stamped value', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/x', '<html><body>y</body></html>', {
      'x-share-agent': '<script>evil()</script>',
    });
    const res = await worker.default.fetch(new Request('https://share.test/octocat/x'), env);
    const html = await res.text();
    expect(html).toContain('&lt;script&gt;evil()&lt;/script&gt;');
    expect(html).not.toContain('<script>evil()</script>');
  });

  it('ALWAYS renders an avatar slot (initials circle) even with no avatar metadata', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/plain', '<html><body>z</body></html>');
    const res = await worker.default.fetch(new Request('https://share.test/octocat/plain'), env);
    const html = await res.text();
    // the avatar element is present...
    expect(html).toContain('<span class="ash-avatar"');
    // ...carries the handle's uppercase initial...
    expect(html).toContain('<span class="ash-av-i">O</span>');
    // ...and with no avatar URL stamped there is no <img> photo layer (the
    // .ash-av-img CSS class is always in the <style> block; the ELEMENT is not).
    expect(html).not.toContain('<img class="ash-av-img"');
  });

  it('layers a real photo <img> over the initials when an avatar URL is stamped', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    const avatar = 'https://www.gravatar.com/avatar/abc123?d=404&s=52';
    await put(worker, env, 'octocat/pic', '<html><body>z</body></html>', { 'x-share-avatar': avatar });
    const res = await worker.default.fetch(new Request('https://share.test/octocat/pic'), env);
    const html = await res.text();
    expect(html).toContain('<img class="ash-av-img"');
    // the URL is HTML-attribute-escaped (& -> &amp;), which the browser decodes
    // back to the real query string when it fetches the photo.
    expect(html).toContain('src="https://www.gravatar.com/avatar/abc123?d=404&amp;s=52"');
    // onerror falls back to the initials circle beneath when the photo 404s
    expect(html).toContain('onerror="this.remove()"');
    // the initials circle is still underneath
    expect(html).toContain('<span class="ash-av-i">O</span>');
  });

  it('escapes a crafted avatar URL — no HTML/attribute injection through the photo layer', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/evil', '<html><body>z</body></html>', {
      'x-share-avatar': 'https://x/"><script>bad()</script>',
    });
    const res = await worker.default.fetch(new Request('https://share.test/octocat/evil'), env);
    const html = await res.text();
    expect(html).not.toContain('"><script>bad()</script>');
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
  });
});

describe('viewer wrapper for non-HTML assets', () => {
  it('wraps an image in a viewer page (with the bar) for a BROWSER navigation', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/pic.png', 'PNGBYTES', { 'content-type': 'image/png', 'x-share-agent': 'Claude' });
    const res = await worker.default.fetch(
      new Request('https://share.test/octocat/pic.png', { headers: { accept: 'text/html,application/xhtml+xml' } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('agents-share-bar'); // attribution bar present
    expect(html).toContain('Made with Claude');
    // media element points back at ?raw so it loads the bytes, not the viewer
    expect(html).toContain('<img src="/octocat/pic.png?raw=1"');
    expect(html).toContain('pic.png'); // title/name
  });

  it('serves the RAW bytes to a non-browser fetch (Accept without text/html) — no wrapper', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/pic.png', 'PNGBYTES', { 'content-type': 'image/png' });
    const res = await worker.default.fetch(
      new Request('https://share.test/octocat/pic.png', { headers: { accept: 'image/png,*/*' } }),
      env,
    );
    const body = await res.text();
    expect(body).toBe('PNGBYTES');
    expect(body).not.toContain('agents-share-bar');
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it('?raw returns bytes even for a browser (the embed/OG escape hatch)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/pic.png', 'PNGBYTES', { 'content-type': 'image/png' });
    const res = await worker.default.fetch(
      new Request('https://share.test/octocat/pic.png?raw=1', { headers: { accept: 'text/html' } }),
      env,
    );
    const body = await res.text();
    expect(body).toBe('PNGBYTES');
    expect(body).not.toContain('agents-share-bar');
  });

  it('?raw does NOT strip the bar from an HTML page — the bar is always-on (regression)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/page', '<html><body><h1>hi</h1></body></html>');
    const res = await worker.default.fetch(new Request('https://share.test/octocat/page?raw=1'), env);
    const html = await res.text();
    expect(html).toContain('agents-share-bar'); // ?raw only affects non-HTML assets
  });

  it('escapes a crafted asset filename in the viewer (no attribute break-out)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    // a double-quote in the name would break out of alt="…"/src="…" if unescaped
    await put(worker, env, 'octocat/e"vil.png', 'PNG', { 'content-type': 'image/png' });
    const res = await worker.default.fetch(
      new Request('https://share.test/octocat/e%22vil.png', { headers: { accept: 'text/html' } }),
      env,
    );
    const html = await res.text();
    expect(html).toContain('e&quot;vil.png'); // escaped
    expect(html).not.toContain('e"vil.png'); // never the raw, attribute-breaking form
  });

  it('uses <video> for video and <iframe> for pdf', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/clip.mp4', 'MP4', { 'content-type': 'video/mp4' });
    await put(worker, env, 'octocat/doc.pdf', 'PDF', { 'content-type': 'application/pdf' });
    const vid = await (await worker.default.fetch(new Request('https://share.test/octocat/clip.mp4', { headers: { accept: 'text/html' } }), env)).text();
    expect(vid).toContain('<video src="/octocat/clip.mp4?raw=1"');
    const pdf = await (await worker.default.fetch(new Request('https://share.test/octocat/doc.pdf', { headers: { accept: 'text/html' } }), env)).text();
    expect(pdf).toContain('<iframe src="/octocat/doc.pdf?raw=1"');
  });

  it('does not wrap a non-viewable asset (JSON) — served raw', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/data.json', '{"a":1}', { 'content-type': 'application/json' });
    const res = await worker.default.fetch(new Request('https://share.test/octocat/data.json', { headers: { accept: 'text/html' } }), env);
    const body = await res.text();
    expect(body).toBe('{"a":1}');
    expect(body).not.toContain('agents-share-bar');
  });

  it('me/org gate still applies to the viewer — anonymous browser is bounced, not shown', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    (env as { PHOENIX_ID_BASE?: string }).PHOENIX_ID_BASE = 'https://phoenix.test';
    // Respect the bearer so an anonymous request genuinely has no identity.
    worker.hooks.verifyPhoenixToken = async (req: Request) =>
      (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
        ? { userId: 'u1', email: 'octocat@a.com' }
        : null;
    const put1 = await worker.default.fetch(
      new Request('https://share.test/octocat/secret.png', {
        method: 'PUT',
        headers: { authorization: 'Bearer p', 'content-type': 'image/png', 'x-share-visibility': 'me' },
        body: 'PNG',
      }),
      env,
    );
    expect(put1.status).toBe(200);
    // anonymous browser navigation → gate fires (302 login), never the viewer
    const anon = await worker.default.fetch(new Request('https://share.test/octocat/secret.png', { headers: { accept: 'text/html' } }), env);
    expect(anon.status).toBe(302);
    // owner browser → viewer
    const owner = await worker.default.fetch(new Request('https://share.test/octocat/secret.png', { headers: { authorization: 'Bearer p', accept: 'text/html' } }), env);
    expect(owner.status).toBe(200);
    expect(await owner.text()).toContain('agents-share-bar');
  });
});

describe('owner interactive visibility control + page stats (bar live)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  // A minimal ExecutionContext: collect waitUntil promises so a test can await
  // the background counter write the same way the Workers runtime settles it.
  function makeCtx() {
    const tasks: Array<Promise<unknown>> = [];
    return {
      ctx: { waitUntil: (p: Promise<unknown>) => { tasks.push(Promise.resolve(p)); } },
      settle: () => Promise.all(tasks),
    };
  }

  async function putAsPhoenix(
    worker: any,
    env: any,
    key: string,
    body: string,
    identity: { userId: string; email: string },
    visibility: 'public' | 'unlisted' | 'me' | 'org',
  ) {
    worker.hooks.verifyPhoenixToken = async () => identity;
    (env as { PHOENIX_ID_BASE?: string }).PHOENIX_ID_BASE = env.PHOENIX_ID_BASE || 'https://phoenix.test';
    const res = await worker.default.fetch(
      new Request(`https://share.test/${key}`, {
        method: 'PUT',
        headers: { authorization: 'Bearer phoenix', 'content-type': 'text/html; charset=utf-8', 'x-share-visibility': visibility },
        body,
      }),
      env,
    );
    expect(res.status).toBe(200);
  }

  it('owner GET renders the inline dropdown + PATCH-calling JS; non-owner and anonymous GETs get the static cue only', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await putAsPhoenix(worker, env, 'octocat/report', '<html><body><h1>the page</h1></body></html>', { userId: 'u1', email: 'octocat@acme.com' }, 'public');

    // Owner (viewer handle === namespace) — the interactive control.
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'u1', email: 'octocat@acme.com' });
    const ownerHtml = await (await worker.default.fetch(new Request('https://share.test/octocat/report', { headers: { authorization: 'Bearer p' } }), env)).text();
    expect(ownerHtml).toContain('agents-share-bar');
    expect(ownerHtml).toContain('data-ash-menu');          // the dropdown menu
    expect(ownerHtml).toContain('data-ash-chip');          // interactive chip
    expect(ownerHtml).toContain('data-ash-opt="public"');  // all four levels
    expect(ownerHtml).toContain('data-ash-opt="unlisted"');
    expect(ownerHtml).toContain('data-ash-opt="me"');
    expect(ownerHtml).toContain('data-ash-opt="org"');
    expect(ownerHtml).toContain("method:'PATCH'");          // the PATCH-calling JS
    expect(ownerHtml).toContain("credentials:'include'");
    // org is always offered — a public-inbox owner still sees it and lets the
    // server's 400 drive the failure (no hidden client-side rule).
    expect(ownerHtml).toContain('data-ash-opt="org"');

    // A different signed-in viewer is NOT the owner — static cue, no control.
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'u2', email: 'bob@acme.com' });
    const otherHtml = await (await worker.default.fetch(new Request('https://share.test/octocat/report', { headers: { authorization: 'Bearer b' } }), env)).text();
    expect(otherHtml).toContain('agents-share-bar');
    expect(otherHtml).toContain('Public');
    expect(otherHtml).not.toContain('data-ash-menu');
    expect(otherHtml).not.toContain("method:'PATCH'");

    // Anonymous — same static cue.
    worker.hooks.verifyPhoenixToken = async () => null;
    const anonHtml = await (await worker.default.fetch(new Request('https://share.test/octocat/report'), env)).text();
    expect(anonHtml).toContain('agents-share-bar');
    expect(anonHtml).not.toContain('data-ash-menu');
    expect(anonHtml).not.toContain('data-ash-chip');
    expect(anonHtml).not.toContain("method:'PATCH'");
  });

  it('a visibility change through the same PATCH route the bar calls updates the chip on the next GET', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await putAsPhoenix(worker, env, 'octocat/plan', '<html><body>plan</body></html>', { userId: 'u1', email: 'octocat@acme.com' }, 'public');
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'u1', email: 'octocat@acme.com' });

    const before = await (await worker.default.fetch(new Request('https://share.test/octocat/plan', { headers: { authorization: 'Bearer p' } }), env)).text();
    expect(before).toContain('data-ash-label>Public<');

    // Exactly what the bar's JS sends: PATCH with a JSON { visibility } body.
    const patch = await worker.default.fetch(new Request('https://share.test/octocat/plan', {
      method: 'PATCH',
      headers: { authorization: 'Bearer p', 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'unlisted' }),
    }), env);
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({ visibility: 'unlisted', previousVisibility: 'public' });

    const after = await (await worker.default.fetch(new Request('https://share.test/octocat/plan', { headers: { authorization: 'Bearer p' } }), env)).text();
    expect(after).toContain('data-ash-label>Unlisted<');
    expect(after).not.toContain('data-ash-label>Public<');
  });

  it('authenticates the bar PATCH by the __share cookie alone (no bearer) — the credentials:include path', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    (env as { PHOENIX_ID_BASE?: string }).PHOENIX_ID_BASE = 'https://phoenix.test';
    await putAsPhoenix(worker, env, 'alice/plan', '<html><body>p</body></html>', { userId: 'alice', email: 'alice@acme.com' }, 'me');

    // Redeem a ticket to obtain the signed __share cookie a browser would carry.
    worker.hooks.verifyPhoenixToken = async () => null;
    globalThis.fetch = (async () => new Response(JSON.stringify({ userId: 'alice', email: 'alice@acme.com' }), { status: 200 })) as typeof fetch;
    const redeem = await worker.default.fetch(new Request('https://share.test/alice/plan?phoenix_ticket=tix'), env);
    expect(redeem.status).toBe(302);
    const setCookie = (typeof redeem.headers.getSetCookie === 'function' ? redeem.headers.getSetCookie()[0] : redeem.headers.get('set-cookie')) || '';
    const cookie = setCookie.split(';')[0]!;
    globalThis.fetch = originalFetch;

    // PATCH with ONLY the cookie — no Authorization header — must succeed.
    const patch = await worker.default.fetch(new Request('https://share.test/alice/plan', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'unlisted' }),
    }), env);
    expect(patch.status).toBe(200);
    expect(store.get('alice/plan')?.customMetadata.visibility).toBe('unlisted');
  });

  it('surfaces the server error text when the change is rejected (org on a public inbox)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    (env as { PHOENIX_ID_BASE?: string }).PHOENIX_ID_BASE = 'https://phoenix.test';
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'u1', email: 'octocat@gmail.com' });
    await worker.default.fetch(new Request('https://share.test/octocat/plan', {
      method: 'PUT',
      headers: { authorization: 'Bearer p', 'content-type': 'text/html', 'x-share-visibility': 'public' },
      body: '<html><body>x</body></html>',
    }), env);
    // The very error the bar reverts on and shows: org from a public inbox 400s.
    const res = await worker.default.fetch(new Request('https://share.test/octocat/plan', {
      method: 'PATCH',
      headers: { authorization: 'Bearer p', 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'org' }),
    }), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'org visibility cannot use a public email domain', domain: 'gmail.com' });
  });

  it('counts a visitor view into __views/<path>, excludes owner/?raw/HEAD, and never leaks the counter key', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    await put(worker, env, 'octocat/live', '<html><body>live</body></html>');

    // Two anonymous visitor GETs each increment the separate counter object.
    for (let i = 0; i < 2; i++) {
      const c = makeCtx();
      await worker.default.fetch(new Request('https://share.test/octocat/live'), env, c.ctx);
      await c.settle();
    }
    expect(store.get('__views/octocat/live')?.body.toString()).toBe('2');
    // The page object itself was never rewritten (its uploaded stays intact).
    expect(Array.from(store.keys()).filter((k) => k.startsWith('octocat/live/rev-'))).toEqual([]);

    // A third visitor GET shows the current count folding in this view.
    const c3 = makeCtx();
    const html3 = await (await worker.default.fetch(new Request('https://share.test/octocat/live'), env, c3.ctx)).text();
    await c3.settle();
    expect(html3).toContain('<b>3</b> views');
    expect(store.get('__views/octocat/live')?.body.toString()).toBe('3');

    // Owner GET does NOT increment (the count reflects real visitors).
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'u1', email: 'octocat@acme.com' });
    (env as { PHOENIX_ID_BASE?: string }).PHOENIX_ID_BASE = 'https://phoenix.test';
    const co = makeCtx();
    await worker.default.fetch(new Request('https://share.test/octocat/live', { headers: { authorization: 'Bearer p' } }), env, co.ctx);
    await co.settle();
    expect(store.get('__views/octocat/live')?.body.toString()).toBe('3');
    worker.hooks.verifyPhoenixToken = async () => null;

    // ?raw (embed/OG fetch) does not increment.
    const cr = makeCtx();
    await worker.default.fetch(new Request('https://share.test/octocat/live?raw=1'), env, cr.ctx);
    await cr.settle();
    expect(store.get('__views/octocat/live')?.body.toString()).toBe('3');

    // HEAD does not increment.
    const ch = makeCtx();
    await worker.default.fetch(new Request('https://share.test/octocat/live', { method: 'HEAD' }), env, ch.ctx);
    await ch.settle();
    expect(store.get('__views/octocat/live')?.body.toString()).toBe('3');

    // The counter key never appears in the gallery / JSON listing / revisions...
    const listing = await (await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env)).json();
    expect(listing.objects.map((o: any) => o.slug)).toEqual(['live']);
    expect(JSON.stringify(listing)).not.toContain('__views');
    const gallery = await (await worker.default.fetch(new Request('https://share.test/octocat'), env)).text();
    expect(gallery).not.toContain('__views');
    const revs = await (await worker.default.fetch(new Request('https://share.test/octocat/live?revisions=json'), env)).json();
    expect(JSON.stringify(revs)).not.toContain('__views');

    // ...and a direct GET of the counter key is blocked by its __ prefix.
    const direct = await worker.default.fetch(new Request('https://share.test/__views/octocat/live'), env);
    expect(direct.status).toBe(404);
  });

  it('renders a relative "updated" time in the stats cluster from the object uploaded timestamp', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/fresh', '<html><body>x</body></html>');
    const c = makeCtx();
    const html = await (await worker.default.fetch(new Request('https://share.test/octocat/fresh'), env, c.ctx)).text();
    await c.settle();
    expect(html).toContain('updated <b>just now</b>');
  });

  it('a stale/invalid phoenix_ticket on a public page serves anonymously, not 401 (resolveViewer-once regression)', async () => {
    // Before resolveViewer moved to run on every GET, a public page never invoked
    // ticket redemption — so a stray/expired/consumed ticket in the URL (a
    // link-preview bot on the pre-redirect URL, a double-open, a Phoenix blip) was
    // ignored and the page always served. The refactor must preserve that: a
    // ticket FAILURE only gates a page that needs identity.
    const worker = await loadWorker();
    const { env } = makeEnv();
    (env as { PHOENIX_ID_BASE?: string }).PHOENIX_ID_BASE = 'https://phoenix.test';
    await put(worker, env, 'octocat/public-page', '<html><body>hello public</body></html>');
    worker.hooks.verifyPhoenixToken = async () => null;
    globalThis.fetch = (async () => new Response('nope', { status: 401 })) as typeof fetch; // ticket redeem fails
    const res = await worker.default.fetch(new Request('https://share.test/octocat/public-page?phoenix_ticket=stale'), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('hello public');
    expect(html).toContain('agents-share-bar');
  });

  it('a stale/invalid phoenix_ticket on a me page STILL 401s (identity genuinely required)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await putAsPhoenix(worker, env, 'alice/secret', '<html><body>mine</body></html>', { userId: 'alice', email: 'alice@acme.com' }, 'me');
    worker.hooks.verifyPhoenixToken = async () => null;
    globalThis.fetch = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    const res = await worker.default.fetch(new Request('https://share.test/alice/secret?phoenix_ticket=stale'), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid ticket' });
  });

  it('a stale phoenix_ticket on a public ?revisions=json serves the list, not 401 (regression)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    (env as { PHOENIX_ID_BASE?: string }).PHOENIX_ID_BASE = 'https://phoenix.test';
    await put(worker, env, 'octocat/plan', '<html><body>v1</body></html>');
    await put(worker, env, 'octocat/plan', '<html><body>v2</body></html>');
    worker.hooks.verifyPhoenixToken = async () => null;
    globalThis.fetch = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    const res = await worker.default.fetch(new Request('https://share.test/octocat/plan?revisions=json&phoenix_ticket=stale'), env);
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.count).toBe(1);
  });
});

describe('PHNX-3542 per-user storage quota, rate limit, and size cap', () => {
  const MiB = 1024 * 1024;
  const OWNER = 'u1';

  function setupPhoenix(worker: any, env: any) {
    env.PHOENIX_ID_BASE = 'https://phoenix.test';
    worker.hooks.verifyPhoenixToken = async (req: Request) =>
      req.headers.get('authorization') ? { userId: OWNER, email: 'octocat@acme.com' } : null;
  }

  async function phoenixPut(worker: any, env: any, key: string, body: string, headers: Record<string, string> = {}) {
    // Deliberately sends NO size header — enforcement measures the real body, so
    // a test's body length IS what the Worker charges. A spoof test passes an
    // explicit (lying) x-share-bytes via `headers` to prove it is ignored.
    return worker.default.fetch(
      new Request(`https://share.test/${key}`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer phoenix',
          'content-type': 'text/html; charset=utf-8',
          ...headers,
        },
        body,
      }),
      env,
    );
  }

  function seedUsage(store: Map<string, StoredObject>, usage: Record<string, unknown>) {
    const body = Buffer.from(JSON.stringify(usage));
    store.set(`__usage/${OWNER}`, {
      body,
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {},
      uploaded: new Date().toISOString(),
      size: body.length,
      etag: 'usage-seed',
    });
  }

  function readLedger(store: Map<string, StoredObject>): any {
    const item = store.get(`__usage/${OWNER}`);
    if (!item) return null;
    return JSON.parse(item.body.toString('utf8'));
  }

  it('rejects a file over the per-file size cap with 413, measuring the REAL body even when the declared size lies low', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    setupPhoenix(worker, env);
    // A genuinely oversized 21 MiB body, but a spoofed x-share-bytes: 1 — the cap
    // keys on the REAL bytes, so it is rejected regardless of the lie, before any
    // R2 write.
    const huge = 'a'.repeat(21 * MiB);
    const res = await phoenixPut(worker, env, 'octocat/big', huge, { 'x-share-bytes': '1' });
    expect(res.status).toBe(413);
    // The reason carries the cap inline so the CLI can surface it verbatim.
    expect((await res.json()).error).toBe('file too large: max 20971520 bytes');
  });

  it('leaves the existing page intact when an oversize republish is rejected (no data loss — BLOCKER regression)', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    setupPhoenix(worker, env);
    const original = '<title>keep me</title>';
    expect((await phoenixPut(worker, env, 'octocat/keep', original)).status).toBe(200);
    // Republish over the SAME slug with a real 21 MiB body but a spoofed tiny
    // declared size. The cap is enforced on the real bytes BEFORE the revision
    // copy + canonical overwrite, so the live page must survive untouched — the
    // pre-fix bug deleted the canonical and left only an orphaned revision.
    const huge = 'z'.repeat(21 * MiB);
    const rej = await phoenixPut(worker, env, 'octocat/keep', huge, { 'x-share-bytes': '1' });
    expect(rej.status).toBe(413);
    const get = await worker.default.fetch(new Request('https://share.test/octocat/keep'), env);
    expect(get.status).toBe(200);
    expect(await get.text()).toContain('keep me');
    // And no orphaned revision copy was created by the rejected write.
    const revs = [...store.keys()].filter((k) => k.startsWith('octocat/keep/rev-'));
    expect(revs).toEqual([]);
  });

  it('rejects the (maxObjects + 1)th canonical page with 413', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    setupPhoenix(worker, env);
    // Seed a ledger already at the object cap (rlStart=0 so the rate window
    // resets and the 60/hr limit does not fire first).
    seedUsage(store, { bytes: 0, count: 150, plan: 'free', rlStart: 0, rlUsed: 0 });
    const res = await phoenixPut(worker, env, 'octocat/over-limit', '<title>one more</title>');
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('artifact limit reached');
  });

  it('enforces the total byte quota on REAL bytes, not the declared size (BLOCKER regression)', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    setupPhoenix(worker, env);
    // 199 MiB already used, cap is 200 MiB. Publish a real 2 MiB body but declare
    // x-share-bytes: 1. If the quota trusted the declared size (the pre-fix bug),
    // 199 MiB + 1 byte would pass; keyed on the real 2 MiB it crosses 200 MiB and
    // must be rejected.
    seedUsage(store, { bytes: 199 * MiB, count: 1, plan: 'free', rlStart: 0, rlUsed: 0 });
    const real2MiB = 'q'.repeat(2 * MiB);
    const res = await phoenixPut(worker, env, 'octocat/spill', real2MiB, { 'x-share-bytes': '1' });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('storage limit reached');
    // The rejected write never touched storage.
    expect(store.has('octocat/spill')).toBe(false);
  });

  it('rate-limits past the hourly publish cap with 429 + Retry-After', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    setupPhoenix(worker, env);
    // Seed the window as fresh and already at the cap so the next publish is #61.
    seedUsage(store, { bytes: 0, count: 0, plan: 'free', rlStart: Date.now(), rlUsed: 60 });
    const res = await phoenixPut(worker, env, 'octocat/too-fast', '<title>rapid</title>');
    expect(res.status).toBe(429);
    expect((await res.json()).error).toContain('rate limit');
    const retryAfter = Number(res.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);
  });

  it('charges each authed PUT and refunds bytes + object count on DELETE', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    setupPhoenix(worker, env);

    const page1 = 'a'.repeat(100);
    const page2 = 'b'.repeat(50);
    expect((await phoenixPut(worker, env, 'octocat/plan', page1)).status).toBe(200);
    expect((await phoenixPut(worker, env, 'octocat/plan2', page2)).status).toBe(200);

    const afterPublish = readLedger(store);
    expect(afterPublish.count).toBe(2);
    expect(afterPublish.bytes).toBe(150);

    const del = await worker.default.fetch(
      new Request('https://share.test/octocat/plan', {
        method: 'DELETE',
        headers: { authorization: 'Bearer phoenix' },
      }),
      env,
    );
    expect(del.status).toBe(200);

    const afterDelete = readLedger(store);
    expect(afterDelete.count).toBe(1);
    expect(afterDelete.bytes).toBe(50);
  });

  it('holds the object count under concurrent publishes (CAS, no lost increment)', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    setupPhoenix(worker, env);
    // Seed an EXISTING empty ledger so both writers hit the conditional-put CAS
    // path (a fresh-key create is unconditional by design); one wins, the other
    // re-reads and retries, so neither increment is lost.
    seedUsage(store, { bytes: 0, count: 0, plan: 'free', rlStart: Date.now(), rlUsed: 0 });
    const [a, b] = await Promise.all([
      phoenixPut(worker, env, 'octocat/a', 'x'.repeat(10)),
      phoenixPut(worker, env, 'octocat/b', 'y'.repeat(20)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ledger = readLedger(store);
    expect(ledger.count).toBe(2);
    expect(ledger.bytes).toBe(30);
  });

  it('BYO WRITE_TOKEN publishes skip every quota, rate, and size limit', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    // A REAL 21 MiB upload (over the managed per-file cap) plus 200 rapid
    // publishes — all allowed for BYO, and no usage ledger is ever created. `put`
    // asserts a 200, so the oversize body going through proves BYO truly bypasses
    // the cap rather than being caught by it.
    await put(worker, env, 'byo/big', 'b'.repeat(21 * MiB));
    for (let i = 0; i < 200; i++) {
      await put(worker, env, `byo/page-${i}`, 'hello');
    }
    const usageKeys = [...store.keys()].filter((k) => k.startsWith('__usage/'));
    expect(usageKeys).toEqual([]);
  });
});

describe('token-gated private visibility (PHNX-3654)', () => {
  async function putPrivate(worker: any, env: any, key: string, body: string, token: string, extra: Record<string, string> = {}) {
    return worker.default.fetch(
      new Request(`https://share.test/${key}`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'text/html; charset=utf-8',
          'x-share-visibility': 'private',
          'x-share-viewer-token': token,
          ...extra,
        },
        body,
      }),
      env,
    );
  }

  it('stores ONLY the token hash, gates GET on the key, and 404s (not 401) without a match', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    const token = 'super-secret-key-abc123';
    const put = await putPrivate(worker, env, 'octocat/q3-secret', '<h1>the secret plan</h1>', token);
    expect(put.status).toBe(200);

    // The raw token NEVER lands in metadata — only its SHA-256 hash.
    const stored = store.get('octocat/q3-secret')!;
    expect(stored.customMetadata.visibility).toBe('private');
    expect(stored.customMetadata['viewer-token-hash']).toBeTruthy();
    expect(JSON.stringify(stored.customMetadata)).not.toContain(token);

    // No key → 404 (never leaks existence, never a 401).
    const noKey = await worker.default.fetch(new Request('https://share.test/octocat/q3-secret'), env);
    expect(noKey.status).toBe(404);

    // Wrong key → 404.
    const wrongKey = await worker.default.fetch(new Request('https://share.test/octocat/q3-secret?k=nope'), env);
    expect(wrongKey.status).toBe(404);

    // Correct ?k= → 200, served no-store + noindex, never cached publicly.
    const withKey = await worker.default.fetch(
      new Request(`https://share.test/octocat/q3-secret?k=${encodeURIComponent(token)}`),
      env,
    );
    expect(withKey.status).toBe(200);
    expect(await withKey.text()).toContain('the secret plan');
    expect(withKey.headers.get('cache-control')).toBe('private, no-store');
    expect(withKey.headers.get('X-Robots-Tag')).toBe('noindex');

    // Authorization: Bearer <token> is accepted too.
    const withBearer = await worker.default.fetch(
      new Request('https://share.test/octocat/q3-secret', { headers: { authorization: `Bearer ${token}` } }),
      env,
    );
    expect(withBearer.status).toBe(200);
  });

  it('refuses a private publish that carries no viewer token (fail loud, 400)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    const res = await worker.default.fetch(
      new Request('https://share.test/octocat/nope', {
        method: 'PUT',
        headers: { authorization: 'Bearer secret', 'content-type': 'text/html', 'x-share-visibility': 'private' },
        body: '<h1>x</h1>',
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('hides a private page from the gallery and the public JSON listing', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/pub', '<h1>pub</h1>');
    await putPrivate(worker, env, 'octocat/hidden', '<h1>hidden</h1>', 'k');

    const listing = await worker.default.fetch(new Request('https://share.test/octocat?format=json'), env);
    const payload = await listing.json();
    expect(payload.objects.map((o: any) => o.slug)).toEqual(['pub']);

    const gallery = await worker.default.fetch(new Request('https://share.test/octocat'), env);
    expect(await gallery.text()).not.toContain('hidden');
  });

  it('gates the generated OG cover of a private page on the key (no preview leak)', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    const token = 'cover-key';
    await putPrivate(worker, env, 'octocat/withcover', '<!doctype html><title>Secret</title><h1>secret</h1>', token, {
      'x-share-og-title': 'Secret',
    });
    const noKey = await worker.default.fetch(
      new Request('https://share.test/octocat/withcover.png', { headers: { accept: 'image/png' } }),
      env,
    );
    expect(noKey.status).toBe(404);

    // Authenticated fetches must still be no-store + noindex. `public` on a
    // Bearer response would let a shared cache serve `/user/slug.png` without
    // Authorization (PHNX-3676).
    const withQuery = await worker.default.fetch(
      new Request(`https://share.test/octocat/withcover.png?k=${encodeURIComponent(token)}`, {
        headers: { accept: 'image/png' },
      }),
      env,
    );
    expect(withQuery.status).toBe(200);
    expect(withQuery.headers.get('content-type')).toBe('image/png');
    expect(withQuery.headers.get('cache-control')).toBe('private, no-store');
    expect(withQuery.headers.get('X-Robots-Tag')).toBe('noindex');

    const withBearer = await worker.default.fetch(
      new Request('https://share.test/octocat/withcover.png', {
        headers: { accept: 'image/png', authorization: `Bearer ${token}` },
      }),
      env,
    );
    expect(withBearer.status).toBe(200);
    expect(withBearer.headers.get('cache-control')).toBe('private, no-store');
    expect(withBearer.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('serves a private non-HTML asset as raw bytes (not the viewer chrome) so the key is never dropped', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    // Publish a private PNG.
    const put = await worker.default.fetch(
      new Request('https://share.test/octocat/pic.png', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'image/png',
          'x-share-visibility': 'private',
          'x-share-viewer-token': 'imgkey',
        },
        body: 'PNGDATA',
      }),
      env,
    );
    expect(put.status).toBe(200);
    // A browser (Accept: text/html) with the key gets the raw image, not an HTML
    // viewer whose inner <img ?raw> would 404 for want of the key.
    const withKey = await worker.default.fetch(
      new Request('https://share.test/octocat/pic.png?k=imgkey', { headers: { accept: 'text/html' } }),
      env,
    );
    expect(withKey.status).toBe(200);
    expect(withKey.headers.get('content-type')).toContain('image/png');
    expect(await withKey.text()).toBe('PNGDATA');
    // Without the key, still 404.
    const noKey = await worker.default.fetch(
      new Request('https://share.test/octocat/pic.png', { headers: { accept: 'text/html' } }),
      env,
    );
    expect(noKey.status).toBe(404);
  });

  it('gates a private revision listing on the key', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await putPrivate(worker, env, 'octocat/rev', '<h1>v1</h1>', 'rkey');
    const noKey = await worker.default.fetch(new Request('https://share.test/octocat/rev?revisions=json'), env);
    expect(noKey.status).toBe(404);
    const withKey = await worker.default.fetch(new Request('https://share.test/octocat/rev?revisions=json&k=rkey'), env);
    expect(withKey.status).toBe(200);
  });

  it('lets the signed-in owner read their own private page without the key', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    (env as any).PHOENIX_ID_BASE = 'https://phoenix.test';
    worker.hooks.verifyPhoenixToken = async () => ({ userId: 'u-owner', email: 'octocat@acme.com' });
    const put = await worker.default.fetch(
      new Request('https://share.test/octocat/mine', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer phoenix',
          'content-type': 'text/html; charset=utf-8',
          'x-share-visibility': 'private',
          'x-share-viewer-token': 'tok',
        },
        body: '<h1>owner-only-ish</h1>',
      }),
      env,
    );
    expect(put.status).toBe(200);

    // Owner (resolved bearer identity) reads without ?k.
    const owner = await worker.default.fetch(
      new Request('https://share.test/octocat/mine', { headers: { authorization: 'Bearer phoenix' } }),
      env,
    );
    expect(owner.status).toBe(200);

    // A non-owner without the key still 404s.
    worker.hooks.verifyPhoenixToken = async () => null;
    const anon = await worker.default.fetch(new Request('https://share.test/octocat/mine'), env);
    expect(anon.status).toBe(404);
  });

  it('refuses to set visibility=private via the in-place PATCH edit route', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/page', '<h1>page</h1>');
    const res = await worker.default.fetch(
      new Request('https://share.test/octocat/page', {
        method: 'PATCH',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: 'private' }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe('PHNX-3547 collision recovery, CAS republish, alternate handles', () => {
  function setupPhoenix(worker: any, env: any, identity: { userId: string; email: string }) {
    (env as any).PHOENIX_ID_BASE = 'https://phoenix.test';
    worker.hooks.verifyPhoenixToken = async () => identity;
  }

  async function phoenixPut(
    worker: any,
    env: any,
    key: string,
    body: string,
    headers: Record<string, string> = {},
  ) {
    return worker.default.fetch(
      new Request(`https://share.test/${key}`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer phoenix',
          'content-type': 'text/html; charset=utf-8',
          ...headers,
        },
        body,
      }),
      env,
    );
  }

  it('transfers the handle and re-stamps objects when the SAME email returns under a NEW userId (account move)', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    setupPhoenix(worker, env, { userId: 'user-1', email: 'john@a.com' });
    const first = await phoenixPut(worker, env, 'john/one', 'one');
    expect(first.status).toBe(200);

    // The account moves providers: same verified email, brand-new userId.
    setupPhoenix(worker, env, { userId: 'user-2', email: 'john@a.com' });
    const second = await phoenixPut(worker, env, 'john/two', 'two');
    expect(second.status).toBe(200);
    expect(store.has('john/two')).toBe(true);
    // The claim re-bound to the new userId AND the old account's page re-stamped.
    expect(store.get('__handles/john')!.customMetadata.userId).toBe('user-2');
    expect(store.get('john/one')!.customMetadata.owner).toBe('user-2');
    // The moved owner now manages the transferred page (PATCH + DELETE work).
    const patch = await worker.default.fetch(
      new Request('https://share.test/john/one', {
        method: 'PATCH',
        headers: { authorization: 'Bearer phoenix', 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'moved' }),
      }),
      env,
    );
    expect(patch.status).toBe(200);
    const del = await worker.default.fetch(
      new Request('https://share.test/john/one', { method: 'DELETE', headers: { authorization: 'Bearer phoenix' } }),
      env,
    );
    expect(del.status).toBe(200);
    expect(store.has('john/one')).toBe(false);
  });

  it('PATCH transfers a same-email account move before any republish', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    setupPhoenix(worker, env, { userId: 'user-1', email: 'john@a.com' });
    expect((await phoenixPut(worker, env, 'john/one', 'one')).status).toBe(200);

    setupPhoenix(worker, env, { userId: 'user-2', email: 'john@a.com' });
    const patch = await worker.default.fetch(
      new Request('https://share.test/john/one', {
        method: 'PATCH',
        headers: { authorization: 'Bearer phoenix', 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'moved before republish' }),
      }),
      env,
    );

    expect(patch.status).toBe(200);
    expect(store.get('__handles/john')!.customMetadata.userId).toBe('user-2');
    expect(store.get('john/one')!.customMetadata).toMatchObject({ owner: 'user-2', label: 'moved before republish' });
  });

  it('keeps the permanent 409 when the colliding claim has no recorded email (legacy claim)', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    // A claim written before the claim recorded emails cannot prove an account
    // move — the requester must pick an alternate handle.
    store.set('__handles/john', {
      body: Buffer.from(JSON.stringify({ userId: 'user-1' })),
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { userId: 'user-1', visibility: 'unlisted' },
      uploaded: new Date().toISOString(),
      size: 20,
      etag: 'legacy-claim',
    });
    setupPhoenix(worker, env, { userId: 'user-2', email: 'john@a.com' });
    const res = await phoenixPut(worker, env, 'john/two', 'two');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'handle taken', handle: 'john' });
    expect(store.has('john/two')).toBe(false);
  });

  it('still 409s a different email with the same local-part (no transfer on a real collision)', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    setupPhoenix(worker, env, { userId: 'user-1', email: 'john@a.com' });
    expect((await phoenixPut(worker, env, 'john/one', 'one')).status).toBe(200);
    setupPhoenix(worker, env, { userId: 'user-2', email: 'john@b.com' });
    const res = await phoenixPut(worker, env, 'john/two', 'two');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'handle taken', handle: 'john' });
    expect(store.get('__handles/john')!.customMetadata.userId).toBe('user-1');
  });

  it('publishes under an explicit x-share-handle and binds it first-writer; the owner can PATCH/DELETE it', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    setupPhoenix(worker, env, { userId: 'alice-1', email: 'alice@example.com' });
    const put = await phoenixPut(worker, env, 'vanity/page', 'hi', { 'x-share-handle': 'vanity' });
    expect(put.status).toBe(200);
    expect(store.get('__handles/vanity')!.customMetadata.userId).toBe('alice-1');
    // The derived-handle claim was not created by the alternate publish.
    expect(store.has('__handles/alice')).toBe(false);

    // A rival cannot take the claimed alternate handle...
    setupPhoenix(worker, env, { userId: 'bob-1', email: 'bob@example.com' });
    const rival = await phoenixPut(worker, env, 'vanity/other', 'x', { 'x-share-handle': 'vanity' });
    expect(rival.status).toBe(409);
    expect(await rival.json()).toMatchObject({ error: 'handle taken', handle: 'vanity' });
    // ...and cannot publish under alice's derived handle without the header either.
    const derived = await phoenixPut(worker, env, 'vanity/page', 'x');
    expect(derived.status).toBe(403);
    const foreign = await phoenixPut(worker, env, 'alice/page', 'x');
    expect(foreign.status).toBe(403);

    // The alternate-handle owner manages their pages via PATCH and DELETE.
    setupPhoenix(worker, env, { userId: 'alice-1', email: 'alice@example.com' });
    const patch = await worker.default.fetch(
      new Request('https://share.test/vanity/page', {
        method: 'PATCH',
        headers: { authorization: 'Bearer phoenix', 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'mine' }),
      }),
      env,
    );
    expect(patch.status).toBe(200);
    const del = await worker.default.fetch(
      new Request('https://share.test/vanity/page', { method: 'DELETE', headers: { authorization: 'Bearer phoenix' } }),
      env,
    );
    expect(del.status).toBe(200);
    expect(store.has('vanity/page')).toBe(false);
  });

  it('400s an x-share-handle that sanitizes to empty or exceeds 63 chars', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    setupPhoenix(worker, env, { userId: 'alice-1', email: 'alice@example.com' });
    const empty = await phoenixPut(worker, env, 'x/page', 'hi', { 'x-share-handle': '!!!' });
    expect(empty.status).toBe(400);
    const long = await phoenixPut(worker, env, 'x/page', 'hi', { 'x-share-handle': 'a'.repeat(64) });
    expect(long.status).toBe(400);
    expect(store.has('x/page')).toBe(false);
  });

  it('a republish that loses the CAS race retries and EVERY body survives — winner as revision, loser canonical (PHNX-3547)', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    setupPhoenix(worker, env, { userId: 'u1', email: 'octocat@acme.com' });
    expect((await phoenixPut(worker, env, 'octocat/racy', 'v1-body')).status).toBe(200);

    // Simulate a concurrent writer winning the canonical key mid-flight: the
    // loser's first conditional put returns null (R2's CAS-mismatch signal) and
    // the interloper's body is already canonical by the retry's re-read. The
    // FIRST canonical put the wrapper sees is this v2 publish (v1 landed before
    // the wrapper was installed).
    const bucket = env.BUCKET;
    let canonicalPuts = 0;
    (env as any).BUCKET = {
      ...bucket,
      put: async (key: string, body: unknown, opts: unknown) => {
        if (key === 'octocat/racy') {
          canonicalPuts += 1;
          if (canonicalPuts === 1) {
            await bucket.put(key, 'interloper-body', { httpMetadata: { contentType: 'text/html' } });
            return null;
          }
        }
        return bucket.put(key, body as BodyInit, opts as never);
      },
    };

    const res = await phoenixPut(worker, env, 'octocat/racy', 'v2-body');
    expect(res.status).toBe(200);
    // The retried publish landed its own body canonical...
    expect(store.get('octocat/racy')!.body.toString()).toBe('v2-body');
    // ...the concurrent winner's body survived as a retained revision...
    const revs = [...store.keys()]
      .filter((k) => k.startsWith('octocat/racy/rev-'))
      .map((k) => store.get(k)!.body.toString());
    expect(revs).toContain('interloper-body');
    // ...and so did the original version.
    expect(revs).toContain('v1-body');
  });

  it('refunds the charged ledger bytes when every conditional write attempt is exhausted', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    setupPhoenix(worker, env, { userId: 'u1', email: 'octocat@acme.com' });
    expect((await phoenixPut(worker, env, 'octocat/exhausted', 'original')).status).toBe(200);
    const before = JSON.parse(store.get('__usage/u1')!.body.toString('utf8'));
    const bucket = env.BUCKET;
    let attempts = 0;
    (env as any).BUCKET = {
      ...bucket,
      put: async (key: string, body: unknown, opts: unknown) => {
        if (key === 'octocat/exhausted') {
          attempts += 1;
          return null;
        }
        return bucket.put(key, body as BodyInit, opts as never);
      },
    };

    const res = await phoenixPut(worker, env, 'octocat/exhausted', 'charged-body', { 'x-share-no-revision': 'true' });
    expect(res.status).toBe(409);
    expect(attempts).toBe(3);
    const ledger = JSON.parse(store.get('__usage/u1')!.body.toString('utf8'));
    expect(ledger.bytes).toBe(before.bytes);
    expect(ledger.count).toBe(before.count);
    expect(store.get('octocat/exhausted')!.body.toString()).toBe('original');
  });

  it('gives the loser a 409 when two first publishes race to create the same canonical key', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    setupPhoenix(worker, env, { userId: 'u1', email: 'octocat@acme.com' });
    const usage = Buffer.from(JSON.stringify({ bytes: 0, count: 0, plan: 'free', rlStart: Date.now(), rlUsed: 0 }));
    store.set('__usage/u1', {
      body: usage,
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {},
      uploaded: new Date().toISOString(),
      size: usage.length,
      etag: 'usage-seed',
    });

    const [a, b] = await Promise.all([
      phoenixPut(worker, env, 'octocat/first-race', 'first-body'),
      phoenixPut(worker, env, 'octocat/first-race', 'second-body'),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(['first-body', 'second-body']).toContain(store.get('octocat/first-race')!.body.toString());
    const ledger = JSON.parse(store.get('__usage/u1')!.body.toString('utf8'));
    expect(ledger.bytes).toBe(store.get('octocat/first-race')!.size);
    expect(ledger.count).toBe(1);
  });

  it('a BYO concurrent-write conflict 409s instead of silently losing a body', async () => {
    const worker = await loadWorker();
    const { env, store } = makeEnv();
    await put(worker, env, 'octocat/racy', 'v1-body');
    const bucket = env.BUCKET;
    let canonicalPuts = 0;
    (env as any).BUCKET = {
      ...bucket,
      put: async (key: string, body: unknown, opts: unknown) => {
        // A BYO stream cannot be re-read, so the first conditional canonical put
        // that loses the race must 409 loud rather than overwrite. Only the
        // FIRST canonical put the wrapper sees is sabotaged — the initial v1
        // write landed before the wrapper was installed.
        if (key === 'octocat/racy') {
          canonicalPuts += 1;
          if (canonicalPuts === 1) return null;
        }
        return bucket.put(key, body as BodyInit, opts as never);
      },
    };
    const res = await worker.default.fetch(
      new Request('https://share.test/octocat/racy', {
        method: 'PUT',
        headers: { authorization: 'Bearer secret', 'content-type': 'text/html; charset=utf-8' },
        body: 'v2-body',
      }),
      env,
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('publish conflict');
    expect(store.get('octocat/racy')!.body.toString()).toBe('v1-body');
  });
});

// ---- Same-origin human collaboration transport (PHNX-3835) ----
//
// These exercise the GENERATED Worker's /__collab/* proxy end to end: the
// object-first R2 load, server-side identity/visibility/provenance derivation,
// page-gate reuse, the Prix upstream contract, SSE streaming, and fail-closed
// behaviour. The Prix hop is the ONE stubbed seam (via hooks.collabFetch), the
// same way the identity-server hop is stubbed via hooks.verifyPhoenixToken.

const COLLAB_BASE = 'https://prix.test';
const COLLAB_SECRET = 'svc-secret-do-not-leak';

// A Phoenix identity per bearer token, so one override serves owner /
// same-company / cross-company callers in the same test.
const COLLAB_IDS: Record<string, { userId: string; email: string }> = {
  owner: { userId: 'u1', email: 'octocat@acme.com' },
  sameco: { userId: 'u2', email: 'alice@acme.com' },
  crossco: { userId: 'u3', email: 'bob@evil.com' },
};

function collabEnv() {
  const made = makeEnv();
  (made.env as any).PHOENIX_ID_BASE = 'https://phoenix.test';
  (made.env as any).PRIX_ARTIFACT_COLLAB_BASE = COLLAB_BASE;
  (made.env as any).ARTIFACT_COLLAB_SERVICE_TOKEN = COLLAB_SECRET;
  return made;
}

function setCollabIdentities(worker: any) {
  worker.hooks.verifyPhoenixToken = async (req: Request) => {
    const b = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    return COLLAB_IDS[b] || null;
  };
}

interface CollabCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function recordCollab(worker: any, respond?: () => Response): CollabCall[] {
  const calls: CollabCall[] = [];
  worker.hooks.collabFetch = async (req: Request) => {
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    const body = req.method === 'POST' || req.method === 'PATCH' ? await req.text() : '';
    calls.push({ url: req.url, method: req.method, headers, body });
    return respond
      ? respond()
      : new Response(JSON.stringify({ ok: true, threads: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}

// The Worker derives the share id as SHA-256 over owner + NUL + normalized path.
function expectedShareId(owner: string, path: string): string {
  return createHash('sha256').update(owner + '\u0000' + path).digest('hex');
}

// Publish a managed page owned by u1 (@octocat) at the given visibility.
async function publishManaged(
  worker: any,
  env: any,
  key: string,
  visibility: string,
  extra: Record<string, string> = {},
) {
  setCollabIdentities(worker);
  const headers: Record<string, string> = {
    authorization: 'Bearer owner',
    'content-type': 'text/html; charset=utf-8',
    'x-share-visibility': visibility,
    ...extra,
  };
  const res = await worker.default.fetch(
    new Request(`https://share.test/${key}`, { method: 'PUT', headers, body: '<h1>doc</h1>' }),
    env,
  );
  expect(res.status).toBe(200);
}

describe('collaboration transport (/__collab)', () => {
  it('loads the R2 object first and derives share id + revision + provenance server-side', async () => {
    const worker = await loadWorker();
    const { env, store } = collabEnv();
    await publishManaged(worker, env, 'octocat/plan', 'public', {
      'x-share-agent': 'claude',
      'x-share-session': 'sess-123',
      'x-share-host': 'zion',
      'x-share-repo': 'phnx-labs/agents-cli',
    });
    const calls = recordCollab(worker);

    const res = await worker.default.fetch(
      new Request('https://share.test/__collab/context?share=octocat%2Fplan'),
      env,
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe(`${COLLAB_BASE}/v1/artifact-collaboration/context`);
    expect(call.headers.authorization).toBe(`Bearer ${COLLAB_SECRET}`);
    expect(call.headers['x-artifact-share-id']).toBe(expectedShareId('u1', 'octocat/plan'));
    expect(call.headers['x-artifact-revision']).toBe(store.get('octocat/plan')!.etag);
    expect(call.headers['x-artifact-visibility']).toBe('public');
    expect(call.headers['x-artifact-owner-id']).toBe('u1');
    expect(call.headers['x-artifact-agent']).toBe('claude');
    expect(call.headers['x-artifact-session']).toBe('sess-123');
    expect(call.headers['x-artifact-host']).toBe('zion');
    expect(call.headers['x-artifact-repo']).toBe('phnx-labs/agents-cli');
  });

  it('404s a collaboration request for a share that does not exist', async () => {
    const worker = await loadWorker();
    const { env } = collabEnv();
    setCollabIdentities(worker);
    const calls = recordCollab(worker);
    const res = await worker.default.fetch(
      new Request('https://share.test/__collab/threads?share=octocat%2Fghost'),
      env,
    );
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('forwards X-Artifact-Visibility verbatim for every visibility level', async () => {
    for (const [vis, viewer, key, extra] of [
      ['public', undefined, 'octocat/pub', {}],
      ['unlisted', undefined, 'octocat/unl', {}],
      ['me', 'owner', 'octocat/me', {}],
      ['org', 'owner', 'octocat/org', {}],
      ['private', 'owner', 'octocat/priv', { 'x-share-viewer-token': 'tok' }],
    ] as const) {
      const worker = await loadWorker();
      const { env } = collabEnv();
      await publishManaged(worker, env, key, vis, extra as Record<string, string>);
      const calls = recordCollab(worker);
      const headers: Record<string, string> = {};
      if (viewer) headers.authorization = `Bearer ${viewer}`;
      const q = vis === 'private' ? `?share=${encodeURIComponent(key)}&k=tok` : `?share=${encodeURIComponent(key)}`;
      const res = await worker.default.fetch(
        new Request(`https://share.test/__collab/context${q}`, { headers }),
        env,
      );
      expect(res.status).toBe(200);
      expect(calls[0].headers['x-artifact-visibility']).toBe(vis);
    }
  });

  it('lets a same-company reader through and 404s a cross-company reader/writer/subscriber', async () => {
    const worker = await loadWorker();
    const { env } = collabEnv();
    await publishManaged(worker, env, 'octocat/org', 'org');

    const okCalls = recordCollab(worker);
    const ok = await worker.default.fetch(
      new Request('https://share.test/__collab/threads?share=octocat%2Forg', { headers: { authorization: 'Bearer sameco' } }),
      env,
    );
    expect(ok.status).toBe(200);
    expect(okCalls[0].headers['x-artifact-org-domain']).toBe('acme.com');
    expect(okCalls[0].headers['x-phoenix-actor-id']).toBe('u2');
    expect(okCalls[0].headers['x-phoenix-actor-email']).toBe('alice@acme.com');

    const denyCalls = recordCollab(worker);
    const read = await worker.default.fetch(
      new Request('https://share.test/__collab/threads?share=octocat%2Forg', { headers: { authorization: 'Bearer crossco' } }),
      env,
    );
    const write = await worker.default.fetch(
      new Request('https://share.test/__collab/threads', {
        method: 'POST',
        headers: { authorization: 'Bearer crossco', 'content-type': 'application/json' },
        body: JSON.stringify({ share: 'octocat/org', anchor: {}, body: 'hi' }),
      }),
      env,
    );
    const events = await worker.default.fetch(
      new Request('https://share.test/__collab/events?share=octocat%2Forg', { headers: { authorization: 'Bearer crossco' } }),
      env,
    );
    expect(read.status).toBe(404);
    expect(write.status).toBe(404);
    expect(events.status).toBe(404);
    expect(denyCalls).toHaveLength(0);
  });

  it('allows an anonymous read of a public page but requires a signed-in human to write', async () => {
    const worker = await loadWorker();
    const { env } = collabEnv();
    await publishManaged(worker, env, 'octocat/plan', 'public');

    const readCalls = recordCollab(worker);
    const read = await worker.default.fetch(new Request('https://share.test/__collab/threads?share=octocat%2Fplan'), env);
    expect(read.status).toBe(200);
    expect(readCalls).toHaveLength(1);
    expect(readCalls[0].headers['x-phoenix-actor-id']).toBeUndefined();

    const writeCalls = recordCollab(worker);
    const anonWrite = await worker.default.fetch(
      new Request('https://share.test/__collab/threads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ share: 'octocat/plan', anchor: {}, body: 'hi' }),
      }),
      env,
    );
    expect(anonWrite.status).toBe(401);
    expect(writeCalls).toHaveLength(0);

    const okWrite = await worker.default.fetch(
      new Request('https://share.test/__collab/threads', {
        method: 'POST',
        headers: { authorization: 'Bearer sameco', 'content-type': 'application/json' },
        body: JSON.stringify({ share: 'octocat/plan', anchor: { block: 3 }, body: 'looks good' }),
      }),
      env,
    );
    expect(okWrite.status).toBe(200);
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].headers['x-phoenix-actor-id']).toBe('u2');
    expect(JSON.parse(writeCalls[0].body)).toMatchObject({ share: 'octocat/plan', anchor: { block: 3 }, body: 'looks good' });
  });

  it('enforces the private viewer token on reads and still requires a Phoenix human to write', async () => {
    const worker = await loadWorker();
    const { env } = collabEnv();
    await publishManaged(worker, env, 'octocat/secret', 'private', { 'x-share-viewer-token': 'tok' });

    const missCalls = recordCollab(worker);
    const noToken = await worker.default.fetch(new Request('https://share.test/__collab/threads?share=octocat%2Fsecret'), env);
    expect(noToken.status).toBe(404);
    expect(missCalls).toHaveLength(0);

    const calls = recordCollab(worker);
    const read = await worker.default.fetch(new Request('https://share.test/__collab/threads?share=octocat%2Fsecret&k=tok'), env);
    expect(read.status).toBe(200);
    // A write WITHOUT the token can't even learn the page exists — the token
    // read gate 404s before the write-identity check.
    const noTokenWrite = await worker.default.fetch(
      new Request('https://share.test/__collab/threads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ share: 'octocat/secret', anchor: {}, body: 'x' }),
      }),
      env,
    );
    expect(noTokenWrite.status).toBe(404);
    // WITH the token but anonymous — read gate passes, but a write still needs a
    // signed-in Phoenix human → 401.
    const anonWrite = await worker.default.fetch(
      new Request('https://share.test/__collab/threads?k=tok', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ share: 'octocat/secret', anchor: {}, body: 'x' }),
      }),
      env,
    );
    expect(anonWrite.status).toBe(401);

    const humanWrite = await worker.default.fetch(
      new Request('https://share.test/__collab/threads?share=octocat%2Fsecret&k=tok', {
        method: 'POST',
        headers: { authorization: 'Bearer sameco', 'content-type': 'application/json' },
        body: JSON.stringify({ share: 'octocat/secret', anchor: {}, body: 'x' }),
      }),
      env,
    );
    expect(humanWrite.status).toBe(200);
  });

  it('ignores browser-supplied identity/metadata and derives everything from R2', async () => {
    const worker = await loadWorker();
    const { env } = collabEnv();
    await publishManaged(worker, env, 'octocat/plan', 'public');
    const calls = recordCollab(worker);

    const res = await worker.default.fetch(
      new Request('https://share.test/__collab/threads', {
        method: 'POST',
        headers: { authorization: 'Bearer sameco', 'content-type': 'application/json' },
        body: JSON.stringify({
          share: 'octocat/plan',
          anchor: {},
          body: 'hi',
          owner: 'attacker',
          visibility: 'org',
          shareId: 'forged',
          actorId: 'admin',
          orgDomain: 'evil.com',
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(calls[0].headers['x-artifact-owner-id']).toBe('u1');
    expect(calls[0].headers['x-artifact-visibility']).toBe('public');
    expect(calls[0].headers['x-artifact-share-id']).toBe(expectedShareId('u1', 'octocat/plan'));
    expect(calls[0].headers['x-phoenix-actor-id']).toBe('u2');
    expect(calls[0].headers['x-artifact-org-domain']).toBeUndefined();
  });

  it('forwards the Idempotency-Key on mutations', async () => {
    const worker = await loadWorker();
    const { env } = collabEnv();
    await publishManaged(worker, env, 'octocat/plan', 'public');
    const calls = recordCollab(worker);

    await worker.default.fetch(
      new Request('https://share.test/__collab/threads', {
        method: 'POST',
        headers: { authorization: 'Bearer sameco', 'content-type': 'application/json', 'idempotency-key': 'idem-abc' },
        body: JSON.stringify({ share: 'octocat/plan', anchor: {}, body: 'hi' }),
      }),
      env,
    );
    expect(calls[0].headers['idempotency-key']).toBe('idem-abc');
  });

  it('maps every browser sub-route to its Prix route', async () => {
    const worker = await loadWorker();
    const { env } = collabEnv();
    await publishManaged(worker, env, 'octocat/plan', 'public');
    const calls = recordCollab(worker);
    const auth = { authorization: 'Bearer sameco', 'content-type': 'application/json' };

    await worker.default.fetch(new Request('https://share.test/__collab/threads?share=octocat%2Fplan&after=cur1'), env);
    await worker.default.fetch(new Request('https://share.test/__collab/threads/T1/replies', { method: 'POST', headers: auth, body: JSON.stringify({ share: 'octocat/plan', body: 'r' }) }), env);
    await worker.default.fetch(new Request('https://share.test/__collab/comments/C1', { method: 'PATCH', headers: auth, body: JSON.stringify({ share: 'octocat/plan', deleted: true }) }), env);
    await worker.default.fetch(new Request('https://share.test/__collab/threads/T1', { method: 'PATCH', headers: auth, body: JSON.stringify({ share: 'octocat/plan', status: 'resolved' }) }), env);

    expect(calls[0].url).toBe(`${COLLAB_BASE}/v1/artifact-collaboration/threads?after=cur1`);
    expect(calls[1].url).toBe(`${COLLAB_BASE}/v1/artifact-collaboration/threads/T1/replies`);
    expect(calls[2].url).toBe(`${COLLAB_BASE}/v1/artifact-collaboration/comments/C1`);
    expect(calls[3].url).toBe(`${COLLAB_BASE}/v1/artifact-collaboration/threads/T1`);
  });

  it('never serializes the service secret into a browser-facing response, and marks every collab response no-store', async () => {
    const worker = await loadWorker();
    const { env } = collabEnv();
    await publishManaged(worker, env, 'octocat/plan', 'public');
    recordCollab(worker, () => new Response(JSON.stringify({ threads: [{ id: 't1', body: 'hi' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const res = await worker.default.fetch(new Request('https://share.test/__collab/threads?share=octocat%2Fplan'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toContain(COLLAB_SECRET);
    expect([...res.headers.keys()]).not.toContain('authorization');
    expect(renderWorkerScript()).not.toContain(COLLAB_SECRET);
  });

  it('streams SSE through unbuffered, forwards Last-Event-ID, and propagates client cancel', async () => {
    const worker = await loadWorker();
    const { env } = collabEnv();
    await publishManaged(worker, env, 'octocat/plan', 'public');

    let cancelled = false;
    const upstreamStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('id: 7\ndata: hello\n\n'));
      },
      cancel() { cancelled = true; },
    });
    const calls = recordCollab(worker, () => new Response(upstreamStream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    const res = await worker.default.fetch(
      new Request('https://share.test/__collab/events?share=octocat%2Fplan', { headers: { 'last-event-id': '7' } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(calls[0].headers['last-event-id']).toBe('7');
    expect(calls[0].headers.accept).toBe('text/event-stream');

    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value as Uint8Array)).toBe('id: 7\ndata: hello\n\n');
    await reader.cancel();
    expect(cancelled).toBe(true);
  });

  it('fails closed (404) for the whole surface when the managed backend is unconfigured, without affecting page GET', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    await put(worker, env, 'octocat/plan', '<h1>doc</h1>');
    const calls = recordCollab(worker);

    const collab = await worker.default.fetch(new Request('https://share.test/__collab/context?share=octocat%2Fplan'), env);
    expect(collab.status).toBe(404);
    expect(calls).toHaveLength(0);

    const page = await worker.default.fetch(new Request('https://share.test/octocat/plan'), env);
    expect(page.status).toBe(200);
  });

  it('also fails closed when only one of the two config values is present', async () => {
    const worker = await loadWorker();
    const { env } = makeEnv();
    (env as any).PRIX_ARTIFACT_COLLAB_BASE = COLLAB_BASE;
    await put(worker, env, 'octocat/plan', '<h1>doc</h1>');
    const res = await worker.default.fetch(new Request('https://share.test/__collab/context?share=octocat%2Fplan'), env);
    expect(res.status).toBe(404);
  });

  it('makes comments inaccessible on delete and fires a best-effort Prix purge', async () => {
    const worker = await loadWorker();
    const { env } = collabEnv();
    await publishManaged(worker, env, 'octocat/plan', 'public');
    const calls = recordCollab(worker);

    const del = await worker.default.fetch(
      new Request('https://share.test/octocat/plan', { method: 'DELETE', headers: { authorization: 'Bearer owner' } }),
      env,
    );
    expect(del.status).toBe(200);

    const purge = calls.find((c) => c.url.endsWith('/v1/artifact-collaboration/purge'));
    expect(purge).toBeDefined();
    expect(purge!.method).toBe('POST');
    expect(purge!.headers.authorization).toBe(`Bearer ${COLLAB_SECRET}`);
    expect(purge!.headers['x-artifact-share-id']).toBe(expectedShareId('u1', 'octocat/plan'));

    const after = await worker.default.fetch(new Request('https://share.test/__collab/threads?share=octocat%2Fplan'), env);
    expect(after.status).toBe(404);
  });

  it('does not expose /__collab as an enumerable GET (unknown sub-route 404s)', async () => {
    const worker = await loadWorker();
    const { env } = collabEnv();
    await publishManaged(worker, env, 'octocat/plan', 'public');
    recordCollab(worker);
    const res = await worker.default.fetch(new Request('https://share.test/__collab/bogus?share=octocat%2Fplan'), env);
    expect(res.status).toBe(404);
  });

  it('refuses a collab lookup that targets an internal __-prefixed key', async () => {
    const worker = await loadWorker();
    const { env } = collabEnv();
    setCollabIdentities(worker);
    const calls = recordCollab(worker);
    const res = await worker.default.fetch(new Request('https://share.test/__collab/context?share=__handles%2Foctocat'), env);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
