
import { describe, it, expect } from 'vitest';

import { activeSessionProjectKey } from './sessions.js';
import type { ActiveSession } from '../lib/session/active.js';

function s(overrides: Partial<ActiveSession>): ActiveSession {
  return { context: 'terminal', kind: 'claude', status: 'running', ...overrides };
}

describe('activeSessionProjectKey', () => {
  it('a normal repo session groups under its repo basename', () => {
    expect(activeSessionProjectKey(s({ cwd: '/home/me/repos/agents-cli' }))).toBe('agents-cli');
  });

  it('routes a cloud session with no local cwd to the explicit "cloud" bucket', () => {
    const key = activeSessionProjectKey(s({ context: 'cloud', kind: 'codex', cwd: undefined }));
    expect(key).toBe('cloud');
    expect(key).not.toBe('codex');
  });

  it('routes any other cwd-less row to the single "other" bucket, not its harness', () => {
    const key = activeSessionProjectKey(s({ context: 'headless', kind: 'codex', cwd: undefined }));
    expect(key).toBe('other');
    expect(key).not.toBe('codex');
  });

  it('is worktree-agnostic: a cwd inside a worktree still yields a repo-shaped key', () => {
    expect(activeSessionProjectKey(s({ cwd: '/home/me/repos/agents-cli/.agents/worktrees/rush-2688' })))
      .toBe('rush-2688');
  });
});
