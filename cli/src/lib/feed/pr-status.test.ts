import { describe, expect, it } from 'vitest';
import { checksVerdict, withPullRequestStatus, type PullRequestStatus } from './pr-status.js';

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
