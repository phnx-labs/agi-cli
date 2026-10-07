import { beforeEach, describe, expect, it } from 'vitest';
import { checkItemsFrom, checksVerdict, MAX_PR_CHECK_ITEMS, readPullRequestStatus, resetPullRequestStatusCache, withPullRequestStatus, type PullRequestStatus } from './pr-status.js';
import type { ActiveSession } from '../session/active.js';

describe('checksVerdict', () => {
  it('is undefined with no checks', () => {
    expect(checksVerdict(undefined)).toBeUndefined();
    expect(checksVerdict([])).toBeUndefined();
  });
  it('one failed check fails the rollup', () => {
    expect(checksVerdict([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }])).toBe('failing');
  });
  it('an unfinished check is pending', () => {
    expect(checksVerdict([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }])).toBe('pending');
  });
  it('reads legacy Status-API contexts, which carry state instead of conclusion', () => {
    expect(checksVerdict([{ state: 'SUCCESS' }, { state: 'FAILURE' }])).toBe('failing');
    expect(checksVerdict([{ state: 'SUCCESS' }, { state: 'PENDING' }])).toBe('pending');
    expect(checksVerdict([{ state: 'SUCCESS' }, { conclusion: 'STALE' }])).toBe('pending');
    expect(checksVerdict([{ state: 'SUCCESS' }, { conclusion: 'SUCCESS' }])).toBe('passing');
  });
  it('all settled without failure passes', () => {
    expect(checksVerdict([{ conclusion: 'SUCCESS' }, { conclusion: 'NEUTRAL' }, { conclusion: 'SKIPPED', status: 'COMPLETED' }])).toBe('passing');
  });
});

describe('withPullRequestStatus', () => {
  const status: PullRequestStatus = {
    number: 23, url: 'https://github.com/o/r/pull/23', needsHuman: false,
    state: 'MERGED', isDraft: false, reviewDecision: 'APPROVED', mergeable: 'UNKNOWN',
    statusCheckRollup: [{ conclusion: 'SUCCESS' }],
  };
  it('attaches state, review, mergeable and the checks verdict to the row pr', () => {
    const row = withPullRequestStatus({ pr: { url: 'https://github.com/o/r/pull/23', number: 23 } }, status);
    expect(row.pr).toEqual({
      url: 'https://github.com/o/r/pull/23', number: 23,
      state: 'MERGED', isDraft: false, reviewDecision: 'APPROVED', mergeable: 'UNKNOWN', checks: 'passing',
    });
  });
  it('leaves a row without a PR, or without a resolved status, untouched', () => {
    const none = { pr: undefined as undefined };
    expect(withPullRequestStatus(none, status)).toBe(none);
    const raw = { pr: { url: 'https://github.com/o/r/pull/23' } };
    expect(withPullRequestStatus(raw, undefined)).toBe(raw);
  });
});

describe('checkItemsFrom', () => {
  it('projects CheckRuns and legacy StatusContexts with their links', () => {
    expect(checkItemsFrom([
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci/test' },
      { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: '', detailsUrl: 'https://ci/lint' },
      { __typename: 'CheckRun', name: 'e2e', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
      { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'CheckRun', name: 'label', status: 'COMPLETED', conclusion: 'NEUTRAL' },
      { __typename: 'StatusContext', context: 'prix-cloud', state: 'FAILURE', targetUrl: 'https://review/1' },
      { __typename: 'StatusContext', context: 'deploy', state: 'PENDING' },
    ])).toEqual([
      { name: 'test', state: 'passed', url: 'https://ci/test' },
      { name: 'lint', state: 'running', url: 'https://ci/lint' },
      { name: 'e2e', state: 'failed' },
      { name: 'docs', state: 'skipped' },
      { name: 'label', state: 'skipped' },
      { name: 'prix-cloud', state: 'failed', url: 'https://review/1' },
      { name: 'deploy', state: 'running' },
    ]);
  });
  it('keeps the latest run of a re-run check, in its first position', () => {
    expect(checkItemsFrom([
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-07T10:05:00Z' },
      { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-07T10:00:00Z' },
      { name: 'lint', status: 'IN_PROGRESS' },
    ])).toEqual([{ name: 'test', state: 'passed' }, { name: 'lint', state: 'running' }]);
  });
  it('caps the list and is undefined with no named checks', () => {
    const many = Array.from({ length: MAX_PR_CHECK_ITEMS + 5 }, (_, i) => ({ name: `job-${i}`, conclusion: 'SUCCESS' }));
    const items = checkItemsFrom(many)!;
    expect(items).toHaveLength(MAX_PR_CHECK_ITEMS);
    expect(items.at(-1)!.name).toBe(`job-${MAX_PR_CHECK_ITEMS - 1}`);
    const late = [...many, { name: 'late-failure', conclusion: 'FAILURE' }];
    const capped = checkItemsFrom(late)!;
    expect(capped).toHaveLength(MAX_PR_CHECK_ITEMS);
    expect(capped.at(-1)).toEqual({ name: 'late-failure', state: 'failed' });
    expect(checkItemsFrom(undefined)).toBeUndefined();
    expect(checkItemsFrom([{ conclusion: 'SUCCESS' }])).toBeUndefined();
  });
});

describe('readPullRequestStatus -> withPullRequestStatus', () => {
  beforeEach(() => resetPullRequestStatusCache());
  it('fetches the head SHA in the one gh call and projects title, headSha and checkItems onto the row', async () => {
    const calls: string[][] = [];
    const gh = async (args: string[]) => {
      calls.push(args);
      return JSON.stringify({
        number: 7, title: 'feat: thing', headRefOid: 'abc123def', state: 'OPEN', isDraft: false,
        reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci/1' },
          { __typename: 'StatusContext', context: 'prix-cloud', state: 'PENDING', targetUrl: 'https://review/7' },
        ],
      });
    };
    const session = { cwd: '/repo', pr: { url: 'https://github.com/o/r/pull/7', number: 7 } } as ActiveSession;
    const status = await readPullRequestStatus(session, { gh });
    expect(calls).toHaveLength(1);
    expect(calls[0].at(-1)!.split(',')).toEqual(expect.arrayContaining(['title', 'headRefOid', 'statusCheckRollup']));
    const row = withPullRequestStatus({ pr: session.pr }, status);
    expect(row.pr).toEqual({
      url: 'https://github.com/o/r/pull/7', number: 7,
      title: 'feat: thing', headSha: 'abc123def',
      checkItems: [
        { name: 'test', state: 'passed', url: 'https://ci/1' },
        { name: 'prix-cloud', state: 'running', url: 'https://review/7' },
      ],
      state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', checks: 'pending',
    });
  });
});
