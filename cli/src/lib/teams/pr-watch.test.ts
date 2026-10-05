import { describe, it, expect } from 'vitest';
import {
  decidePrActions,
  checkDedupeKey,
  commentDedupeKey,
  needsHumanKey,
  isFailedCheck,
  buildCiFixPrompt,
  buildReviewFixPrompt,
  parsePrUrl,
  DEFAULT_MAX_WAVES,
  type PrSnapshot,
  type PrCheck,
  type PrReviewComment,
  type PrWatchAction,
} from './pr-watch.js';

const PR = 'https://github.com/phnx-labs/agents-cli/pull/338';

const passingCheck: PrCheck = { name: 'build', state: 'SUCCESS' };
const failedCheck: PrCheck = {
  name: 'test',
  state: 'FAILURE',
  link: 'https://github.com/phnx-labs/agents-cli/actions/runs/2',
  workflow: 'tests.yml',
};
const pendingCheck: PrCheck = { name: 'lint', state: 'PENDING' };

const reviewComment: PrReviewComment = {
  id: 9001,
  body: 'This branch of the switch never returns — add a default.',
  user: 'reviewer',
  path: 'src/lib/teams/pr-watch.ts',
  html_url: 'https://github.com/phnx-labs/agents-cli/pull/338#discussion_r9001',
};

function snapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    prUrl: PR,
    sourceTeammate: 'alice',
    checks: [],
    comments: [],
    ...overrides,
  };
}

describe('isFailedCheck', () => {
  it('treats terminal failure states as failed and success/pending as not', () => {
    expect(isFailedCheck(failedCheck)).toBe(true);
    expect(isFailedCheck({ name: 'x', state: 'error' })).toBe(true);
    expect(isFailedCheck({ name: 'x', state: 'CANCELLED' })).toBe(true);
    expect(isFailedCheck(passingCheck)).toBe(false);
    expect(isFailedCheck(pendingCheck)).toBe(false);
    expect(isFailedCheck({ name: 'x', state: 'SKIPPING' })).toBe(false);
  });
});

describe('decidePrActions — CI failures', () => {
  it('spawns a ci-fix teammate for a NEW failure', () => {
    const actions = decidePrActions(
      snapshot({ checks: [passingCheck, failedCheck, pendingCheck] }),
      new Set()
    );
    expect(actions).toHaveLength(1);
    const a = actions[0] as Extract<PrWatchAction, { kind: 'ci-fix' }>;
    expect(a.kind).toBe('ci-fix');
    expect(a.check.name).toBe('test');
    expect(a.sourceTeammate).toBe('alice');
    expect(a.dedupeKey).toBe(checkDedupeKey(PR, failedCheck));
  });

  it('does NOT spawn for an already-handled failure (dedupe by check id)', () => {
    const handled = new Set([checkDedupeKey(PR, failedCheck)]);
    const actions = decidePrActions(snapshot({ checks: [failedCheck] }), handled);
    expect(actions).toHaveLength(0);
  });

  it('spawns only for the new failure when one failure is already handled', () => {
    const otherFailure: PrCheck = { name: 'typecheck', state: 'FAILURE' };
    const handled = new Set([checkDedupeKey(PR, failedCheck)]);
    const actions = decidePrActions(
      snapshot({ checks: [failedCheck, otherFailure] }),
      handled
    );
    expect(actions).toHaveLength(1);
    const a = actions[0] as Extract<PrWatchAction, { kind: 'ci-fix' }>;
    expect(a.check.name).toBe('typecheck');
  });

  it('spawns nothing when CI is all green', () => {
    const actions = decidePrActions(
      snapshot({ checks: [passingCheck, pendingCheck] }),
      new Set()
    );
    expect(actions).toHaveLength(0);
  });
});

describe('decidePrActions — review comments', () => {
  it('routes a bugfix teammate for a NEW review comment', () => {
    const actions = decidePrActions(snapshot({ comments: [reviewComment] }), new Set());
    expect(actions).toHaveLength(1);
    const a = actions[0] as Extract<PrWatchAction, { kind: 'review-fix' }>;
    expect(a.kind).toBe('review-fix');
    expect(a.comment.id).toBe(9001);
    expect(a.sourceTeammate).toBe('alice');
    expect(a.dedupeKey).toBe(commentDedupeKey(PR, reviewComment));
  });

  it('does NOT re-route an already-handled comment (dedupe by comment id)', () => {
    const handled = new Set([commentDedupeKey(PR, reviewComment)]);
    const actions = decidePrActions(snapshot({ comments: [reviewComment] }), handled);
    expect(actions).toHaveLength(0);
  });
});

describe('decidePrActions — mixed', () => {
  it('emits both a ci-fix and a review-fix in one pass, skipping handled ids', () => {
    const handled = new Set([checkDedupeKey(PR, failedCheck)]);
    const actions = decidePrActions(
      snapshot({ checks: [failedCheck], comments: [reviewComment] }),
      handled
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('review-fix');
  });
});

describe('decidePrActions — dedupe is stable across a CI re-run (issue #338)', () => {
  it('keys the dedupe off the check NAME, not the run URL', () => {
    const firstRun: PrCheck = { ...failedCheck, link: '.../actions/runs/1000' };
    const rerun: PrCheck = { ...failedCheck, link: '.../actions/runs/2000' };
    expect(checkDedupeKey(PR, rerun)).toBe(checkDedupeKey(PR, firstRun));
    expect(checkDedupeKey(PR, rerun)).toBe(`ci:${PR}:test`);
  });

  it('does NOT re-spawn for the same {prUrl, checkName} even though the run URL changed', () => {
    const handled = new Set([checkDedupeKey(PR, failedCheck)]);
    const rerun: PrCheck = { ...failedCheck, link: 'https://github.com/phnx-labs/agents-cli/actions/runs/999999' };
    const actions = decidePrActions(
      snapshot({ checks: [rerun] }),
      handled,
      new Map([[PR, 1]]),
      DEFAULT_MAX_WAVES
    );
    expect(actions).toHaveLength(0);
  });
});

describe('decidePrActions — wave budget caps fix-spawning (issue #338)', () => {
  it('stops spawning and emits needs-human once the per-PR wave budget is spent', () => {
    const maxWaves = 3;
    const handled = new Set<string>();
    const waves = new Map<string, number>();

    const spawnedWaves: number[] = [];
    for (let i = 0; i < maxWaves + 2; i++) {
      const rerun: PrCheck = { ...failedCheck, link: `.../actions/runs/${i}` };
      const actions = decidePrActions(snapshot({ checks: [rerun] }), handled, waves, maxWaves);
      expect(actions).toHaveLength(1);
      const a = actions[0];
      if (a.kind === 'ci-fix') {
        spawnedWaves.push(a.wave);
        handled.add(a.dedupeKey);
        waves.set(PR, (waves.get(PR) ?? 0) + 1);
        handled.delete(a.dedupeKey);
      } else {
        expect(a.kind).toBe('needs-human');
        break;
      }
    }

    expect(spawnedWaves).toEqual([1, 2, 3]);

    const capped = decidePrActions(
      snapshot({ checks: [failedCheck] }),
      handled,
      waves,
      maxWaves
    );
    expect(capped).toHaveLength(1);
    expect(capped[0].kind).toBe('needs-human');
    const human = capped[0] as Extract<PrWatchAction, { kind: 'needs-human' }>;
    expect(human.waves).toBe(maxWaves);
    expect(human.dedupeKey).toBe(needsHumanKey(PR));
    expect(human.subject).toContain('test');
  });

  it('escalates only ONCE per PR — a handled needs-human key stays silent', () => {
    const maxWaves = 2;
    const handled = new Set<string>([needsHumanKey(PR)]);
    const waves = new Map<string, number>([[PR, maxWaves]]);
    const actions = decidePrActions(snapshot({ checks: [failedCheck] }), handled, waves, maxWaves);
    expect(actions).toHaveLength(0);
  });

  it('draws CI and review-comment spawns from the SAME per-PR budget', () => {
    const maxWaves = 1;
    const actions = decidePrActions(
      snapshot({ comments: [reviewComment] }),
      new Set(),
      new Map([[PR, maxWaves]]),
      maxWaves
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('needs-human');
  });

  it('spends one wave per spawn within a single pass, then escalates', () => {
    const maxWaves = 1;
    const otherFailure: PrCheck = { name: 'typecheck', state: 'FAILURE' };
    const actions = decidePrActions(
      snapshot({ checks: [failedCheck, otherFailure] }),
      new Set(),
      new Map(),
      maxWaves
    );
    expect(actions).toHaveLength(2);
    expect(actions[0].kind).toBe('ci-fix');
    expect(actions[1].kind).toBe('needs-human');
  });
});

describe('prompt builders inject the fetched data', () => {
  it('buildCiFixPrompt carries the injected logs and PR into the prompt', () => {
    const action = decidePrActions(
      snapshot({ checks: [failedCheck] }),
      new Set()
    )[0] as Extract<PrWatchAction, { kind: 'ci-fix' }>;
    const prompt = buildCiFixPrompt(action, 'FAIL src/x.test.ts: expected 1 got 2');
    expect(prompt).toContain(PR);
    expect(prompt).toContain('test');
    expect(prompt).toContain('FAIL src/x.test.ts');
    expect(prompt).toContain('SAME PR branch');
  });

  it('buildReviewFixPrompt carries the comment body and path', () => {
    const action = decidePrActions(
      snapshot({ comments: [reviewComment] }),
      new Set()
    )[0] as Extract<PrWatchAction, { kind: 'review-fix' }>;
    const prompt = buildReviewFixPrompt(action);
    expect(prompt).toContain(reviewComment.body);
    expect(prompt).toContain('pr-watch.ts');
    expect(prompt).toContain('@reviewer');
  });
});

describe('parsePrUrl', () => {
  it('parses owner/repo/number', () => {
    expect(parsePrUrl(PR)).toEqual({ owner: 'phnx-labs', repo: 'agents-cli', number: 338 });
  });
  it('returns null on a non-PR url', () => {
    expect(parsePrUrl('https://example.com/foo')).toBeNull();
  });
});
