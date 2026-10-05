/** Tests the pure grouping function behind `agents sessions --active`. renderActiveSessions couples
 * grouping with chalk+console, so groupActiveSessions extracts workspace/window splits, sort
 * orders and cloud/unknown bucket rules for isolated testing. */

import { describe, it, expect } from 'vitest';
import { groupActiveSessions } from '../sessions.js';
import type { ActiveSession } from '../../lib/session/active.js';

function mk(overrides: Partial<ActiveSession>): ActiveSession {
  return {
    context: 'terminal',
    kind: 'claude',
    status: 'running',
    ...overrides,
  };
}

describe('groupActiveSessions — workspace splitting', () => {
  it('groups by cwd', () => {
    const layout = groupActiveSessions([
      mk({ cwd: '/repo/a', sessionId: '1' }),
      mk({ cwd: '/repo/a', sessionId: '2' }),
      mk({ cwd: '/repo/b', sessionId: '3' }),
    ]);
    expect(layout.workspaces).toHaveLength(2);
    expect(layout.workspaces[0].key).toBe('/repo/a');
    expect(layout.workspaces[0].total).toBe(2);
    expect(layout.workspaces[1].key).toBe('/repo/b');
    expect(layout.workspaces[1].total).toBe(1);
  });

  it('routes cloud-context sessions to __cloud__ when cwd is absent', () => {
    const layout = groupActiveSessions([
      mk({ context: 'cloud', cloudProvider: 'rush', sessionId: 'c1' }),
      mk({ context: 'cloud', cloudProvider: 'rush', sessionId: 'c2' }),
    ]);
    expect(layout.workspaces).toHaveLength(1);
    expect(layout.workspaces[0].key).toBe('__cloud__');
    expect(layout.workspaces[0].flat).toHaveLength(2);
  });

  it('routes other context sessions without cwd to __unknown__', () => {
    const layout = groupActiveSessions([
      mk({ context: 'headless', sessionId: 'h1' }),
    ]);
    expect(layout.workspaces[0].key).toBe('__unknown__');
  });

  it('sorts workspaces by session count desc, then key asc', () => {
    const layout = groupActiveSessions([
      mk({ cwd: '/zebra', sessionId: '1' }),
      mk({ cwd: '/apple', sessionId: '2' }),
      mk({ cwd: '/apple', sessionId: '3' }),
      mk({ cwd: '/banana', sessionId: '4' }),
      mk({ cwd: '/banana', sessionId: '5' }),
    ]);
    // /apple and /banana tie at 2 each → alphabetical → /apple, /banana, /zebra
    expect(layout.workspaces.map((w) => w.key)).toEqual(['/apple', '/banana', '/zebra']);
  });
});

describe('groupActiveSessions — window splitting within a workspace', () => {
  it('nests terminals with a windowId under their window; flat for everything else', () => {
    const layout = groupActiveSessions([
      mk({ cwd: '/r', context: 'terminal', windowId: 'win-100', sessionId: 't1', startedAtMs: 100 }),
      mk({ cwd: '/r', context: 'terminal', windowId: 'win-100', sessionId: 't2', startedAtMs: 200 }),
      mk({ cwd: '/r', context: 'terminal', windowId: 'win-200', sessionId: 't3', startedAtMs: 50 }),
      mk({ cwd: '/r', context: 'terminal', sessionId: 'orphan', startedAtMs: 1 }),       // no windowId → flat
      mk({ cwd: '/r', context: 'cloud', sessionId: 'cloud-in-r', startedAtMs: 2 }),       // cloud → flat
    ]);
    const ws = layout.workspaces[0];
    expect(ws.windows).toHaveLength(2);
    // Windows sort by oldest startedAtMs: win-200 (50) before win-100 (100).
    expect(ws.windows[0].windowId).toBe('win-200');
    expect(ws.windows[1].windowId).toBe('win-100');
    expect(ws.flat.map((s) => s.sessionId)).toEqual(['orphan', 'cloud-in-r']);
  });

  it('preserves session order within a window', () => {
    const layout = groupActiveSessions([
      mk({ cwd: '/r', context: 'terminal', windowId: 'w', sessionId: 'a', startedAtMs: 300 }),
      mk({ cwd: '/r', context: 'terminal', windowId: 'w', sessionId: 'b', startedAtMs: 100 }),
      mk({ cwd: '/r', context: 'terminal', windowId: 'w', sessionId: 'c', startedAtMs: 200 }),
    ]);
    expect(layout.workspaces[0].windows[0].sessions.map((s) => s.sessionId))
      .toEqual(['a', 'b', 'c']);
  });

  it('handles sessions with no startedAtMs (sorts them last among windows)', () => {
    const layout = groupActiveSessions([
      mk({ cwd: '/r', context: 'terminal', windowId: 'has-time', sessionId: 't1', startedAtMs: 500 }),
      mk({ cwd: '/r', context: 'terminal', windowId: 'no-time', sessionId: 't2' }),
    ]);
    // has-time (500) sorts before no-time (Infinity).
    expect(layout.workspaces[0].windows[0].windowId).toBe('has-time');
    expect(layout.workspaces[0].windows[1].windowId).toBe('no-time');
  });
});

describe('groupActiveSessions — totals and counts', () => {
  it('total counts include both windowed and flat sessions', () => {
    const layout = groupActiveSessions([
      mk({ cwd: '/r', context: 'terminal', windowId: 'w', sessionId: '1' }),
      mk({ cwd: '/r', context: 'cloud', sessionId: '2' }),
      mk({ cwd: '/r', context: 'headless', sessionId: '3' }),
    ]);
    expect(layout.workspaces[0].total).toBe(3);
    expect(layout.workspaces[0].windows[0].sessions).toHaveLength(1);
    expect(layout.workspaces[0].flat).toHaveLength(2);
  });

  it('returns an empty layout when there are no sessions', () => {
    expect(groupActiveSessions([]).workspaces).toEqual([]);
  });
});
