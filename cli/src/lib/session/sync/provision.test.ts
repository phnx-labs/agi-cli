import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderSessionsWorkerScript } from './worker-template.js';
import { provisionSessions } from './provision.js';

afterEach(() => vi.unstubAllGlobals());

describe('provisionSessions', () => {
  it('shapes the complete isolated Cloudflare deployment and provisions NO static token', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      const result = url.endsWith('/workers/subdomain')
        ? { subdomain: 'account-subdomain' }
        : url.includes('/zones?')
          ? [{ id: 'zone_1' }]
          : {};
      return new Response(JSON.stringify({ success: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(provisionSessions({
      apiToken: 'cf-token',
      accountId: 'acct_1',
      workerName: 'agents-sessions',
      bucketName: 'agents-sessions',
      phoenixIdBase: 'https://identity.example.test/',
    })).resolves.toEqual({ baseUrl: 'https://sessions.agents-cli.sh' });

    const path = ({ url, init }: { url: string; init: RequestInit }) =>
      `${init.method} ${new URL(url).pathname}`;

    // The Worker is Phoenix-only (PHNX-3726): exactly ONE secret PUT, and it is
    // PHOENIX_ID_BASE — never a WRITE_TOKEN static-token principal.
    expect(requests.map(path)).toEqual([
      'POST /client/v4/accounts/acct_1/r2/buckets',
      'PUT /client/v4/accounts/acct_1/workers/scripts/agents-sessions',
      'PUT /client/v4/accounts/acct_1/workers/scripts/agents-sessions/secrets',
      'POST /client/v4/accounts/acct_1/workers/scripts/agents-sessions/subdomain',
      'GET /client/v4/accounts/acct_1/workers/subdomain',
      'GET /client/v4/zones',
      'PUT /client/v4/accounts/acct_1/workers/domains',
    ]);

    const secretPuts = requests
      .filter(r => r.url.endsWith('/secrets'))
      .map(r => JSON.parse(r.init.body as string));
    expect(secretPuts).toHaveLength(1);
    expect(secretPuts[0]).toEqual({
      name: 'PHOENIX_ID_BASE',
      text: 'https://identity.example.test',
      type: 'secret_text',
    });
    expect(secretPuts.some(s => s.name === 'WRITE_TOKEN')).toBe(false);

    // The deployed script is the canonical Worker template, byte-for-byte.
    const form = requests[1]?.init.body as FormData;
    expect(await (form?.get('worker.js') as Blob).text()).toBe(renderSessionsWorkerScript());
  });

  it('keeps the workers.dev endpoint when the custom-domain zone is not visible', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const result = url.endsWith('/workers/subdomain') ? { subdomain: 'account-subdomain' } : [];
      return new Response(JSON.stringify({ success: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(provisionSessions({
      apiToken: 'cf-token',
      accountId: 'acct_1',
      workerName: 'agents-sessions',
      bucketName: 'agents-sessions',
      phoenixIdBase: 'https://identity.example.test',
    })).resolves.toEqual({
      baseUrl: 'https://agents-sessions.account-subdomain.workers.dev',
    });
  });
});
