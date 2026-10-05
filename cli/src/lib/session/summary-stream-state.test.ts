import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-summ-state-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
delete process.env.AGENTS_SUMMARIZER_ENABLED;
delete process.env.AGENTS_SUMMARIZER_BASEURL;
delete process.env.AGENTS_SUMMARIZER_MODEL;

const { resolveStreamSummaryState } = await import('./session-cache.js');
const { resetSummarizerReadyCacheForTest } = await import('../summarizer/config.js');

describe('resolveStreamSummaryState (PHNX-3939 blocker)', () => {
  beforeEach(() => resetSummarizerReadyCacheForTest());

  it('passes through an already-resolved state', () => {
    expect(resolveStreamSummaryState('ready')).toBe('ready');
    expect(resolveStreamSummaryState('skipped')).toBe('skipped');
    expect(resolveStreamSummaryState('pending')).toBe('pending');
  });

  it('defaults to skipped when the summarizer is not ready (off OR enabled-but-unconfigured)', () => {
    expect(resolveStreamSummaryState(undefined)).toBe('skipped');
  });
});
