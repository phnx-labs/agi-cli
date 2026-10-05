import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-summ-cfg-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const {
  resolveSummarizerConfig,
  isSummarizerRunnable,
  isSummarizerReady,
  resetSummarizerReadyCacheForTest,
} = await import('./config.js');

function envOnly(over: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return over as NodeJS.ProcessEnv;
}

describe('resolveSummarizerConfig', () => {
  it('is disabled with no config and no env', () => {
    expect(resolveSummarizerConfig(envOnly({}))).toEqual({ enabled: false, baseUrl: undefined, model: undefined });
  });

  it('reads the three env overrides', () => {
    const cfg = resolveSummarizerConfig(envOnly({
      AGENTS_SUMMARIZER_ENABLED: '1',
      AGENTS_SUMMARIZER_BASEURL: 'http://localhost:11434',
      AGENTS_SUMMARIZER_MODEL: 'qwen2.5:3b',
    }));
    expect(cfg).toEqual({ enabled: true, baseUrl: 'http://localhost:11434', model: 'qwen2.5:3b' });
  });

  it('treats falsey env values as disabled', () => {
    expect(resolveSummarizerConfig(envOnly({ AGENTS_SUMMARIZER_ENABLED: 'off' })).enabled).toBe(false);
    expect(resolveSummarizerConfig(envOnly({ AGENTS_SUMMARIZER_ENABLED: '0' })).enabled).toBe(false);
  });
});

describe('isSummarizerRunnable', () => {
  it('needs enabled AND a base URL AND a model', () => {
    expect(isSummarizerRunnable({ enabled: true, baseUrl: 'http://x', model: 'm' })).toBe(true);
    expect(isSummarizerRunnable({ enabled: false, baseUrl: 'http://x', model: 'm' })).toBe(false);
    expect(isSummarizerRunnable({ enabled: true, baseUrl: 'http://x' })).toBe(false);
    expect(isSummarizerRunnable({ enabled: true, model: 'm' })).toBe(false);
  });
});

describe('isSummarizerReady memo', () => {
  beforeEach(() => resetSummarizerReadyCacheForTest());

  it('defaults false (nothing configured) and is stable within the TTL', () => {
    expect(isSummarizerReady(1000)).toBe(false);
    expect(isSummarizerReady(1500)).toBe(false);
  });

  it('reflects runnable, not just enabled — enabled-but-unconfigured is NOT ready', () => {
    expect(isSummarizerRunnable({ enabled: true })).toBe(false);
  });
});
