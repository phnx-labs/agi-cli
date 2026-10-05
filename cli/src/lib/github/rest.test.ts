/** Tests for the REST read core behind the `gh` overload, with runner payloads shaped like real
 * `gh api --jq` NDJSON. Exercises the real union/dedupe/mapping and head-SHA anchor; a live
 * end-to-end test against a real PR is gated on AGENTS_TEST_GH. */

import { describe, expect, it } from 'vitest';
import { isCiGreen } from './pr-verdict.js';
import type { GhExec } from './pr-mergeable.js';
import {
  isRateLimitError,
  pendingCheckSuites,
  prHead,
  rollupForSha,
} from './rest.js';

/** A gh that routes by endpoint substring and returns recorded REST payloads. */
function ghRoutes(routes: {
  head?: string;
  checkRuns?: string;
  status?: string;
  checkSuites?: string;
}): GhExec {
  return async (args: string[]) => {
    const key = args.join(' ');
    if (key.includes('/pulls/') && key.includes('.head.sha')) return routes.head ?? '';
    if (key.includes('/check-runs')) return routes.checkRuns ?? '';
    if (key.includes('/check-suites')) return routes.checkSuites ?? '';
    if (key.includes('/status')) return routes.status ?? '';
    throw new Error(`unexpected gh ${key}`);
  };
}

describe('prHead', () => {
  it('resolves the live head SHA from pulls/{n}', async () => {
    const gh = ghRoutes({ head: '381815ff84a5df7ae79d935c805e4ef2bc2db284\n' });
    expect(await prHead('phnx-labs/agi-cli', 3287, gh)).toEqual({
      number: 3287,
      sha: '381815ff84a5df7ae79d935c805e4ef2bc2db284',
    });
  });

  it('throws rather than returning a wrong empty when the PR has no head', async () => {
    const gh = ghRoutes({ head: '\n' });
    await expect(prHead('phnx-labs/agi-cli', 999999, gh)).rejects.toThrow(/no head SHA/);
  });
});

describe('rollupForSha', () => {
  it('unions check-runs and commit status into one rollup', async () => {
    const gh = ghRoutes({
      checkRuns: [
        '{"name":"test","status":"COMPLETED","conclusion":"SUCCESS","link":"https://x/1"}',
        '{"name":"windows","status":"COMPLETED","conclusion":"SKIPPED","link":""}',
      ].join('\n'),
      status: '{"name":"ci/external","state":"SUCCESS","link":"https://ext/1"}',
    });
    const rollup = await rollupForSha('phnx-labs/agi-cli', 'abc', gh);
    expect(rollup).toHaveLength(3);
    expect(rollup.find((c) => c.name === 'test')).toMatchObject({
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
    });
    expect(rollup.find((c) => c.name === 'ci/external')).toMatchObject({ state: 'SUCCESS' });
    // Head-exact, terminal, all success/skipped -> green (reuses isCiGreen).
    expect(isCiGreen(rollup)).toBe(true);
  });

  it('a check-run overrides a legacy status of the same context name', async () => {
    const gh = ghRoutes({
      checkRuns: '{"name":"build","status":"COMPLETED","conclusion":"SUCCESS","link":""}',
      status: '{"name":"build","state":"FAILURE","link":""}',
    });
    const rollup = await rollupForSha('o/r', 'abc', gh);
    expect(rollup).toHaveLength(1);
    expect(rollup[0]).toMatchObject({ name: 'build', conclusion: 'SUCCESS' });
    expect(isCiGreen(rollup)).toBe(true);
  });

  it('an in-progress check (null conclusion) is not green — the watch keeps polling', async () => {
    const gh = ghRoutes({
      checkRuns: '{"name":"test","status":"IN_PROGRESS","conclusion":"","link":""}',
      status: '',
    });
    const rollup = await rollupForSha('o/r', 'abc', gh);
    expect(rollup[0]).toMatchObject({ name: 'test', status: 'IN_PROGRESS' });
    expect(isCiGreen(rollup)).toBe(false);
  });

  it('a failing check is not green', async () => {
    const gh = ghRoutes({
      checkRuns: '{"name":"test","status":"COMPLETED","conclusion":"FAILURE","link":""}',
      status: '',
    });
    expect(isCiGreen(await rollupForSha('o/r', 'abc', gh))).toBe(false);
  });
});

describe('pendingCheckSuites', () => {
  it('counts queued/in_progress suites so an empty rollup is not read as green', async () => {
    const gh = ghRoutes({ checkSuites: '2\n' });
    expect(await pendingCheckSuites('o/r', 'abc', gh)).toBe(2);
  });

  it('zero pending suites', async () => {
    const gh = ghRoutes({ checkSuites: '0\n' });
    expect(await pendingCheckSuites('o/r', 'abc', gh)).toBe(0);
  });
});

describe('isRateLimitError', () => {
  it('matches the exact GraphQL primary + secondary signals', () => {
    expect(isRateLimitError('GraphQL: API rate limit already exceeded for user ID 13007401.')).toBe(true);
    expect(isRateLimitError('GraphQL: API rate limit exceeded')).toBe(true);
    expect(isRateLimitError('You have exceeded a secondary rate limit and have been temporarily blocked')).toBe(true);
  });

  it('does NOT match the bare noun or an ordinary CI failure', () => {
    expect(isRateLimitError('some file mentions rate limit in prose')).toBe(false);
    expect(isRateLimitError('checks failed: test')).toBe(false);
    expect(isRateLimitError('')).toBe(false);
  });
});
