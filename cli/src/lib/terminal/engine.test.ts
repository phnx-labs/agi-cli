import { describe, expect, it } from 'vitest';
import { planLayouts } from './policy.js';
import { specForRequest, buildRequests, openSurface } from './engine.js';
import { remoteCommand } from './transport.js';
import type { LaunchRequest } from './types.js';

const CMD = ['claude@2.1.187', '--resume', 'cad0e546'];

describe('planLayouts (2-per-tab packing)', () => {
  it('two-per-tab alternates tab, split-right', () => {
    expect(planLayouts(5, 'two-per-tab')).toEqual(['tab', 'split-right', 'tab', 'split-right', 'tab']);
  });
  it('a single session is just a tab', () => {
    expect(planLayouts(1, 'two-per-tab')).toEqual(['tab']);
  });
  it('tabs packing gives every session its own tab', () => {
    expect(planLayouts(3, 'tabs')).toEqual(['tab', 'tab', 'tab']);
  });
  it('zero items → empty', () => {
    expect(planLayouts(0)).toEqual([]);
  });
});

describe('buildRequests', () => {
  it('assigns layouts and carries backend/host/cwd/command', () => {
    const items = [{ cwd: '/a', command: CMD }, { cwd: '/b', command: CMD }, { cwd: '/c', command: CMD }];
    const reqs = buildRequests(items, { backend: 'ghostty', host: 'zion' });
    expect(reqs.map((r) => r.layout)).toEqual(['tab', 'split-right', 'tab']);
    expect(reqs.every((r) => r.backend === 'ghostty' && r.host === 'zion')).toBe(true);
    expect(reqs.map((r) => r.cwd)).toEqual(['/a', '/b', '/c']);
  });
});

describe('specForRequest', () => {
  const base: LaunchRequest = { backend: 'iterm', layout: 'tab', cwd: '/d', command: CMD };
  it('tab → buildTab, split-right → split vertically', () => {
    expect(specForRequest({ ...base, layout: 'tab' }).argv.join(' ')).toContain('create tab with default profile');
    expect(specForRequest({ ...base, layout: 'split-right' }).argv.join(' ')).toContain('split vertically');
    expect(specForRequest({ ...base, layout: 'split-down' }).argv.join(' ')).toContain('split horizontally');
  });
  it('tmux request produces a tmux argv', () => {
    expect(specForRequest({ ...base, backend: 'tmux', layout: 'tab' }).argv[0]).toBe('tmux');
  });
  it('unknown backend throws', () => {
    expect(() => specForRequest({ ...base, backend: 'nope' as any })).toThrow(/unknown backend/);
  });
});

describe('openSurface never throws', () => {
  it('an invalid --device target degrades to a failed result, not a throw', async () => {
    // 'bad;host' is rejected by the SSH transport's target guard (throws
    // synchronously before any ssh spawn); openSurface must catch it.
    const res = await openSurface({
      backend: 'tmux', layout: 'tab', cwd: '/x', command: ['echo', 'hi'], host: 'bad;host',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect(res.request.host).toBe('bad;host');
  });
  it('an unknown backend degrades to a failed result', async () => {
    const res = await openSurface({
      backend: 'nope' as any, layout: 'tab', cwd: '/x', command: ['echo'],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown backend/);
  });
  it('validates a resolved host before probing a home-relative directory', async () => {
    const res = await openSurface({
      backend: 'tmux', layout: 'tab', cwd: '~/repo', command: ['true'], host: 'worker',
    }, { resolveHost: () => 'bad;host' });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

describe('remoteCommand (serialize argv for ssh)', () => {
  it('leaves shell-safe args bare, single-quotes the rest into one string', () => {
    const spec = { argv: ['osascript', '-e', 'tell app "iTerm2"\nactivate'] };
    const s = remoteCommand(spec);
    // osascript and -e are shell-safe (bare); the multi-line applescript is one quoted arg
    expect(s).toBe("osascript -e 'tell app \"iTerm2\"\nactivate'");
  });
  it('escapes embedded single quotes safely', () => {
    expect(remoteCommand({ argv: ["a'b"] })).toBe("'a'\\''b'");
  });
});
