import { afterEach, describe, expect, it } from 'vitest';
import { cloudDispatchOptions } from './teams.js';
import { shareRuntimeEnv } from '../lib/share-runtime.js';

const originalToken = process.env.SHARE_WRITE_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.SHARE_WRITE_TOKEN;
  else process.env.SHARE_WRITE_TOKEN = originalToken;
});

describe('staged cloud teammate dispatch', () => {
  it('carries the same runtime environment as immediate cloud dispatch', () => {
    process.env.SHARE_WRITE_TOKEN = 'share_test_token';

    const options = cloudDispatchOptions({
      prompt: 'ship it',
      agentType: 'codex',
      cloudRepo: 'phnx-labs/agi-cli',
      cloudBranch: 'agents/test',
      model: null,
      mode: 'edit',
    });

    // A write-capable cloud teammate carries the brief plus the self-merge
    // policy (PHNX-3236 — cloud is the surface with no inherited merge-guard.sh),
    // so the prompt is no longer the bare brief.
    expect(options.prompt).toContain('ship it');
    expect(options.prompt).toContain('do NOT merge your OWN PR');
    expect(options).toMatchObject({
      agent: 'codex',
      repo: 'phnx-labs/agi-cli',
      branch: 'agents/test',
    });
    expect(Object.hasOwn(options, 'env')).toBe(true);
    expect(options.env).toEqual(shareRuntimeEnv());
  });
});
