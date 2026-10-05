/** The pending-device diff is relied on by auto-sync, the curation picker, and the menu-bar probe.
 * A node already in the registry is not "new"; a dismissed node is never "new" (an unchecked phone
 * must not resurface every sync); a genuinely new, non-ignored node is surfaced. */
import { describe, expect, it } from 'vitest';
import { computePendingDevices, defaultPickerChecked, discoverableNodes, partitionWantedDevices, planDeviceReconciliation, sanitizeLoginUser, selectNodesToUpsert, withDefaultUser } from './sync.js';
import type { TailscaleNode } from './tailscale.js';
import type { DeviceInput } from './registry.js';

function node(name: string): TailscaleNode {
  return { name, platform: 'linux', online: true, direct: true, sharee: false };
}

describe('discoverableNodes', () => {
  it('drops sharee nodes so a machine shared into the tailnet is never auto-registered or suggested', () => {
    const shared: TailscaleNode = { ...node('funnel-ingress-node'), sharee: true };
    const nodes = [node('zion'), shared, node('win-mini')];
    expect(discoverableNodes(nodes).map((n) => n.name)).toEqual(['zion', 'win-mini']);
  });
});

describe('defaultPickerChecked', () => {
  const shared: TailscaleNode = { ...node('funnel-ingress-node'), sharee: true };

  it('pre-checks an owned, non-dismissed node (Enter keeps the fleet as-is)', () => {
    expect(defaultPickerChecked(node('zion'), new Set(), new Set())).toBe(true);
  });

  it('leaves a sharee node unchecked so the default Enter never registers it', () => {
    expect(defaultPickerChecked(shared, new Set(), new Set())).toBe(false);
  });

  it('keeps a deliberately-registered sharee node checked (Enter must not remove it)', () => {
    expect(defaultPickerChecked(shared, new Set(['funnel-ingress-node']), new Set())).toBe(true);
  });

  it('never pre-checks a dismissed node, sharee or not', () => {
    expect(defaultPickerChecked(node('ipad165'), new Set(), new Set(['ipad165']))).toBe(false);
    expect(defaultPickerChecked(shared, new Set(), new Set(['funnel-ingress-node']))).toBe(false);
  });
});

describe('withDefaultUser', () => {
  const base: DeviceInput = { platform: 'linux', address: { via: 'tailscale', dnsName: 'mac-mini.tail.ts.net' } };

  it('fills the local operator user when the device has none registered', () => {
    expect(withDefaultUser(base, undefined, 'muqsit').user).toBe('muqsit');
  });

  it('never clobbers a pinned user: leaves input.user unset so upsert preserves the registered one', () => {
    expect(withDefaultUser(base, 'root', 'muqsit').user).toBeUndefined();
  });

  it('leaves the user unset when there is no safe local username', () => {
    expect(withDefaultUser(base, undefined, undefined).user).toBeUndefined();
  });

  it('does not overwrite a user already present on the input', () => {
    expect(withDefaultUser({ ...base, user: 'deploy' }, undefined, 'muqsit').user).toBe('deploy');
  });
});

describe('sanitizeLoginUser', () => {
  it('strips a Windows COMPUTER\\user / DOMAIN\\user prefix to the bare ssh account', () => {
    expect(sanitizeLoginUser('win-mini\\muqsit')).toBe('muqsit');
    expect(sanitizeLoginUser('CORP\\muqsit')).toBe('muqsit');
  });

  it('passes a plain POSIX username through unchanged', () => {
    expect(sanitizeLoginUser('muqsit')).toBe('muqsit');
  });

  it('rejects an unsafe username (undefined rather than a bad pin)', () => {
    expect(sanitizeLoginUser('bad user;rm')).toBeUndefined();
    expect(sanitizeLoginUser(undefined)).toBeUndefined();
  });
});

describe('computePendingDevices', () => {
  it('surfaces only nodes that are neither registered nor ignored', () => {
    const nodes = ['zion', 'yosemite-s0', 'ipad165', 'win-mini'].map(node);
    const pending = computePendingDevices(nodes, ['yosemite-s0'], ['ipad165']);
    expect(pending).toEqual(['zion', 'win-mini']);
  });

  it('treats a node that is both registered and ignored as not-pending', () => {
    const nodes = [node('mac-mini')];
    expect(computePendingDevices(nodes, ['mac-mini'], ['mac-mini'])).toEqual([]);
  });

  it('returns everything when nothing is registered or ignored', () => {
    const nodes = ['a', 'b', 'c'].map(node);
    expect(computePendingDevices(nodes, [], [])).toEqual(['a', 'b', 'c']);
  });

  it('returns nothing for an empty tailnet', () => {
    expect(computePendingDevices([], ['zion'], ['ipad165'])).toEqual([]);
  });
});

describe('selectNodesToUpsert (bootstrap vs refresh)', () => {
  const nodes = ['zion', 'yosemite-s0', 'ipad165', 'win-mini'].map(node);
  const registered = new Set(['yosemite-s0', 'win-mini']);
  const ignored = new Set(['ipad165']);

  it('bootstrap upserts every non-ignored node, newcomers included', () => {
    const got = selectNodesToUpsert(nodes, registered, ignored, 'bootstrap').map((n) => n.name);
    expect(got).toEqual(['zion', 'yosemite-s0', 'win-mini']);
  });

  it('refresh upserts only already-registered non-ignored nodes — newcomers are skipped', () => {
    const got = selectNodesToUpsert(nodes, registered, ignored, 'refresh').map((n) => n.name);
    expect(got).toEqual(['yosemite-s0', 'win-mini']);
  });

  it('never upserts an ignored node in either mode', () => {
    for (const mode of ['bootstrap', 'refresh'] as const) {
      const got = selectNodesToUpsert(nodes, registered, ignored, mode).map((n) => n.name);
      expect(got).not.toContain('ipad165');
    }
  });
});

describe('planDeviceReconciliation', () => {
  const all = ['zion', 'yosemite-s0', 'ipad165', 'win-mini', 'mac-mini'];

  it('registers checked, removes+ignores unchecked-that-were-registered', () => {
    const plan = planDeviceReconciliation(
      all,
      ['zion', 'yosemite-s0'],
      ['zion', 'yosemite-s0', 'win-mini'],
      ['ipad165'],
    );
    expect(plan.toRegister).toEqual(['zion', 'yosemite-s0']);
    expect(plan.toRemove).toEqual(['win-mini']);
    expect(plan.toIgnore).toEqual(['ipad165', 'win-mini', 'mac-mini']);
    expect(plan.toUnignore).toEqual([]);
  });

  it('un-ignores a previously-dismissed node when the user re-checks it', () => {
    const plan = planDeviceReconciliation(['ipad165'], ['ipad165'], [], ['ipad165']);
    expect(plan.toRegister).toEqual(['ipad165']);
    expect(plan.toUnignore).toEqual(['ipad165']);
    expect(plan.toRemove).toEqual([]);
    expect(plan.toIgnore).toEqual([]);
  });

  it('does not try to remove an unchecked node that was never registered', () => {
    const plan = planDeviceReconciliation(['mac-mini'], [], [], []);
    expect(plan.toRemove).toEqual([]);
    expect(plan.toIgnore).toEqual(['mac-mini']);
  });
});

describe('partitionWantedDevices (fresh-machine bootstrap)', () => {
  const registered = new Set(['zion']);
  const tailnet = new Set(['zion', 'yosemite-s0', 'yosemite-s1', 'ipad165']);
  const ignored = new Set(['ipad165']);

  it('registers a wanted name that is on the tailnet but not yet in the registry', () => {
    const p = partitionWantedDevices(['yosemite-s0'], registered, tailnet, ignored);
    expect(p.toRegister).toEqual(['yosemite-s0']);
    expect(p.unresolved).toEqual([]);
  });

  it('marks a wanted name absent from the tailnet as unresolved (no committed IP to fall back on)', () => {
    const p = partitionWantedDevices(['ghost-box'], registered, tailnet, ignored);
    expect(p.toRegister).toEqual([]);
    expect(p.unresolved).toEqual(['ghost-box']);
  });

  it('treats an ignored tailnet node as unresolved, never silently re-adding it', () => {
    const p = partitionWantedDevices(['ipad165'], registered, tailnet, ignored);
    expect(p.toRegister).toEqual([]);
    expect(p.unresolved).toEqual(['ipad165']);
  });

  it('skips names already in the registry (nothing to do)', () => {
    const p = partitionWantedDevices(['zion', 'yosemite-s1'], registered, tailnet, ignored);
    expect(p.toRegister).toEqual(['yosemite-s1']);
    expect(p.unresolved).toEqual([]);
  });
});
