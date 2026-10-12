import { describe, expect, it } from 'vitest';
import { planLayouts } from './policy.js';
import { specsForRequest, buildRequests, openSurface, ackFailure } from './engine.js';
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

describe('specsForRequest', () => {
  const base: LaunchRequest = { backend: 'iterm', layout: 'tab', cwd: '/d', command: CMD };
  it('tab → buildTab, split-right → split vertically', () => {
    expect(specsForRequest({ ...base, layout: 'tab' })[0].argv.join(' ')).toContain('create tab with default profile');
    expect(specsForRequest({ ...base, layout: 'split-right' })[0].argv.join(' ')).toContain('split vertically');
    expect(specsForRequest({ ...base, layout: 'split-down' })[0].argv.join(' ')).toContain('split horizontally');
  });
  it('tmux request produces a tmux argv', () => {
    expect(specsForRequest({ ...base, backend: 'tmux', layout: 'tab' })[0].argv[0]).toBe('tmux');
  });
  it('unknown backend throws', () => {
    expect(() => specsForRequest({ ...base, backend: 'nope' as any })).toThrow(/unknown backend/);
  });
});

describe('openSurface never throws', () => {
  it('an invalid --device target degrades to a failed result, not a throw', async () => {
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
    expect(s).toBe("osascript -e 'tell app \"iTerm2\"\nactivate'");
  });
  it('escapes embedded single quotes safely', () => {
    expect(remoteCommand({ argv: ["a'b"] })).toBe("'a'\\''b'");
  });
});

describe('ackFailure — a VSCodium tab request that is never confirmed', () => {
  it('names the one-time extension URI prompt as the likely cause (PHNX-4344)', () => {
    const req: LaunchRequest = { backend: 'vscodium-agent', layout: 'tab', cwd: '/d', command: CMD, project: '/d' };
    expect(ackFailure(undefined, req, 15_000)).toBe(
      "VSCodium did not confirm the tab within 15s; if VSCodium is asking \"Allow 'Agents' extension to open this URI?\", approve it and try again",
    );
  });
});
