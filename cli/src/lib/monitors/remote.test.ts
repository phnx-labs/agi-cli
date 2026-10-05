
import { describe, it, expect } from 'vitest';
import { parseRemoteMonitors, gatherFleetMonitors } from './remote.js';
import { monitorFingerprint } from './fingerprint.js';
import type { SshCaptureFn } from '../remote-agents-json.js';
import type { MonitorConfig } from './config.js';

const watcher = (over: Record<string, unknown> = {}) => ({
  name: 'w',
  source: { type: 'poll', command: 'gh pr view 2517', interval: '2m' },
  condition: { mode: 'on-change' },
  action: { type: 'run', agent: 'claude', prompt: 'merge' },
  ...over,
});

describe('parseRemoteMonitors', () => {
  it('tags each monitor with the machine it lives on', () => {
    const out = parseRemoteMonitors(JSON.stringify([watcher({ name: 'land-2517' })]), 'zion');
    expect(out).toHaveLength(1);
    expect(out[0].machine).toBe('zion');
    expect(out[0].monitor.name).toBe('land-2517');
  });

  it('captures the peer display view (enabled/owner/scope/liveness) for `list`', () => {
    const row = watcher({
      name: 'pr-merge-on-green',
      enabled: false,
      owner: 'mac-mini',
      scope: 'system',
      stalled: true,
      checkCount: 42,
      lastCheckedAt: '2026-08-28T00:00:00.000Z',
      lastFiredAt: '2026-08-27T00:00:00.000Z',
      lastActionFailed: true,
    });
    const [out] = parseRemoteMonitors(JSON.stringify([row]), 'mac-mini');
    expect(out.display).toEqual({
      enabled: false,
      owner: 'mac-mini',
      scope: 'system',
      stalled: true,
      checkCount: 42,
      lastCheckedAt: '2026-08-28T00:00:00.000Z',
      lastFiredAt: '2026-08-27T00:00:00.000Z',
      lastActionFailed: true,
    });
  });

  it('a version-skewed peer that omits the display fields degrades to undefined, not garbage', () => {
    const [out] = parseRemoteMonitors(JSON.stringify([watcher({ scope: 'bogus' })]), 'zion');
    expect(out.display).toEqual({
      enabled: undefined,
      owner: undefined,
      scope: undefined,
      stalled: undefined,
      checkCount: undefined,
      lastCheckedAt: undefined,
      lastFiredAt: undefined,
      lastActionFailed: undefined,
    });
  });

  it('returns [] for non-JSON from a version-skewed peer instead of throwing', () => {
    expect(parseRemoteMonitors('error: unknown command', 'zion')).toEqual([]);
    expect(parseRemoteMonitors('', 'zion')).toEqual([]);
  });

  it('returns [] for a non-array payload (list --json emits a bare array)', () => {
    expect(parseRemoteMonitors(JSON.stringify({ monitors: [watcher()] }), 'zion')).toEqual([]);
  });

  it('drops rows with no identity rather than half-comparing them', () => {
    const out = parseRemoteMonitors(JSON.stringify([{ name: 'partial' }, watcher()]), 'zion');
    expect(out).toHaveLength(1);
    expect(out[0].monitor.name).toBe('w');
  });

  it('skips non-object entries without losing the good ones', () => {
    const out = parseRemoteMonitors(JSON.stringify([null, 'nope', 42, watcher()]), 'zion');
    expect(out).toHaveLength(1);
  });
});

describe('against the real `monitors list --json` projection', () => {
  type Ident = Pick<MonitorConfig, 'name' | 'source' | 'condition' | 'action'>;

  const asListJson = (m: any) =>
    JSON.stringify([
      {
        name: m.name,
        enabled: true,
        source: m.source,
        condition: m.condition,
        action: m.action,
        owner: 'all',
        runsHere: true,
        lastSeenAt: null,
        lastFiredAt: null,
      },
    ]);

  const runMonitor = (over: Record<string, unknown> = {}) => ({
    name: 'land-2517',
    source: { type: 'poll', command: 'gh pr view 2517', interval: '2m' },
    condition: { mode: 'on-change' },
    action: { type: 'run', agent: 'claude', prompt: 'merge it' },
    ...over,
  });

  it('matches a --run monitor across machines — the case that was inert', () => {
    const remote = parseRemoteMonitors(asListJson(runMonitor()), 'zion');
    expect(remote).toHaveLength(1);
    const mine = runMonitor({ name: 'rush-2517-land' }) as unknown as Ident;
    const hit = remote.find((r) => monitorFingerprint(r.monitor) === monitorFingerprint(mine));
    expect(hit?.machine).toBe('zion');
  });

  it('would NOT match if the projection dropped the action payload', () => {
    const typeOnly = JSON.stringify([
      { name: 'land-2517', enabled: true, source: runMonitor().source, condition: runMonitor().condition, action: { type: 'run' } },
    ]);
    const remote = parseRemoteMonitors(typeOnly, 'zion');
    const mine = runMonitor({ name: 'mine' }) as unknown as Ident;
    expect(remote.find((r) => monitorFingerprint(r.monitor) === monitorFingerprint(mine))).toBeUndefined();
  });

  it('lets a DIFFERENT work item through — the common case', () => {
    const remote = parseRemoteMonitors(asListJson(runMonitor()), 'zion');
    const other = runMonitor({
      name: 'land-2600',
      source: { type: 'poll', command: 'gh pr view 2600', interval: '2m' },
    }) as unknown as Ident;
    expect(remote.find((r) => monitorFingerprint(r.monitor) === monitorFingerprint(other))).toBeUndefined();
  });

  it('matches regardless of the two monitors being named differently', () => {
    const remote = parseRemoteMonitors(asListJson(runMonitor({ name: 'totally-other' })), 'mac-mini');
    const mine = runMonitor({ name: 'mine' }) as unknown as Ident;
    expect(remote.find((r) => monitorFingerprint(r.monitor) === monitorFingerprint(mine))?.machine).toBe('mac-mini');
  });

  it('a local monitor named `<machine>:<name>` cannot dodge the check', () => {
    const remote = parseRemoteMonitors(asListJson(runMonitor({ name: 'foo' })), 'zion');
    const mine = runMonitor({ name: 'zion:foo' }) as unknown as Ident;
    expect(remote.find((r) => monitorFingerprint(r.monitor) === monitorFingerprint(mine))?.machine).toBe('zion');
  });
});

describe('gatherFleetMonitors', () => {
  type Ident = Pick<MonitorConfig, 'name' | 'source' | 'condition' | 'action'>;

  const runMonitor = (over: Record<string, unknown> = {}) => ({
    name: 'land-2517',
    source: { type: 'poll', command: 'gh pr view 2517', interval: '2m' },
    condition: { mode: 'on-change' },
    action: { type: 'run', agent: 'claude', prompt: 'merge it' },
    ...over,
  });

  const asListJson = (m: any) =>
    JSON.stringify([
      {
        name: m.name,
        enabled: true,
        source: m.source,
        condition: m.condition,
        action: m.action,
        owner: 'all',
        runsHere: true,
        lastSeenAt: null,
        lastFiredAt: null,
      },
    ]);

  const FAST = 'tester@fast.example.com';
  const SLOW = 'tester@slow.example.com';

  it('aborts remaining peers as soon as a clash fingerprint is reported', async () => {
    const mine = runMonitor({ name: 'mine' }) as unknown as Ident;
    const targetFp = monitorFingerprint(mine);
    const aborted: string[] = [];

    const capture: SshCaptureFn = (target, _cmd, { signal }) =>
      new Promise((resolve) => {
        if (target === FAST) {
          resolve({ code: 0, stdout: asListJson(runMonitor()) });
          return;
        }
        if (signal?.aborted) {
          aborted.push(target);
          resolve({ code: null, stdout: '' });
          return;
        }
        signal?.addEventListener(
          'abort',
          () => {
            aborted.push(target);
            resolve({ code: null, stdout: '' });
          },
          { once: true },
        );
      });

    const result = await gatherFleetMonitors({
      againstFingerprint: targetFp,
      hosts: [FAST, SLOW],
      deps: { capture },
    });

    const clash = result.monitors.find((r) => monitorFingerprint(r.monitor) === targetFp);
    expect(clash?.machine).toBe('fast');
    expect(result.skipped).toEqual([]);
    expect(aborted).toEqual([SLOW]);
  });

  it('waits for every peer when no monitor matches the fingerprint', async () => {
    const mine = runMonitor({
      name: 'mine',
      source: { type: 'poll', command: 'gh pr view 2600', interval: '2m' },
    }) as unknown as Ident;
    const targetFp = monitorFingerprint(mine);

    const capture: SshCaptureFn = (target) =>
      new Promise((resolve) => {
        if (target === FAST) resolve({ code: 0, stdout: asListJson(runMonitor()) });
        else setTimeout(() => resolve({ code: 0, stdout: asListJson(runMonitor({ name: 'other' })) }), 25);
      });

    const result = await gatherFleetMonitors({
      againstFingerprint: targetFp,
      hosts: [FAST, SLOW],
      deps: { capture },
    });

    expect(result.monitors).toHaveLength(2);
    expect(result.skipped).toEqual([]);
  });
});
