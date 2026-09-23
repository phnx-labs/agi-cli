import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { DeviceProfile } from '../devices/registry.js';
import { REMOTE_STDOUT_MAX_BYTES, type SshExecResult } from '../ssh-exec.js';
import { readFleetSharedDeviceStates, newestPeerReceivedAtMs } from '../fleet-shared-state.js';
import {
  exchangeFleetStateWithPeers,
  FLEET_STATE_REPLY_MARKER,
  formatFleetStateReply,
  parseFleetStateReply,
  publishUsageSnapshotToSharedStore,
  type FleetStateExchangePayload,
} from './usage-sync.js';

// Real end-to-end of the `agents __usage-ingest` verb (PHNX-3392, PHNX-4116):
// spawn the actual CLI with an isolated HOME, pipe an envelope, and assert the
// rows landed in that HOME's real claude-usage.json, the peer's file was stored,
// and `--reply` prints this box's own envelope. Exercises the index.ts
// pre-bootstrap interception + stdin read + newest-wins merge, no mocks. The
// exchange test injects ONLY the ssh boundary: a dial that runs the local binary
// as the peer, exactly as `ssh <peer> agents __usage-ingest --reply` would.

function run(home: string, input: string, args: string[] = [], machineId = 'ingest-e2e-self') {
  return spawnSync('bun', ['src/index.ts', '__usage-ingest', ...args], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, AGENTS_SYNC_MACHINE_ID: machineId },
    cwd: process.cwd(),
    timeout: 60_000,
  });
}

function usageRow(usedPercent: number, capturedAt = '2026-08-28T12:00:00.000Z') {
  return {
    capturedAt,
    windows: [
      { key: 'five_hour', label: 'Session (5h)', shortLabel: 'S', usedPercent, resetsAt: null, windowMinutes: 300 },
    ],
  };
}

function legacyPayload(usedPercent: number, capturedAt?: string) {
  return JSON.stringify({ v: 1, rows: { 'claude:org=alpha': usageRow(usedPercent, capturedAt) } });
}

function envelope(device: string, usedPercent: number, capturedAt?: string): FleetStateExchangePayload {
  return {
    v: 2,
    state: {
      version: 1,
      device,
      auth: { status: 'ready' },
      usage: { rows: { 'claude:org=alpha': usageRow(usedPercent, capturedAt) } },
    },
  };
}

function profile(name: string): DeviceProfile {
  return {
    name,
    platform: 'linux',
    shell: 'posix',
    address: { via: 'manual', ip: '127.0.0.1' },
    auth: { method: 'key' },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

describe('agents __usage-ingest (real CLI verb)', () => {
  let home = '';
  let cachePath = '';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-ingest-e2e-'));
    cachePath = path.join(home, '.agents', '.cache', 'claude-usage.json');
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('merges a legacy v1 payload into the isolated HOME cache, prints nothing, and exits 0', () => {
    const res = run(home, legacyPayload(41));
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    expect(cache['claude:org=alpha'].windows[0].usedPercent).toBe(41);
  });

  it('stores a v2 envelope as the peer\'s file and merges its usage rows with sync provenance', () => {
    const res = run(home, JSON.stringify(envelope('zion', 58)));
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    expect(cache['claude:org=alpha']).toMatchObject({ freshnessSource: 'sync', pollerDevice: 'zion' });
    expect(cache['claude:org=alpha'].windows[0].usedPercent).toBe(58);
    const peerFile = path.join(home, '.agents', 'devices', 'zion', 'daemon-state.json');
    const peer = JSON.parse(fs.readFileSync(peerFile, 'utf-8'));
    expect(peer).toMatchObject({ version: 1, device: 'zion', auth: { status: 'ready' } });
    expect(typeof peer.receivedAt).toBe('number');
  });

  it('--reply prints this box\'s own envelope after the marker, with its verdict and no usage on an unmarked box', () => {
    const res = run(home, JSON.stringify(envelope('zion', 58)), ['--reply'], 'peer-b');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`${FLEET_STATE_REPLY_MARKER}\n`);
    const reply = parseFleetStateReply(res.stdout);
    expect(reply.state.device).toBe('peer-b');
    // An unmarked box is worker-equivalent: it publishes no usage of its own.
    expect(reply.state.usage).toBeUndefined();
    // The reserved-auth verdict rides the reply (no `auth` bundle in a fresh HOME → missing).
    expect(reply.state.auth).toEqual({ status: 'missing' });
    expect(Array.isArray(reply.state.sessions?.rows)).toBe(true);
    // The pushed envelope still landed locally.
    expect(fs.existsSync(path.join(home, '.agents', 'devices', 'zion', 'daemon-state.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(cachePath, 'utf-8'))['claude:org=alpha'].windows[0].usedPercent).toBe(58);
  });

  it('--reply on empty stdin still answers (a probe with nothing to send)', () => {
    const res = run(home, '', ['--reply'], 'peer-b');
    expect(res.status).toBe(0);
    expect(parseFleetStateReply(res.stdout).state.device).toBe('peer-b');
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it('exits 2 on a malformed payload and writes nothing', () => {
    const res = run(home, '{not json');
    expect(res.status).toBe(2);
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it('exits 0 on empty stdin (a quiet tick), writing nothing', () => {
    const res = run(home, '');
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it('rejects an ARRAY-shaped rows payload (typeof [] === object) — exit 2, writes nothing', () => {
    // Regression: `typeof payload.rows !== 'object'` alone accepts an array and
    // would write a bogus "0"-keyed row. The Array.isArray guard rejects it.
    const res = run(home, JSON.stringify({ v: 1, rows: [{ capturedAt: null, windows: [] }] }));
    expect(res.status).toBe(2);
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it('refuses an envelope naming this device: exit 2 without --reply, an error in the reply with it', () => {
    const silent = run(home, JSON.stringify(envelope('peer-b', 10)), [], 'peer-b');
    expect(silent.status).toBe(2);
    expect(silent.stderr).toMatch(/names this device/);
    const replied = run(home, JSON.stringify(envelope('peer-b', 10)), ['--reply'], 'peer-b');
    expect(replied.status).toBe(0);
    expect(parseFleetStateReply(replied.stdout).errors?.[0]).toMatch(/names this device/);
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it('refuses a stdin payload over REMOTE_STDOUT_MAX_BYTES: exit 2, one typed stderr line, cache untouched; a normal payload still merges', () => {
    // Seed the cache so "unchanged" is a real byte comparison, not "still absent".
    expect(run(home, legacyPayload(41)).status).toBe(0);
    const before = fs.readFileSync(cachePath, 'utf-8');
    expect(JSON.parse(before)['claude:org=alpha'].windows[0].usedPercent).toBe(41);

    // A v1 envelope that WOULD merge (the parser tolerates extra keys) if the
    // cap were missing — 16 MiB of padding pushes it over the dialer's ceiling.
    const oversized = JSON.stringify({
      v: 1,
      rows: { 'claude:org=alpha': usageRow(99, '2026-08-29T12:00:00.000Z') },
      pad: 'x'.repeat(REMOTE_STDOUT_MAX_BYTES),
    });
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(REMOTE_STDOUT_MAX_BYTES);
    const refused = run(home, oversized);
    expect(refused.status).toBe(2);
    expect(refused.stdout).toBe('');
    const lines = refused.stderr.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[agents\] __usage-ingest: UsageIngestInputTooLargeError: stdin payload exceeds 16777216 bytes \(16 MiB\); refusing it unread$/);
    expect(fs.readFileSync(cachePath, 'utf-8')).toBe(before);

    // The same row without the padding is under the cap and merges newest-wins.
    const merged = run(home, legacyPayload(99, '2026-08-29T12:00:00.000Z'));
    expect(merged.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(cachePath, 'utf-8'))['claude:org=alpha'].windows[0].usedPercent).toBe(99);
  });

  it('reads the payload from --from <file> (the Windows stdin workaround path)', () => {
    const file = path.join(home, 'payload.json');
    fs.writeFileSync(file, legacyPayload(63), 'utf-8');
    const res = run(home, '', ['--from', file]);
    expect(res.status).toBe(0);
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    expect(cache['claude:org=alpha'].windows[0].usedPercent).toBe(63);
  });
});

describe('usage-sync exchange: headed box dials peers over ssh, each answered by the real CLI', () => {
  const homes: string[] = [];
  function home(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    homes.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('delivers to the live peer, skips the timed-out one, rejects a mis-named reply, and stamps receivedAt', async () => {
    const headedHome = home('usage-exchange-headed-');
    const headedRoot = path.join(headedHome, '.agents');
    const headedCache = path.join(headedRoot, '.cache', 'claude-usage.json');
    fs.mkdirSync(path.dirname(headedCache), { recursive: true });
    fs.writeFileSync(headedCache, JSON.stringify({ 'claude:org=alpha': usageRow(72, '2026-09-23T10:00:00.000Z') }), 'utf-8');
    expect(await publishUsageSnapshotToSharedStore({
      userAgentsDir: headedRoot, cachePath: headedCache, role: 'personal', device: 'headed-a',
    })).toMatchObject({ published: true, changed: true });

    const peerHome = home('usage-exchange-peer-');
    const seen: Array<{ peer: string; remoteCmd: string }> = [];
    const dial = async (peer: DeviceProfile, remoteCmd: string, input: string): Promise<SshExecResult> => {
      seen.push({ peer: peer.name, remoteCmd });
      if (peer.name === 'peer-dead') return { code: null, stdout: '', stderr: '', timedOut: true };
      if (peer.name === 'peer-old') return { code: 2, stdout: '', stderr: '[agents] __usage-ingest: unrecognized usage-sync payload shape', timedOut: false };
      if (peer.name === 'peer-liar') {
        return { code: 0, stdout: formatFleetStateReply({ v: 2, state: { version: 1, device: 'somebody-else' } }), stderr: '', timedOut: false };
      }
      // The live peer: the local binary standing in for `ssh peer-b agents __usage-ingest --reply`.
      const res = run(peerHome, input, ['--reply'], 'peer-b');
      return { code: res.status, stdout: res.stdout, stderr: res.stderr, timedOut: false };
    };

    const before = Date.now();
    const result = await exchangeFleetStateWithPeers({
      device: 'headed-a',
      userAgentsDir: headedRoot,
      cachePath: headedCache,
      peers: [profile('peer-b'), profile('peer-dead'), profile('peer-old'), profile('peer-liar')],
      dial,
      timeoutMs: 20_000,
    });

    expect(result.skipped).toBeNull();
    expect(seen.map((s) => s.peer).sort()).toEqual(['peer-b', 'peer-dead', 'peer-liar', 'peer-old']);
    expect(seen[0].remoteCmd).toBe("bash -lc 'agents __usage-ingest --reply'");
    const byDevice = Object.fromEntries(result.outcomes.map((o) => [o.device, o]));
    expect(byDevice['peer-b']).toMatchObject({ delivered: true, merged: 0, error: null, peerErrors: [] });
    expect(byDevice['peer-b'].receivedAt).toBeGreaterThanOrEqual(before);
    expect(byDevice['peer-dead']).toMatchObject({ delivered: false, receivedAt: null, error: 'timed out after 20s' });
    expect(byDevice['peer-old'].error).toMatch(/exited 2: .*unrecognized usage-sync payload shape/);
    expect(byDevice['peer-liar'].error).toBe("reply names device 'somebody-else', expected 'peer-liar'");

    // The worker holds the headed box's rows (sync provenance) and its envelope.
    const peerCache = JSON.parse(fs.readFileSync(path.join(peerHome, '.agents', '.cache', 'claude-usage.json'), 'utf-8'));
    expect(peerCache['claude:org=alpha']).toMatchObject({ freshnessSource: 'sync', pollerDevice: 'headed-a' });
    expect(peerCache['claude:org=alpha'].windows[0].usedPercent).toBe(72);
    // (`--reply` also refreshed the peer's OWN file, which carries no receivedAt.)
    const onPeer = readFleetSharedDeviceStates(path.join(peerHome, '.agents')).states;
    expect(onPeer.map((s) => s.device)).toEqual(['headed-a', 'peer-b']);
    expect(onPeer[0].usage?.rows['claude:org=alpha'].windows[0].usedPercent).toBe(72);
    expect(onPeer[0].receivedAt).toBeGreaterThanOrEqual(before);
    expect(onPeer[1].receivedAt).toBeUndefined();

    // The headed box holds ONLY the live peer's envelope — nothing was written for
    // the timed-out, old, or mis-named peers — stamped with when it arrived.
    const onHeaded = readFleetSharedDeviceStates(headedRoot).states;
    expect(onHeaded.map((s) => s.device)).toEqual(['headed-a', 'peer-b']);
    const peerB = onHeaded.find((s) => s.device === 'peer-b')!;
    expect(peerB.auth).toEqual({ status: 'missing' });
    expect(peerB.receivedAt).toBe(byDevice['peer-b'].receivedAt);
    expect(newestPeerReceivedAtMs(headedRoot)).toBe(byDevice['peer-b'].receivedAt);
    // The headed box's own file never carries a receivedAt.
    expect(onHeaded.find((s) => s.device === 'headed-a')!.receivedAt).toBeUndefined();
  });

  it('a Windows peer is dialed through the stdin temp-file shim, and no peers at all is a stated skip', async () => {
    const root = path.join(home('usage-exchange-win-'), '.agents');
    const seen: string[] = [];
    const win: DeviceProfile = { ...profile('win-mini'), platform: 'windows', shell: 'powershell' };
    const result = await exchangeFleetStateWithPeers({
      device: 'headed-a',
      userAgentsDir: root,
      peers: [win],
      dial: async (_peer, remoteCmd) => { seen.push(remoteCmd); return { code: null, stdout: '', stderr: '', timedOut: true }; },
      timeoutMs: 1_000,
    });
    expect(seen[0].startsWith('powershell -NoProfile -EncodedCommand ')).toBe(true);
    expect(result.outcomes[0].error).toBe('timed out after 1s');
    expect(await exchangeFleetStateWithPeers({ device: 'headed-a', userAgentsDir: root, peers: [], dial: async () => { throw new Error('never'); } }))
      .toEqual({ skipped: 'no dialable peer in the device registry', outcomes: [] });
  });

  it('newestPeerReceivedAtMs reads the newest peer receivedAt the exchange stamped', () => {
    // Per-peer `receivedAt` is what auth-sync now reads first-hand (PHNX-4116 PR 5,
    // replacing the fleet-wide freshness gate); pinned here via the real HOME the
    // ingest verb writes under so the stamped reader is exercised end to end.
    const peerHome = home('usage-exchange-marker-');
    expect(run(peerHome, JSON.stringify(envelope('zion', 12)), [], 'peer-b').status).toBe(0);
    const stamped = readFleetSharedDeviceStates(path.join(peerHome, '.agents')).states[0].receivedAt;
    expect(typeof stamped).toBe('number');
    expect(newestPeerReceivedAtMs(path.join(peerHome, '.agents'))).toBe(stamped);
  });
});
