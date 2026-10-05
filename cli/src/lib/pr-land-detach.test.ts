/** Tests for the headless-exit orphaned-open-PR warning (RUSH-2394): the pure classifier and
 * formatter, plus getBranchOpenPr against a real child process standing in for `gh`; no network. */
import { describe, it, expect } from 'vitest';
import {
  shouldWarnOrphanedOpenPr,
  formatOrphanedOpenPrWarning,
  getBranchOpenPr,
} from './pr-land-detach.js';

describe('orphaned open-PR warn classifier', () => {
  it('warns only for OPEN PRs', () => {
    expect(shouldWarnOrphanedOpenPr(null)).toBe(false);
    expect(shouldWarnOrphanedOpenPr({ number: 1, url: 'u', state: 'MERGED' })).toBe(false);
    expect(shouldWarnOrphanedOpenPr({ number: 1, url: 'u', state: 'CLOSED' })).toBe(false);
    expect(shouldWarnOrphanedOpenPr({ number: 1, url: 'u', state: 'OPEN' })).toBe(true);
    expect(shouldWarnOrphanedOpenPr({ number: 1, url: 'u', state: 'open' })).toBe(true);
  });

  it('names the PR without pointing at the removed `agents pr land` command', () => {
    const text = formatOrphanedOpenPrWarning({
      number: 2334,
      url: 'https://github.com/phnx-labs/agents-cli/pull/2334',
      state: 'OPEN',
    });
    expect(text).toMatch(/RUSH-2394/);
    expect(text).toContain('https://github.com/phnx-labs/agents-cli/pull/2334');
    expect(text).toContain('#2334');
    expect(text).toMatch(/gh pr checks --watch/);
    // The `agents pr` group was removed in RUSH-2472 — the warning must never
    // tell the user to run a command that no longer exists.
    expect(text).not.toMatch(/agents pr land/);
  });
});

describe('getBranchOpenPr', () => {
  it('parses a real `gh pr view --json` payload', async () => {
    const pr = await getBranchOpenPr('/tmp', async () => ({
      stdout: JSON.stringify({
        number: 42,
        url: 'https://github.com/phnx-labs/agents-cli/pull/42',
        state: 'OPEN',
      }),
    }));
    expect(pr).toEqual({
      number: 42,
      url: 'https://github.com/phnx-labs/agents-cli/pull/42',
      state: 'OPEN',
    });
  });

  it('fails open (null) when gh is missing or errors', async () => {
    const pr = await getBranchOpenPr('/tmp', async () => {
      throw new Error('gh: command not found');
    });
    expect(pr).toBeNull();
  });

  it('returns null on a payload missing required fields', async () => {
    const pr = await getBranchOpenPr('/tmp', async () => ({ stdout: '{"number":1}' }));
    expect(pr).toBeNull();
  });
});
