import { describe, it, expect } from 'vitest';
import {
  enumerateTargets,
  rankTargets,
  pickBestTarget,
  type MigrateContext,
} from './migrate-targets.js';
import type { Host } from '../hosts/types.js';
import type { DeviceStats } from '../devices/health.js';
import type { CrabboxBox } from '../crabbox/cli.js';

function host(name: string, opts: Partial<Host> = {}): Host {
  return {
    name,
    provider: 'devices',
    source: 'ssh-config',
    os: 'darwin',
    ...opts,
  };
}

function stats(hostName: string, loadPercent: number): DeviceStats {
  return { host: hostName, reachable: true, loadPercent, fetchedAt: 0 };
}

function box(slug: string, opts: Partial<CrabboxBox> = {}): CrabboxBox {
  return {
    name: `crabbox-${slug}`,
    status: 'running',
    slug,
    lease: `cbx_${slug}`,
    state: 'ready',
    ready: true,
    keep: false,
    createdAt: 0,
    expiresAt: null,
    lastTouchedAt: 0,
    idleTimeoutSecs: null,
    ...opts,
  };
}

const ctx: MigrateContext = {
  selfHostname: 'zion',
  sourceHostname: 'src-box',
  sourceOs: 'darwin',
};

describe('enumerateTargets — exclusion of the interactive machine and the source', () => {
  it('never offers the current machine (os.hostname) or the source as a target', () => {
    const hosts = [host('zion'), host('src-box'), host('worker-a')];
    const targets = enumerateTargets(hosts, [], new Map(), ctx);
    const names = targets.map((t) => t.name);
    expect(names).not.toContain('zion');
    expect(names).not.toContain('src-box');
    expect(names).toContain('worker-a');
  });

  it('excludes case-insensitively (hostname casing must not leak a self-target)', () => {
    const hosts = [host('ZION'), host('Worker-A')];
    const names = enumerateTargets(hosts, [], new Map(), ctx).map((t) => t.name);
    expect(names).not.toContain('ZION');
    expect(names).toContain('Worker-A');
  });

  it('drops non-dispatchable and offline hosts, keeps absent-means-dispatchable', () => {
    const hosts = [
      host('pw-device', { dispatchable: false }),
      host('sleeping', { status: 'offline' }),
      host('reachable', { status: 'online' }),
      host('unknown-but-ok'),
    ];
    const names = enumerateTargets(hosts, [], new Map(), ctx).map((t) => t.name);
    expect(names).not.toContain('pw-device');
    expect(names).not.toContain('sleeping');
    expect(names).toEqual(expect.arrayContaining(['reachable', 'unknown-but-ok']));
  });

  it('includes warm ephemeral boxes tagged as such', () => {
    const targets = enumerateTargets([], [box('blue-hermit')], new Map(), ctx);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ name: 'blue-hermit', kind: 'ephemeral', os: 'linux' });
  });

  it('derives headroom from the stats map, unknown when absent', () => {
    const hosts = [host('idle-box'), host('no-stats')];
    const s = new Map<string, DeviceStats>([['idle-box', stats('idle-box', 5)]]);
    const targets = enumerateTargets(hosts, [], s, ctx);
    expect(targets.find((t) => t.name === 'idle-box')!.headroom).toBe('idle');
    expect(targets.find((t) => t.name === 'no-stats')!.headroom).toBe('unknown');
  });
});

describe('rankTargets — auto ordering', () => {
  it('prefers a platform match with the source over a busier same-platform box? no — platform first, then headroom', () => {
    const targets = enumerateTargets(
      [host('linux-idle', { os: 'linux' }), host('mac-busy', { os: 'darwin' })],
      [],
      new Map([
        ['linux-idle', stats('linux-idle', 5)],
        ['mac-busy', stats('mac-busy', 60)],
      ]),
      ctx,
    );
    const ranked = rankTargets(targets, ctx);
    expect(ranked[0].name).toBe('mac-busy');
  });

  it('prefers a warm fleet worker over provisioning a box, all else equal', () => {
    const targets = enumerateTargets(
      [host('worker', { os: 'linux' })],
      [box('fresh-box')],
      new Map([
        ['worker', stats('worker', 10)],
        ['fresh-box', stats('fresh-box', 10)],
      ]),
      { ...ctx, sourceOs: 'linux' },
    );
    const ranked = rankTargets(targets, { ...ctx, sourceOs: 'linux' });
    expect(ranked[0].kind).toBe('fleet');
    expect(ranked[0].name).toBe('worker');
  });

  it('ranks by headroom among same-platform same-kind targets (idle beats loaded)', () => {
    const targets = enumerateTargets(
      [host('busy', { os: 'darwin' }), host('idle', { os: 'darwin' })],
      [],
      new Map([
        ['busy', stats('busy', 80)],
        ['idle', stats('idle', 5)],
      ]),
      ctx,
    );
    const ranked = rankTargets(targets, ctx);
    expect(ranked.map((t) => t.name)).toEqual(['idle', 'busy']);
  });
});

describe('pickBestTarget', () => {
  it('returns null when the only hosts are the self and source', () => {
    const hosts = [host('zion'), host('src-box')];
    expect(pickBestTarget(hosts, [], new Map(), ctx)).toBeNull();
  });

  it('returns the top-ranked eligible target', () => {
    const hosts = [host('zion'), host('src-box'), host('mac-idle', { os: 'darwin' })];
    const best = pickBestTarget(hosts, [], new Map([['mac-idle', stats('mac-idle', 3)]]), ctx);
    expect(best?.name).toBe('mac-idle');
  });
});
