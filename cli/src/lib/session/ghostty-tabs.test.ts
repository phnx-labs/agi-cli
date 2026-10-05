import { describe, it, expect } from 'vitest';
import { assignGhosttyTabs, type GhosttySurface } from './ghostty-tabs.js';
import type { ActiveSession } from './active.js';

function sess(p: Partial<ActiveSession>): ActiveSession {
  return { context: 'terminal', kind: 'claude', status: 'running', host: 'ghostty', ...p };
}
function surf(p: Partial<GhosttySurface>): GhosttySurface {
  return { windowIndex: 1, tabIndex: 1, cwd: '/repo', title: '', ...p };
}

describe('assignGhosttyTabs', () => {
  it('assigns the tab when exactly one surface matches the cwd', () => {
    const s = sess({ cwd: '/Users/m/rush' });
    const m = assignGhosttyTabs([s], [
      surf({ tabIndex: 3, cwd: '/Users/m/rush' }),
      surf({ tabIndex: 1, cwd: '/Users/m/agents' }),
    ]);
    expect(m.get(s)).toBe(3);
  });

  it('ignores trailing slashes when matching cwd', () => {
    const s = sess({ cwd: '/Users/m/rush/' });
    const m = assignGhosttyTabs([s], [surf({ tabIndex: 2, cwd: '/Users/m/rush' })]);
    expect(m.get(s)).toBe(2);
  });

  it('only matches ghostty-hosted sessions', () => {
    const s = sess({ cwd: '/repo', host: 'tmux' });
    const m = assignGhosttyTabs([s], [surf({ tabIndex: 4, cwd: '/repo' })]);
    expect(m.has(s)).toBe(false);
  });

  it('leaves a session unassigned when no surface cwd matches', () => {
    const s = sess({ cwd: '/repo/a' });
    const m = assignGhosttyTabs([s], [surf({ tabIndex: 1, cwd: '/repo/b' })]);
    expect(m.has(s)).toBe(false);
  });

  it('breaks a same-cwd tie by title containment, ignoring the leading spinner glyph', () => {
    const s = sess({ cwd: '/repo', label: 'fix auth flow' });
    const m = assignGhosttyTabs([s], [
      surf({ tabIndex: 1, cwd: '/repo', title: '⠐ reduce browser instances' }),
      surf({ tabIndex: 5, cwd: '/repo', title: '✳ fix auth flow on device' }),
    ]);
    expect(m.get(s)).toBe(5);
  });

  it('leaves ambiguous same-cwd sessions unassigned rather than guessing', () => {
    const s = sess({ cwd: '/repo', label: 'authentication refactor', topic: 'authentication refactor' });
    const m = assignGhosttyTabs([s], [
      surf({ tabIndex: 1, cwd: '/repo', title: 'unrelated one thing' }),
      surf({ tabIndex: 2, cwd: '/repo', title: 'unrelated two thing' }),
    ]);
    expect(m.has(s)).toBe(false);
  });

  it('does not assign when the tie-break matches more than one surface', () => {
    const s = sess({ cwd: '/repo', label: 'rush deploy pipeline' });
    const m = assignGhosttyTabs([s], [
      surf({ tabIndex: 1, cwd: '/repo', title: 'deploy the rush deploy pipeline now' }),
      surf({ tabIndex: 2, cwd: '/repo', title: 'rush deploy pipeline rollback' }),
    ]);
    expect(m.has(s)).toBe(false);
  });

  it('ignores hints shorter than 8 chars (avoids spurious short-fragment matches)', () => {
    const s = sess({ cwd: '/repo', label: 'auth' });
    const m = assignGhosttyTabs([s], [
      surf({ tabIndex: 1, cwd: '/repo', title: 'authentication work' }),
      surf({ tabIndex: 2, cwd: '/repo', title: 'something else' }),
    ]);
    expect(m.has(s)).toBe(false);
  });

  it('returns an empty map when there are no surfaces', () => {
    const s = sess({ cwd: '/repo' });
    expect(assignGhosttyTabs([s], []).size).toBe(0);
  });
});
