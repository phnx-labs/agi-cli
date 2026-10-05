
import { describe, expect, it } from 'vitest';
import {
  formatMergeableRef,
  hasApproveVerdict,
  isCiGreen,
  selectMergeablePrs,
  type MergeablePrInput,
  type StatusCheck,
} from './pr-verdict.js';

const GREEN: StatusCheck[] = [
  { conclusion: 'SUCCESS', status: 'COMPLETED' },
  { conclusion: 'SKIPPED', status: 'COMPLETED' },
  { conclusion: 'NEUTRAL', status: 'COMPLETED' },
];

const PENDING: StatusCheck[] = [
  { conclusion: '', status: 'IN_PROGRESS' },
  { conclusion: 'SUCCESS', status: 'COMPLETED' },
];

const RED: StatusCheck[] = [
  { conclusion: 'FAILURE', status: 'COMPLETED' },
];

const APPROVE_COMMENT_2847 =
  '**Non-author review verdict: APPROVE**\n\nIndependent subagent review (checked out the branch, ran `git diff origin/main...HEAD`).';

const APPROVE_COMMENT_2802 =
  'APPROVE\n\nNon-author review (subagent-based, this repo\'s automated `prix/code-reviewer` is paused per #1767).';

function pr(over: Partial<MergeablePrInput> & Pick<MergeablePrInput, 'number'>): MergeablePrInput {
  return {
    repo: 'phnx-labs/agi-cli',
    statusCheckRollup: GREEN,
    reviewDecision: '',
    reviews: [],
    comments: [],
    ...over,
  };
}

describe('hasApproveVerdict', () => {
  it('accepts a GitHub APPROVED review with no comments', () => {
    expect(hasApproveVerdict([{ state: 'APPROVED' }], [])).toBe(true);
  });

  it('accepts a live APPROVE verdict comment when reviewDecision is empty (PR #2847)', () => {
    expect(hasApproveVerdict([], [{ body: APPROVE_COMMENT_2847 }])).toBe(true);
  });

  it('accepts a bare APPROVE line (PR #2802)', () => {
    expect(hasApproveVerdict([], [{ body: APPROVE_COMMENT_2802 }])).toBe(true);
  });

  it('rejects an empty reviews+comments pair (PR #2849)', () => {
    expect(hasApproveVerdict([], [])).toBe(false);
  });

  it('rejects a carried-from citation (merge-guard #2736 laundering)', () => {
    expect(hasApproveVerdict([], [{ body: 'Non-author APPROVE carried from #2731.' }])).toBe(false);
    expect(hasApproveVerdict([], [{ body: 'Non-author APPROVE on #2731 covers this.' }])).toBe(false);
  });

  it('rejects CHANGES_REQUESTED / a comment that never says APPROVE', () => {
    expect(hasApproveVerdict([{ state: 'CHANGES_REQUESTED' }], [{ body: 'looks close' }])).toBe(false);
  });
});

describe('isCiGreen', () => {
  it('is true for SUCCESS/NEUTRAL/SKIPPED and for an empty rollup', () => {
    expect(isCiGreen(GREEN)).toBe(true);
    expect(isCiGreen([])).toBe(true);
    expect(isCiGreen(null)).toBe(true);
  });

  it('is false when any check is pending or failed', () => {
    expect(isCiGreen(PENDING)).toBe(false);
    expect(isCiGreen(RED)).toBe(false);
  });
});

describe('selectMergeablePrs', () => {
  it('selects an approved+green PR and rejects an unapproved one', () => {
    const approved = pr({
      number: 2847,
      comments: [{ body: APPROVE_COMMENT_2847 }],
    });
    const unapproved = pr({ number: 2849, comments: [] });
    const selected = selectMergeablePrs([approved, unapproved]);
    expect(selected.map((p) => p.number)).toEqual([2847]);
  });

  it('selects a PR whose reviewDecision is APPROVED without reading comments', () => {
    const selected = selectMergeablePrs([
      pr({ number: 1, reviewDecision: 'APPROVED', comments: [] }),
    ]);
    expect(selected.map((p) => p.number)).toEqual([1]);
  });

  it('rejects an approved PR whose CI is still pending or red', () => {
    expect(selectMergeablePrs([
      pr({ number: 2, reviewDecision: 'APPROVED', statusCheckRollup: PENDING }),
      pr({ number: 3, reviewDecision: 'APPROVED', statusCheckRollup: RED }),
    ])).toEqual([]);
  });

  it('rejects a green PR whose only APPROVE comment is a carried-from citation', () => {
    expect(selectMergeablePrs([
      pr({ number: 4, comments: [{ body: 'APPROVE carried from #99' }] }),
    ])).toEqual([]);
  });
});

describe('formatMergeableRef', () => {
  it('prints owner/repo#n so the merge action does not need a git cwd', () => {
    expect(formatMergeableRef({ repo: 'phnx-labs/agi-cli', number: 2847 }))
      .toBe('phnx-labs/agi-cli#2847');
  });
});
