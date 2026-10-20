import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRushApi, type RushApi } from './testdata/rush-api.js';
import { useFreshSecretsHome } from '../../../tests/secrets-standalone.js';
import { keychainRef, secretsKeychainItem, writeBundleWithItemsSync } from '../secrets-client.js';
import type { SecretsBundle } from '../secrets-types.js';
import type { CloudEvent } from './types.js';

let api: RushApi;
let rush: typeof import('./rush.js');
let store: typeof import('./store.js');
const saved = { key: process.env.RUSH_API_KEY, org: process.env.RUSH_ORG };

beforeAll(async () => {
  api = await startRushApi();
  vi.resetModules();
  process.env.RUSH_PROXY_BASE = api.url;
  rush = await import('./rush.js');
  store = await import('./store.js');
});

afterAll(async () => {
  store.closeStore();
  await api.close();
});

function restoreEnv(): void {
  if (saved.key === undefined) delete process.env.RUSH_API_KEY;
  else process.env.RUSH_API_KEY = saved.key;
  if (saved.org === undefined) delete process.env.RUSH_ORG;
  else process.env.RUSH_ORG = saved.org;
}

describe('buildSessionCreateBody', () => {
  it('sends the developer API fields only, with the repo and branch as one resources URL', () => {
    expect(rush.buildSessionCreateBody({
      prompt: 'fix it', agent: 'codex', repo: 'acme/web', branch: 'release/1.2', model: 'gpt-5.5',
      skills: ['https://github.com/anthropics/skills/tree/main/skills/frontend-design'],
    })).toEqual({
      agent: 'codex',
      input: 'fix it',
      model: 'gpt-5.5',
      skills: ['https://github.com/anthropics/skills/tree/main/skills/frontend-design'],
      resources: [{ url: 'https://github.com/acme/web/tree/release/1.2' }],
    });
  });

  it('starts a run with no repository, and images become input blocks', () => {
    expect(rush.buildSessionCreateBody({ prompt: 'look', images: [{ data: 'AAAA', mimeType: 'image/png' }] })).toEqual({
      agent: 'claude',
      input: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    });
  });

  it('refuses what the API cannot carry instead of dropping it', () => {
    expect(() => rush.buildSessionCreateBody({ prompt: 'x', repos: ['a/b', 'a/c'] })).toThrow('one repository per session');
    expect(() => rush.buildSessionCreateBody({ prompt: 'x', providerOptions: { mode: 'plan' } })).toThrow('drop --mode');
    expect(() => rush.buildSessionCreateBody({ prompt: 'x', repo: 'not-a-repo' })).toThrow('Use owner/repo');
    expect(() => rush.buildSessionCreateBody({ prompt: 'x', branch: 'main' })).toThrow('--branch needs --repo');
    expect(rush.buildSessionCreateBody({ prompt: 'x', repo: 'a/b', branch: 'fix/#12' }).resources).toEqual([{ url: 'https://github.com/a/b/tree/fix/%2312' }]);
  });
});

describe('RushCloudProvider against the developer API', () => {
  beforeEach(() => {
    api.requests.length = 0;
    process.env.RUSH_API_KEY = api.apiKey;
    process.env.RUSH_ORG = api.org;
  });
  afterEach(restoreEnv);

  it('starts, reads, lists, streams, follows up, cancels and reads the transcript of one session', async () => {
    const provider = new rush.RushCloudProvider();
    expect(provider.capabilities()).toMatchObject({ available: true, multiRepo: false });

    const task = await provider.dispatch({ prompt: 'reply with the word ok', agent: 'claude' });
    expect(task).toMatchObject({ provider: 'rush', status: 'allocating', agent: 'claude', prompt: 'reply with the word ok' });
    expect(api.requests[0]).toEqual({
      method: 'POST', path: `/o/${api.org}/sessions`, bearer: api.apiKey,
      body: { agent: 'claude', input: 'reply with the word ok' },
    });
    store.insertTask(task);

    expect(await provider.status(task.id)).toMatchObject({
      id: task.id, status: 'completed', summary: 'ok', prompt: 'reply with the word ok', updatedAt: '2026-10-19T00:01:00.000Z',
    });
    expect((await provider.list({ status: 'completed' })).map((t) => t.id)).toContain(task.id);
    expect(await provider.list({ status: 'running' })).toEqual([]);

    const events: CloudEvent[] = [];
    for await (const e of provider.stream(task.id)) events.push(e);
    expect(events).toMatchObject([
      { type: 'status', status: 'running' },
      { type: 'text', content: 'ok' },
      { type: 'done', status: 'completed', summary: 'ok' },
    ]);

    await provider.message(task.id, 'and again');
    expect(api.requests.at(-1)).toMatchObject({ method: 'POST', path: `/o/${api.org}/sessions/${task.id}/messages`, body: { input: 'and again' } });

    await expect(provider.cancel(task.id)).rejects.toThrow('Rush Cloud cancel failed (409) RUN_STATE_CONFLICT: Cannot cancel: already completed.');

    const transcript = await provider.transcript({ id: task.id, createdAt: task.createdAt }, 'claude');
    expect(transcript[1]).toEqual({
      type: 'tool_use', tool: 'Bash', args: { command: 'echo ok' }, callId: 'c1', agent: 'claude', timestamp: task.createdAt,
    });
    expect(transcript.at(-1)).toMatchObject({ type: 'message', role: 'assistant', content: 'ok' });
  });

  it('names the key when the API rejects it', async () => {
    process.env.RUSH_API_KEY = 'rk_live_revoked';
    await expect(new rush.RushCloudProvider().status('x')).rejects.toThrow(
      'Rush Cloud status failed (401) AUTH_FAILED: Authentication required. Check RUSH_API_KEY: it may be revoked or expired.',
    );
  });

  it('fails loud with the setup steps when no key or org is configured', async () => {
    delete process.env.RUSH_API_KEY;
    delete process.env.RUSH_ORG;
    const provider = new rush.RushCloudProvider();
    expect(provider.capabilities().available).toBe(false);
    await expect(provider.list()).rejects.toThrow('Rush Cloud needs RUSH_API_KEY and RUSH_ORG (the environment has none)');
    expect(api.requests).toEqual([]);
  });
});

describe('RushCloudProvider with a secrets bundle', () => {
  useFreshSecretsHome();
  beforeEach(() => {
    delete process.env.RUSH_API_KEY;
    delete process.env.RUSH_ORG;
  });
  afterEach(restoreEnv);

  function writeRushBundle(values: Record<string, string>): void {
    const bundle: SecretsBundle = { name: 'getrush.ai', backend: 'file', policy: 'never', vars: {} };
    const items = new Map<string, string>();
    for (const [key, value] of Object.entries(values)) {
      items.set(secretsKeychainItem('getrush.ai', key), value);
      bundle.vars[key] = keychainRef(key);
    }
    writeBundleWithItemsSync(bundle, items);
  }

  it('reads RUSH_API_KEY and RUSH_ORG from cloud.providers.rush.secretsBundle', async () => {
    writeRushBundle({ RUSH_API_KEY: api.apiKey, RUSH_ORG: api.org });
    await new rush.RushCloudProvider({ secretsBundle: 'getrush.ai' }).list();
    expect(api.requests.at(-1)).toMatchObject({ path: `/o/${api.org}/sessions?limit=100`, bearer: api.apiKey });
  });

  it('says which key the bundle is missing', async () => {
    writeRushBundle({ RUSH_API_KEY: api.apiKey });
    await expect(new rush.RushCloudProvider({ secretsBundle: 'getrush.ai' }).list())
      .rejects.toThrow("Rush Cloud needs RUSH_ORG (bundle 'getrush.ai' has none)");
  });
});
