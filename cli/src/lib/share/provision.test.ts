import { describe, expect, it } from 'vitest';
import {
  addCustomDomain,
  configureBucketLifecycle,
  createBucket,
  deployWorker,
  enableWorkersDev,
  findZoneId,
  hashWorkerScript,
  SHARE_LIFECYCLE_RETENTION_DAYS,
  SHARE_LIFECYCLE_RULE_ID,
  buildShareLifecycleRule,
  mergeShareLifecycleRule,
  putWorkerSecret,
  setWorkerSecret,
  updateWorker,
  WORKER_PHOENIX_ID_BASE_SECRET,
  type CloudflareRequest,
  type CloudflareRequester,
} from './provision.js';
import { renderWorkerBundle } from './worker-template.js';

describe('share bucket lifecycle', () => {
  it('builds the Cloudflare R2 lifecycle rule that deletes old share objects', () => {
    expect(buildShareLifecycleRule()).toEqual({
      id: SHARE_LIFECYCLE_RULE_ID,
      enabled: true,
      conditions: { prefix: '' },
      deleteObjectsTransition: {
        condition: { type: 'Age', maxAge: SHARE_LIFECYCLE_RETENTION_DAYS * 86400 },
      },
    });
  });

  it('preserves unrelated lifecycle rules and replaces the managed share rule', () => {
    const unrelated = {
      id: 'keep-logs',
      enabled: true,
      conditions: { prefix: 'logs/' },
      deleteObjectsTransition: { condition: { type: 'Age' as const, maxAge: 30 * 86400 } },
    };
    const staleShareRule = {
      id: SHARE_LIFECYCLE_RULE_ID,
      enabled: false,
      conditions: { prefix: '' },
      deleteObjectsTransition: { condition: { type: 'Age' as const, maxAge: 7 * 86400 } },
    };

    expect(mergeShareLifecycleRule([unrelated, staleShareRule])).toEqual([
      unrelated,
      buildShareLifecycleRule(),
    ]);
  });
});

describe('share Cloudflare provisioning request shape', () => {
  it('creates the R2 bucket with account scope and bucket name', async () => {
    const seen: CloudflareRequest[] = [];
    await createBucket('cf-token', 'acct_1', 'agents-share', {
      request: async (req) => {
        seen.push(req);
        return {};
      },
    });

    expect(seen).toEqual([
      {
        apiToken: 'cf-token',
        method: 'POST',
        pathname: '/accounts/acct_1/r2/buckets',
        body: { name: 'agents-share' },
      },
    ]);
  });

  it('merges the share lifecycle rule without dropping existing bucket rules', async () => {
    const seen: CloudflareRequest[] = [];
    const existingRule = {
      id: 'keep-logs',
      conditions: { prefix: 'logs/' },
      enabled: true,
      deleteObjectsTransition: { condition: { type: 'Age' as const, maxAge: 7 * 24 * 60 * 60 } },
    };
    const request: CloudflareRequester = async (req) => {
      seen.push(req);
      if (req.method === 'GET') {
        return {
          rules: [
            existingRule,
            {
              id: SHARE_LIFECYCLE_RULE_ID,
              conditions: { prefix: '' },
              enabled: false,
            },
          ],
        };
      }
      return {};
    };

    await configureBucketLifecycle('cf-token', 'acct_1', 'agents-share', { request });

    expect(seen).toEqual([
      {
        apiToken: 'cf-token',
        method: 'GET',
        pathname: '/accounts/acct_1/r2/buckets/agents-share/lifecycle',
      },
      {
        apiToken: 'cf-token',
        method: 'PUT',
        pathname: '/accounts/acct_1/r2/buckets/agents-share/lifecycle',
        body: {
          rules: [
            existingRule,
            {
              id: SHARE_LIFECYCLE_RULE_ID,
              conditions: { prefix: '' },
              enabled: true,
              deleteObjectsTransition: {
                condition: { type: 'Age', maxAge: SHARE_LIFECYCLE_RETENTION_DAYS * 86400 },
              },
            },
          ],
        },
      },
    ]);
  });

  it('deploys a module worker with the R2 bucket binding', async () => {
    let upload: CloudflareRequest | undefined;
    await deployWorker('cf-token', 'acct_1', 'worker-one', 'export default {}', 'bucket-one', {
      request: async (req) => {
        upload = req;
        return {};
      },
    });

    expect(upload?.apiToken).toBe('cf-token');
    expect(upload?.method).toBe('PUT');
    expect(upload?.pathname).toBe('/accounts/acct_1/workers/scripts/worker-one');
    const metadata = JSON.parse(await (upload?.form?.get('metadata') as Blob).text());
    expect(metadata).toEqual({
      main_module: 'worker.js',
      compatibility_date: '2024-11-06',
      bindings: [
        { type: 'r2_bucket', name: 'BUCKET', bucket_name: 'bucket-one' },
      ],
    });
    expect(await (upload?.form?.get('worker.js') as File).text()).toBe('export default {}');
  });

  it('uploads renderer WASM as compiled modules beside the JavaScript entrypoint', async () => {
    let upload: CloudflareRequest | undefined;
    const bundle = renderWorkerBundle();
    await deployWorker('cf-token', 'acct_1', 'worker-one', bundle, 'bucket-one', {
      request: async (req) => {
        upload = req;
        return {};
      },
    });

    expect(bundle.modules).toHaveLength(2);
    for (const module of bundle.modules) {
      const part = upload?.form?.get(module.name) as File;
      expect(part).toBeInstanceOf(File);
      expect(part.type).toBe('application/wasm');
      expect(new Uint8Array(await part.arrayBuffer()).subarray(0, 4)).toEqual(
        new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
      );
      expect(bundle.script).toContain(`./${module.name}`);
    }
  });

  it('sets WRITE_TOKEN through the Workers Secrets API', async () => {
    const seen: CloudflareRequest[] = [];
    await setWorkerSecret('cf-token', 'acct_1', 'worker-one', 'write-token', {
      request: async (req) => {
        seen.push(req);
        return {};
      },
    });

    expect(seen).toEqual([
      {
        apiToken: 'cf-token',
        method: 'PUT',
        pathname: '/accounts/acct_1/workers/scripts/worker-one/secrets',
        body: { name: 'WRITE_TOKEN', text: 'write-token', type: 'secret_text' },
      },
    ]);
  });

  it('puts an arbitrary secret_text binding (PHOENIX_ID_BASE uses this)', async () => {
    const seen: CloudflareRequest[] = [];
    await putWorkerSecret('cf-token', 'acct_1', 'worker-one', WORKER_PHOENIX_ID_BASE_SECRET, 'https://phoenix.test', {
      request: async (req) => {
        seen.push(req);
        return {};
      },
    });

    expect(seen).toEqual([
      {
        apiToken: 'cf-token',
        method: 'PUT',
        pathname: '/accounts/acct_1/workers/scripts/worker-one/secrets',
        body: { name: 'PHOENIX_ID_BASE', text: 'https://phoenix.test', type: 'secret_text' },
      },
    ]);
  });

  it('enables workers.dev and returns the account subdomain', async () => {
    const seen: CloudflareRequest[] = [];
    const request: CloudflareRequester = async (req) => {
      seen.push(req);
      if (req.method === 'GET') return { subdomain: 'agent-share' };
      return {};
    };

    await expect(enableWorkersDev('cf-token', 'acct_1', 'worker-one', { request })).resolves.toBe('agent-share');
    expect(seen).toEqual([
      {
        apiToken: 'cf-token',
        method: 'POST',
        pathname: '/accounts/acct_1/workers/scripts/worker-one/subdomain',
        body: { enabled: true, previews_enabled: false },
      },
      {
        apiToken: 'cf-token',
        method: 'GET',
        pathname: '/accounts/acct_1/workers/subdomain',
      },
    ]);
  });

  it('checks the exact hostname before the parent zone and returns the first visible zone', async () => {
    const paths: string[] = [];
    const request: CloudflareRequester = async (req) => {
      paths.push(req.pathname);
      if (req.pathname === '/zones?name=agents-cli.sh') return [{ id: 'zone_1', name: 'agents-cli.sh' }];
      return [];
    };

    await expect(findZoneId('cf-token', 'share.agents-cli.sh', { request })).resolves.toBe('zone_1');
    expect(paths).toEqual(['/zones?name=share.agents-cli.sh', '/zones?name=agents-cli.sh']);
  });

  it('reads then writes the bucket lifecycle, merging the managed rule into existing rules', async () => {
    const seen: CloudflareRequest[] = [];
    const unrelated = {
      id: 'keep-logs',
      enabled: true,
      conditions: { prefix: 'logs/' },
      deleteObjectsTransition: { condition: { type: 'Age' as const, maxAge: 30 * 86400 } },
    };
    const request: CloudflareRequester = async (req) => {
      seen.push(req);
      if (req.method === 'GET') return { rules: [unrelated] };
      return {};
    };

    await configureBucketLifecycle('cf-token', 'acct_1', 'agents-share', { request });

    expect(seen).toEqual([
      {
        apiToken: 'cf-token',
        method: 'GET',
        pathname: '/accounts/acct_1/r2/buckets/agents-share/lifecycle',
      },
      {
        apiToken: 'cf-token',
        method: 'PUT',
        pathname: '/accounts/acct_1/r2/buckets/agents-share/lifecycle',
        body: { rules: [unrelated, buildShareLifecycleRule()] },
      },
    ]);
  });

  it('maps a custom domain through Workers Custom Domains', async () => {
    const seen: CloudflareRequest[] = [];
    await addCustomDomain('cf-token', 'acct_1', 'worker-one', 'zone_1', 'share.example.com', {
      request: async (req) => {
        seen.push(req);
        return {};
      },
    });

    expect(seen).toEqual([
      {
        apiToken: 'cf-token',
        method: 'PUT',
        pathname: '/accounts/acct_1/workers/domains',
        body: {
          zone_id: 'zone_1',
          hostname: 'share.example.com',
          service: 'worker-one',
          environment: 'production',
        },
      },
    ]);
  });
});

describe('hashWorkerScript', () => {
  it('is deterministic and changes when the script changes', () => {
    const a = hashWorkerScript('export default { fetch() {} }');
    const b = hashWorkerScript('export default { fetch() {} }');
    const c = hashWorkerScript('export default { fetch() { /* changed */ } }');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('updateWorker', () => {
  const script = 'export default { fetch() { return new Response("ok"); } }';

  it('reuses the caller-supplied identity — no bucket creation, same account/worker/bucket', async () => {
    const seen: CloudflareRequest[] = [];
    await updateWorker(
      'cf-token',
      'acct_existing',
      'worker-existing',
      'bucket-existing',
      script,
      'existing-write-token',
      undefined,
      { request: async (req) => { seen.push(req); return {}; } },
    );

    // Only the two calls updateWorker itself makes — never r2/buckets (createBucket),
    // subdomain, or custom-domain endpoints, which would mean it re-provisioned.
    expect(seen.map((r) => r.pathname)).toEqual([
      '/accounts/acct_existing/workers/scripts/worker-existing',
      '/accounts/acct_existing/workers/scripts/worker-existing/secrets',
    ]);
    for (const req of seen) {
      expect(req.apiToken).toBe('cf-token');
      expect(req.pathname).toContain('acct_existing');
      expect(req.pathname).toContain('worker-existing');
    }
  });

  it('does not regenerate the write token — the secret request carries the exact caller-supplied value', async () => {
    const seen: CloudflareRequest[] = [];
    await updateWorker('cf-token', 'acct_1', 'worker-one', 'bucket-one', script, 'the-existing-token-value', undefined, {
      request: async (req) => { seen.push(req); return {}; },
    });

    const secretReq = seen.find((r) => r.pathname.endsWith('/secrets'));
    expect(secretReq?.body).toEqual({ name: 'WRITE_TOKEN', text: 'the-existing-token-value', type: 'secret_text' });
  });

  it('re-applies the secret immediately after the script upload — the preservation mechanism, since Cloudflare\'s script-upload endpoint replaces bindings/secrets wholesale', async () => {
    const seen: CloudflareRequest[] = [];
    await updateWorker('cf-token', 'acct_1', 'worker-one', 'bucket-one', script, 'tok', undefined, {
      request: async (req) => { seen.push(req); return {}; },
    });

    expect(seen).toHaveLength(2);
    expect(seen[0].pathname).toBe('/accounts/acct_1/workers/scripts/worker-one');
    expect(seen[0].method).toBe('PUT');
    expect(seen[1].pathname).toBe('/accounts/acct_1/workers/scripts/worker-one/secrets');
    expect(seen[1].method).toBe('PUT');
    expect(seen[1].body).toEqual({ name: 'WRITE_TOKEN', text: 'tok', type: 'secret_text' });
  });

  it('is idempotent — makes no request and reports skipped when the hash already matches', async () => {
    const seen: CloudflareRequest[] = [];
    const currentHash = hashWorkerScript(script);

    const result = await updateWorker('cf-token', 'acct_1', 'worker-one', 'bucket-one', script, 'tok', currentHash, {
      request: async (req) => { seen.push(req); return {}; },
    });

    expect(result).toEqual({ templateHash: currentHash, skipped: true });
    expect(seen).toEqual([]);
  });

  it('re-deploys when the hash differs, and reports the new hash', async () => {
    const seen: CloudflareRequest[] = [];
    const result = await updateWorker('cf-token', 'acct_1', 'worker-one', 'bucket-one', script, 'tok', 'stale-hash', {
      request: async (req) => { seen.push(req); return {}; },
    });

    expect(result).toEqual({ templateHash: hashWorkerScript(script), skipped: false });
    expect(seen).toHaveLength(2);
  });

  it('--force re-deploys even when the hash already matches', async () => {
    const seen: CloudflareRequest[] = [];
    const currentHash = hashWorkerScript(script);

    const result = await updateWorker('cf-token', 'acct_1', 'worker-one', 'bucket-one', script, 'tok', currentHash, {
      request: async (req) => { seen.push(req); return {}; },
      force: true,
    });

    expect(result).toEqual({ templateHash: currentHash, skipped: false });
    expect(seen).toHaveLength(2);
  });

  it('a managed re-deploy sets PHOENIX_ID_BASE after WRITE_TOKEN — the script upload would have wiped it (RUSH-3138)', async () => {
    const seen: CloudflareRequest[] = [];
    await updateWorker(
      'cf-token',
      'acct_1',
      'worker-one',
      'bucket-one',
      script,
      'tok',
      undefined,
      {
        phoenixIdBase: 'https://phoenix-id.example.test/',
        request: async (req) => { seen.push(req); return {}; },
      },
    );

    expect(seen.map((r) => r.pathname)).toEqual([
      '/accounts/acct_1/workers/scripts/worker-one',
      '/accounts/acct_1/workers/scripts/worker-one/secrets',
      '/accounts/acct_1/workers/scripts/worker-one/secrets',
    ]);
    expect(seen[1].body).toEqual({ name: 'WRITE_TOKEN', text: 'tok', type: 'secret_text' });
    expect(seen[2].body).toEqual({
      name: 'PHOENIX_ID_BASE',
      text: 'https://phoenix-id.example.test',
      type: 'secret_text',
    });
  });

  it('a second managed deploy re-applies PHOENIX_ID_BASE after the script upload', async () => {
    const seen: CloudflareRequest[] = [];
    await updateWorker('cf-token', 'acct_1', 'worker-one', 'bucket-one', script, 'tok', 'stale-hash', {
      phoenixIdBase: 'https://phoenix-id.example.test',
      request: async (req) => { seen.push(req); return {}; },
    });

    const phoenix = seen.filter((r) => r.pathname.endsWith('/secrets') && (r.body as { name?: string })?.name === 'PHOENIX_ID_BASE');
    expect(phoenix).toHaveLength(1);
    expect(phoenix[0].body).toEqual({
      name: 'PHOENIX_ID_BASE',
      text: 'https://phoenix-id.example.test',
      type: 'secret_text',
    });
  });

  it('a BYO deploy does not require or send PHOENIX_ID_BASE', async () => {
    const seen: CloudflareRequest[] = [];
    await updateWorker('cf-token', 'acct_1', 'worker-one', 'bucket-one', script, 'tok', undefined, {
      request: async (req) => { seen.push(req); return {}; },
    });

    expect(seen).toHaveLength(2);
    expect(seen[1].body).toEqual({ name: 'WRITE_TOKEN', text: 'tok', type: 'secret_text' });
    expect(seen.some((r) => (r.body as { name?: string } | undefined)?.name === 'PHOENIX_ID_BASE')).toBe(false);
  });

  it('a matching-hash managed update still puts PHOENIX_ID_BASE (heals a wiped secret without --force)', async () => {
    const seen: CloudflareRequest[] = [];
    const currentHash = hashWorkerScript(script);
    const result = await updateWorker('cf-token', 'acct_1', 'worker-one', 'bucket-one', script, 'tok', currentHash, {
      phoenixIdBase: 'https://phoenix-id.example.test',
      request: async (req) => { seen.push(req); return {}; },
    });

    expect(result.skipped).toBe(true);
    expect(seen).toEqual([
      {
        apiToken: 'cf-token',
        method: 'PUT',
        pathname: '/accounts/acct_1/workers/scripts/worker-one/secrets',
        body: { name: 'PHOENIX_ID_BASE', text: 'https://phoenix-id.example.test', type: 'secret_text' },
      },
    ]);
  });

  it('empty PHOENIX_ID_BASE on a managed deploy fails loud — not a skipped secret', async () => {
    const seen: CloudflareRequest[] = [];
    await expect(
      updateWorker('cf-token', 'acct_1', 'worker-one', 'bucket-one', script, 'tok', undefined, {
        phoenixIdBase: '   ',
        request: async (req) => { seen.push(req); return {}; },
      }),
    ).rejects.toThrow(/Managed share deploy requires a non-empty PHOENIX_ID_BASE/);
    // Script + WRITE_TOKEN landed; the empty base is rejected before the second secret PUT.
    expect(seen.map((r) => r.pathname)).toEqual([
      '/accounts/acct_1/workers/scripts/worker-one',
      '/accounts/acct_1/workers/scripts/worker-one/secrets',
    ]);
  });

  it('when PHOENIX_ID_BASE re-apply fails after a successful deploy, fails loud with a re-run hint', async () => {
    const seen: CloudflareRequest[] = [];
    await expect(
      updateWorker('cf-token', 'acct_1', 'worker-one', 'bucket-one', script, 'tok', undefined, {
        phoenixIdBase: 'https://phoenix-id.example.test',
        request: async (req) => {
          seen.push(req);
          if (req.pathname.endsWith('/secrets') && (req.body as { name?: string })?.name === 'PHOENIX_ID_BASE') {
            throw new Error('Cloudflare API 429: rate limited');
          }
          return {};
        },
      }),
    ).rejects.toThrow(/Worker deployed but PHOENIX_ID_BASE failed to re-apply — Phoenix-bearer publishes will 401/);
    expect(seen.map((r) => r.pathname)).toEqual([
      '/accounts/acct_1/workers/scripts/worker-one',
      '/accounts/acct_1/workers/scripts/worker-one/secrets',
      '/accounts/acct_1/workers/scripts/worker-one/secrets',
    ]);
  });

  it('applies both collaboration secrets after the script upload when configured (PHNX-3835)', async () => {
    const seen: CloudflareRequest[] = [];
    await updateWorker('cf-token', 'acct_1', 'worker-one', 'bucket-one', script, 'tok', 'stale-hash', {
      collabBase: 'https://prix.example.test',
      collabServiceToken: 'svc-secret',
      request: async (req) => { seen.push(req); return {}; },
    });

    const secretNames = seen
      .filter((r) => r.pathname.endsWith('/secrets'))
      .map((r) => (r.body as { name?: string }).name);
    expect(secretNames).toEqual(['WRITE_TOKEN', 'PRIX_ARTIFACT_COLLAB_BASE', 'ARTIFACT_COLLAB_SERVICE_TOKEN']);
    const base = seen.find((r) => (r.body as { name?: string })?.name === 'PRIX_ARTIFACT_COLLAB_BASE');
    const token = seen.find((r) => (r.body as { name?: string })?.name === 'ARTIFACT_COLLAB_SERVICE_TOKEN');
    expect(base?.body).toEqual({ name: 'PRIX_ARTIFACT_COLLAB_BASE', text: 'https://prix.example.test', type: 'secret_text' });
    expect(token?.body).toEqual({ name: 'ARTIFACT_COLLAB_SERVICE_TOKEN', text: 'svc-secret', type: 'secret_text' });
  });

  it('leaves collaboration dormant — a deploy with neither collab value never touches those secrets', async () => {
    const seen: CloudflareRequest[] = [];
    await updateWorker('cf-token', 'acct_1', 'worker-one', 'bucket-one', script, 'tok', 'stale-hash', {
      request: async (req) => { seen.push(req); return {}; },
    });
    const names = seen.map((r) => (r.body as { name?: string } | undefined)?.name);
    expect(names).not.toContain('PRIX_ARTIFACT_COLLAB_BASE');
    expect(names).not.toContain('ARTIFACT_COLLAB_SERVICE_TOKEN');
  });

  it('a half-configured collaboration deploy (one value without the other) fails loud', async () => {
    const seen: CloudflareRequest[] = [];
    await expect(
      updateWorker('cf-token', 'acct_1', 'worker-one', 'bucket-one', script, 'tok', 'stale-hash', {
        collabBase: 'https://prix.example.test',
        request: async (req) => { seen.push(req); return {}; },
      }),
    ).rejects.toThrow(/Managed collaboration needs BOTH/);
  });

  it('a matching-hash update still re-applies collaboration secrets (heals a wiped secret without --force)', async () => {
    const seen: CloudflareRequest[] = [];
    const currentHash = hashWorkerScript(script);
    const result = await updateWorker('cf-token', 'acct_1', 'worker-one', 'bucket-one', script, 'tok', currentHash, {
      collabBase: 'https://prix.example.test',
      collabServiceToken: 'svc-secret',
      request: async (req) => { seen.push(req); return {}; },
    });
    expect(result.skipped).toBe(true);
    const names = seen.map((r) => (r.body as { name?: string }).name);
    expect(names).toEqual(['PRIX_ARTIFACT_COLLAB_BASE', 'ARTIFACT_COLLAB_SERVICE_TOKEN']);
  });

  it('when the secret re-apply fails after a successful deploy, fails loud with a re-run hint (RUSH-2453)', async () => {
    // Script upload succeeds; Secrets API then throws (network blip, expired API
    // token, rate limit). The live Worker now has no WRITE_TOKEN, so every
    // publish/delete 401s until a re-run of `agents artifacts share update` completes both
    // steps. The error must say that — not just the raw Cloudflare body.
    const seen: CloudflareRequest[] = [];
    await expect(
      updateWorker('cf-token', 'acct_1', 'worker-one', 'bucket-one', script, 'tok', undefined, {
        request: async (req) => {
          seen.push(req);
          if (req.pathname.endsWith('/secrets')) {
            throw new Error('Cloudflare API 429: rate limited');
          }
          return {};
        },
      }),
    ).rejects.toThrow(
      /Worker deployed but the write token failed to re-apply — re-run `agents artifacts share update`/,
    );
    // Both calls still ran: the deploy landed, then the secret attempt failed.
    expect(seen.map((r) => r.pathname)).toEqual([
      '/accounts/acct_1/workers/scripts/worker-one',
      '/accounts/acct_1/workers/scripts/worker-one/secrets',
    ]);
  });
});
