import { describe, expect, it } from 'vitest';
import {
  addCustomDomain,
  createBucket,
  deployWorker,
  enableWorkersDev,
  findZoneId,
  putWorkerSecret,
  type CloudflareRequest,
  type CloudflareRequester,
} from './provision.js';

describe('Cloudflare provisioning request shape', () => {
  it('creates the R2 bucket with account scope and bucket name', async () => {
    const seen: CloudflareRequest[] = [];
    await createBucket('cf-token', 'acct_1', 'agents-traces', {
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
        body: { name: 'agents-traces' },
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
      bindings: [{ type: 'r2_bucket', name: 'BUCKET', bucket_name: 'bucket-one' }],
    });
    expect(await (upload?.form?.get('worker.js') as File).text()).toBe('export default {}');
  });

  it('uploads extra bundle modules beside the JavaScript entrypoint', async () => {
    let upload: CloudflareRequest | undefined;
    const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    await deployWorker(
      'cf-token',
      'acct_1',
      'worker-one',
      { script: 'import "./yoga.wasm"', modules: [{ name: 'yoga.wasm', contentType: 'application/wasm', contents: wasm }] },
      'bucket-one',
      { request: async (req) => { upload = req; return {}; } },
    );

    const part = upload?.form?.get('yoga.wasm') as File;
    expect(part).toBeInstanceOf(File);
    expect(part.type).toBe('application/wasm');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(wasm);
  });

  it('puts an arbitrary secret_text binding', async () => {
    const seen: CloudflareRequest[] = [];
    await putWorkerSecret('cf-token', 'acct_1', 'worker-one', 'WRITE_TOKEN', 'write-token', {
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

  it('enables workers.dev and returns the account subdomain', async () => {
    const seen: CloudflareRequest[] = [];
    const request: CloudflareRequester = async (req) => {
      seen.push(req);
      if (req.method === 'GET') return { subdomain: 'agent-traces' };
      return {};
    };

    await expect(enableWorkersDev('cf-token', 'acct_1', 'worker-one', { request })).resolves.toBe('agent-traces');
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
      if (req.pathname === '/zones?name=getrush.ai') return [{ id: 'zone_1', name: 'getrush.ai' }];
      return [];
    };

    await expect(findZoneId('cf-token', 'traces.getrush.ai', { request })).resolves.toBe('zone_1');
    expect(paths).toEqual(['/zones?name=traces.getrush.ai', '/zones?name=getrush.ai']);
  });

  it('maps a custom domain through Workers Custom Domains', async () => {
    const seen: CloudflareRequest[] = [];
    await addCustomDomain('cf-token', 'acct_1', 'worker-one', 'zone_1', 'traces.example.com', {
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
          hostname: 'traces.example.com',
          service: 'worker-one',
          environment: 'production',
        },
      },
    ]);
  });
});
