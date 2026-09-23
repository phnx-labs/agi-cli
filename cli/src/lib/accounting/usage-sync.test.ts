import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readFleetSharedDeviceStates, readOwnFleetSharedDeviceState } from '../fleet-shared-state.js';
import { readClaudeUsageCache, type CachedUsageSnapshot } from './usage.js';
import {
  applyPeerFleetState,
  buildFleetStatePayload,
  parseFleetStateExchangeInput,
  parseFleetStateReply,
  formatFleetStateReply,
  publishUsageSnapshotToSharedStore,
} from './usage-sync.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-usage-store-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function row(capturedAt: string, usedPercent: number): CachedUsageSnapshot {
  return {
    capturedAt,
    windows: [{ key: 'five_hour', label: 'Session', shortLabel: 'S', usedPercent, resetsAt: null, windowMinutes: 300 }],
  };
}

function seed(file: string, rows: Record<string, CachedUsageSnapshot>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows), 'utf-8');
}

describe('usage sync envelope: headed box publishes, peer applies (real files, no git)', () => {
  it('a headed device publishes once and a worker applies the envelope into its cache with sync provenance', async () => {
    const headed = tempDir();
    const worker = tempDir();
    const sourceCache = path.join(headed, 'source-cache.json');
    const workerCache = path.join(worker, 'worker-cache.json');
    seed(sourceCache, { 'claude:org=alpha': row('2026-08-30T20:00:00.000Z', 64) });

    const published = await publishUsageSnapshotToSharedStore({
      userAgentsDir: headed, cachePath: sourceCache, role: 'personal', device: 'zion',
    });
    expect(published).toMatchObject({ published: true, changed: true, error: null });

    const payload = buildFleetStatePayload({ device: 'zion', userAgentsDir: headed });
    expect(payload.v).toBe(2);
    expect(payload.state.device).toBe('zion');
    expect(payload.state.receivedAt).toBeUndefined();

    const applied = await applyPeerFleetState(payload.state, {
      userAgentsDir: worker, cachePath: workerCache, device: 'worker-a', receivedAt: 1_700_000_000_000,
    });
    expect(applied).toMatchObject({ merged: 1, receivedAt: 1_700_000_000_000 });
    expect(applied.path).toBe(path.join(worker, 'devices', 'zion', 'daemon-state.json'));
    const cached = readClaudeUsageCache('claude:org=alpha', workerCache, new Date('2026-08-30T20:01:00.000Z'));
    expect(cached?.windows[0].usedPercent).toBe(64);
    expect(cached?.freshness).toEqual({ source: 'sync', poller: 'zion' });
    // The peer file is the envelope stamped with when it arrived.
    const [peer] = readFleetSharedDeviceStates(worker).states;
    expect(peer.device).toBe('zion');
    expect(peer.receivedAt).toBe(1_700_000_000_000);
    expect(peer.usage?.rows['claude:org=alpha'].windows[0].usedPercent).toBe(64);
  });

  it('newest-wins per identity across two headed envelopes, whatever the arrival order', async () => {
    const worker = tempDir();
    const workerCache = path.join(worker, 'worker-cache.json');
    const envelopes = [];
    for (const [device, role, snapshot] of [
      ['desktop', 'desktop', row('2026-08-30T20:05:00.000Z', 80)],
      ['laptop', 'personal', row('2026-08-30T20:00:00.000Z', 25)],
    ] as const) {
      const home = tempDir();
      const source = path.join(home, `${device}.json`);
      seed(source, { 'claude:org=alpha': snapshot });
      await publishUsageSnapshotToSharedStore({ userAgentsDir: home, cachePath: source, role, device });
      envelopes.push(buildFleetStatePayload({ device, userAgentsDir: home }).state);
    }
    // The newer (desktop) envelope arrives first; the older laptop one must not displace it.
    expect((await applyPeerFleetState(envelopes[0], { userAgentsDir: worker, cachePath: workerCache, device: 'worker-a' })).merged).toBe(1);
    expect((await applyPeerFleetState(envelopes[1], { userAgentsDir: worker, cachePath: workerCache, device: 'worker-a' })).merged).toBe(0);
    expect(readClaudeUsageCache('claude:org=alpha', workerCache, new Date('2026-08-30T20:06:00.000Z'))?.windows[0].usedPercent).toBe(80);
    expect(readFleetSharedDeviceStates(worker).states.map((s) => s.device)).toEqual(['desktop', 'laptop']);
  });

  it('a worker publishes no usage and its envelope carries none, but a usage-only payload from a headed cache does', async () => {
    const root = tempDir();
    const cache = path.join(root, 'cache.json');
    seed(cache, { 'claude:org=alpha': row('2026-08-30T20:00:00.000Z', 10) });
    expect((await publishUsageSnapshotToSharedStore({ userAgentsDir: root, cachePath: cache, role: 'worker', device: 'worker-a' })).skipped)
      .toContain('not a usage publisher');
    expect(fs.existsSync(path.join(root, 'devices'))).toBe(false);
    expect(buildFleetStatePayload({ device: 'worker-a', userAgentsDir: root }).state).toEqual({ version: 1, device: 'worker-a' });
    expect(buildFleetStatePayload({ device: 'worker-a', cachePath: cache, role: 'worker', usageOnly: true }).state.usage).toBeUndefined();
    expect(buildFleetStatePayload({ device: 'zion', cachePath: cache, role: 'personal', usageOnly: true }).state.usage?.rows['claude:org=alpha'].windows[0].usedPercent).toBe(10);
  });

  it('a partial (usage-only) envelope refreshes usage without erasing the peer\'s other fields', async () => {
    const root = tempDir();
    await applyPeerFleetState(
      { version: 1, device: 'zion', auth: { status: 'ready' }, usage: { rows: { 'claude:org=alpha': row('2026-08-30T20:00:00.000Z', 10) } } },
      { userAgentsDir: root, cachePath: path.join(root, 'c.json'), device: 'worker-a', receivedAt: 1 },
    );
    await applyPeerFleetState(
      { version: 1, device: 'zion', usage: { rows: { 'claude:org=alpha': row('2026-08-30T20:10:00.000Z', 55) } } },
      { userAgentsDir: root, cachePath: path.join(root, 'c.json'), device: 'worker-a', receivedAt: 2 },
    );
    const [peer] = readFleetSharedDeviceStates(root).states;
    expect(peer.auth).toEqual({ status: 'ready' });
    expect(peer.receivedAt).toBe(2);
    expect(peer.usage?.rows['claude:org=alpha'].windows[0].usedPercent).toBe(55);
  });

  it('refuses an envelope naming this device — the own file is never overwritten by a peer', async () => {
    const root = tempDir();
    await expect(applyPeerFleetState({ version: 1, device: 'worker-a' }, { userAgentsDir: root, device: 'worker-a' }))
      .rejects.toThrow(/names this device/);
    expect(fs.existsSync(path.join(root, 'devices'))).toBe(false);
  });

  it('parses v2 and legacy v1 input, rejects everything else with a clear reason', () => {
    expect(parseFleetStateExchangeInput('{"v":1,"rows":{}}')).toEqual({ v: 1, rows: {} });
    expect(parseFleetStateExchangeInput('{"v":2,"state":{"version":1,"device":"zion"},"errors":["auth: x"]}'))
      .toEqual({ v: 2, state: { version: 1, device: 'zion' }, errors: ['auth: x'] });
    expect(() => parseFleetStateExchangeInput('{not json')).toThrow('malformed JSON payload');
    expect(() => parseFleetStateExchangeInput('{"v":1,"rows":[]}')).toThrow('unrecognized usage-sync payload shape');
    expect(() => parseFleetStateExchangeInput('{"v":2,"state":{"version":1}}')).toThrow('unrecognized shared-state envelope');
    expect(() => parseFleetStateExchangeInput('{"v":2,"state":{"version":1,"device":"../etc"}}')).toThrow();
    expect(() => parseFleetStateExchangeInput('{"v":3}')).toThrow('unrecognized usage-sync payload shape');
  });

  it('reads the reply after the marker, ignoring login-shell noise before it, and names an old peer', () => {
    const reply = formatFleetStateReply({ v: 2, state: { version: 1, device: 'peer-b' } });
    expect(parseFleetStateReply(`motd banner\nwelcome\n${reply}`).state.device).toBe('peer-b');
    expect(() => parseFleetStateReply('')).toThrow(/empty reply .*predates/);
    expect(() => parseFleetStateReply('some noise')).toThrow(/no reply envelope/);
  });

  it('readOwnFleetSharedDeviceState strips a stray receivedAt and yields a bare envelope for a never-published device', async () => {
    const root = tempDir();
    expect(readOwnFleetSharedDeviceState('fresh', root)).toEqual({ version: 1, device: 'fresh' });
    await applyPeerFleetState({ version: 1, device: 'zion', auth: { status: 'ready' } }, { userAgentsDir: root, device: 'worker-a', receivedAt: 5 });
    expect(readOwnFleetSharedDeviceState('zion', root)).toEqual({ version: 1, device: 'zion', auth: { status: 'ready' } });
  });
});
