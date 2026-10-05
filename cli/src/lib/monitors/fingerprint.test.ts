
import { describe, it, expect } from 'vitest';
import { monitorFingerprint, findDuplicateMonitor } from './fingerprint.js';
import type { MonitorConfig } from './config.js';

type Ident = Pick<MonitorConfig, 'name' | 'source' | 'condition' | 'action'>;

function watcher(over: Partial<Ident> = {}): Ident {
  return {
    name: 'a',
    source: { type: 'poll', command: 'gh pr list -R phnx-labs/agents-cli', interval: '2m' },
    condition: { mode: 'on-change' },
    action: { type: 'notify' },
    ...over,
  } as Ident;
}

describe('monitorFingerprint', () => {
  it('ignores the name — a rename is not a different watcher', () => {
    expect(monitorFingerprint(watcher({ name: 'open-pr-watch' })))
      .toBe(monitorFingerprint(watcher({ name: 'rush-2479-land' })));
  });

  it('ignores YAML key order', () => {
    const a = watcher({ source: { type: 'poll', command: 'x', interval: '2m' } as any });
    const b = watcher({ source: { interval: '2m', command: 'x', type: 'poll' } as any });
    expect(monitorFingerprint(a)).toBe(monitorFingerprint(b));
  });

  it('separates watchers that poll different sources', () => {
    expect(monitorFingerprint(watcher()))
      .not.toBe(monitorFingerprint(watcher({ source: { type: 'poll', command: 'gh pr view 2222', interval: '2m' } as any })));
  });

  it('separates watchers that poll the same source at different intervals', () => {
    expect(monitorFingerprint(watcher()))
      .not.toBe(monitorFingerprint(watcher({ source: { type: 'poll', command: 'gh pr list -R phnx-labs/agents-cli', interval: '5m' } as any })));
  });

  it('separates watchers that fire different actions on the same source', () => {
    expect(monitorFingerprint(watcher()))
      .not.toBe(monitorFingerprint(watcher({ action: { type: 'run', agent: 'claude', prompt: 'merge it' } as any })));
  });

  it('separates run actions that differ only by postcondition (PHNX-2842)', () => {
    const run = { type: 'run' as const, agent: 'claude', prompt: 'merge it' };
    expect(monitorFingerprint(watcher({ action: run as any })))
      .not.toBe(monitorFingerprint(watcher({
        action: { ...run, postcondition: 'gh pr view 1 --json state --jq .state | grep -qx MERGED' } as any,
      })));
  });

  it('separates watchers whose condition differs', () => {
    expect(monitorFingerprint(watcher()))
      .not.toBe(monitorFingerprint(watcher({ condition: { mode: 'match', match: 'fail' } as any })));
  });

  it('treats placement as not part of identity', () => {
    const pinned = { ...watcher(), device: 'zion' } as Ident;
    const unpinned = watcher();
    expect(monitorFingerprint(pinned)).toBe(monitorFingerprint(unpinned));
  });
});

describe('findDuplicateMonitor', () => {
  it('names the existing watcher a new monitor would duplicate', () => {
    const existing = [watcher({ name: 'open-pr-watch' })];
    expect(findDuplicateMonitor(watcher({ name: 'rush-2479-land' }), existing)).toBe('open-pr-watch');
  });

  it('never reports a monitor as a duplicate of itself (that is a rewrite)', () => {
    const existing = [watcher({ name: 'open-pr-watch' })];
    expect(findDuplicateMonitor(watcher({ name: 'open-pr-watch' }), existing)).toBeNull();
  });

  it('catches a user monitor duplicating a shipped built-in', () => {
    const builtIn = watcher({
      name: 'pr-merge-on-green',
      source: { type: 'poll', command: 'gh pr list --author @me', interval: '5m' } as any,
      action: { type: 'run', agent: 'claude', prompt: 'merge' } as any,
    });
    const mine = watcher({
      name: 'my-lander',
      source: { type: 'poll', command: 'gh pr list --author @me', interval: '5m' } as any,
      action: { type: 'run', agent: 'claude', prompt: 'merge' } as any,
    });
    expect(findDuplicateMonitor(mine, [builtIn])).toBe('pr-merge-on-green');
  });

  it('allows a genuinely different watcher through', () => {
    const existing = [watcher({ name: 'open-pr-watch' })];
    const different = watcher({ name: 'ci-red', source: { type: 'poll', command: 'gh run list', interval: '2m' } as any });
    expect(findDuplicateMonitor(different, existing)).toBeNull();
  });

  it('is empty-set safe', () => {
    expect(findDuplicateMonitor(watcher(), [])).toBeNull();
  });

  it('reproduces the observed pile-up', () => {
    const cmd = 'gh pr list -R phnx-labs/agents-cli --state open --json number,statusCheckRollup';
    const existing = [
      watcher({ name: 'open-pr-watch', source: { type: 'poll', command: cmd, interval: '2m' } as any }),
      watcher({ name: 'pr-ci-fail', source: { type: 'poll', command: cmd, interval: '2m' } as any }),
    ];
    const lander = watcher({ name: 'rush-2479-land', source: { type: 'poll', command: cmd, interval: '2m' } as any });
    expect(findDuplicateMonitor(lander, existing)).toBe('open-pr-watch');
  });
});

describe('hostile input from a YAML file', () => {
  it('does not blow the stack on a recursive anchor', () => {
    const source: any = { type: 'poll', command: 'x', interval: '2m' };
    source.self = source;
    const cyclic = { name: 'c', source, condition: { mode: 'on-change' }, action: { type: 'notify' } } as any;
    expect(() => monitorFingerprint(cyclic)).not.toThrow();
    expect(monitorFingerprint(cyclic)).toBe(monitorFingerprint(cyclic));
  });

  it('distinguishes two different Dates instead of collapsing both to {}', () => {
    const at = (iso: string) =>
      ({ name: 'd', source: { type: 'poll', command: 'x', interval: '2m', when: new Date(iso) },
         condition: { mode: 'on-change' }, action: { type: 'notify' } }) as any;
    expect(monitorFingerprint(at('2026-01-01T00:00:00Z')))
      .not.toBe(monitorFingerprint(at('2026-06-01T00:00:00Z')));
  });
});
