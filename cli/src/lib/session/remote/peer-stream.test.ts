import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DeviceProfile } from '../../devices/registry.js';
import {
  PEER_BACKOFF_BASE_MS,
  PEER_BACKOFF_CAP_MS,
  PEER_PARK_AFTER_FAILURES,
  peerBackoffDelayMs,
  PEER_RETIRE_AFTER_FAILURES,
  PEER_RETIRED_RECHECK_MS,
  streamFromPeer,
} from './peer-stream.js';

const roots: string[] = [];
function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-stream-'));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function device(name = 'peer-a'): DeviceProfile {
  return {
    name,
    platform: 'linux',
    shell: 'posix',
    user: 'agent',
    auth: { method: 'key' },
    address: { via: 'manual', dnsName: '127.0.0.1' },
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
  } as DeviceProfile;
}

/**
 * A real executable standing in for ssh. It records each invocation, writes the
 * given stderr, and exits with the given code — the shape of a peer that cannot
 * be reached.
 */
function fakeSsh(dir: string, body: string): string {
  const bin = path.join(dir, 'fake-ssh');
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

describe('peer subscription backoff', () => {
  it('doubles from the base delay and saturates at the cap', () => {
    expect(peerBackoffDelayMs(0)).toBe(0);
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => peerBackoffDelayMs(n)))
      .toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    expect(peerBackoffDelayMs(1)).toBe(PEER_BACKOFF_BASE_MS);
    // The cap holds up to the retire threshold; past it the slow tier takes over
    // (asserted in the retire test below).
    expect(peerBackoffDelayMs(PEER_RETIRE_AFTER_FAILURES - 1)).toBe(PEER_BACKOFF_CAP_MS);
  });

  it('retires a long-offline peer onto the slow cadence instead of dialing it forever', () => {
    // The cap bounds the DELAY; without the retire tier a box off for a weekend
    // is still dialed every 60s for two days. Past the threshold the re-dial
    // drops to the slow cadence, which is what bounds the total work.
    expect(peerBackoffDelayMs(PEER_RETIRE_AFTER_FAILURES - 1)).toBe(PEER_BACKOFF_CAP_MS);
    expect(peerBackoffDelayMs(PEER_RETIRE_AFTER_FAILURES)).toBe(PEER_RETIRED_RECHECK_MS);
    expect(peerBackoffDelayMs(500)).toBe(PEER_RETIRED_RECHECK_MS);
    expect(PEER_RETIRED_RECHECK_MS).toBeGreaterThan(PEER_BACKOFF_CAP_MS);
  });

  it('reports a retired peer as retired, with the slow re-dial named', async () => {
    const dir = root();
    const ssh = fakeSsh(dir, 'echo "ssh: connect to host peer-a port 22: No route to host" >&2\nexit 255');
    const controller = new AbortController();
    const reasons: string[] = [];
    await streamFromPeer({
      device: device(),
      signal: controller.signal,
      command: 'agents sessions watch --json --local',
      sshBin: ssh,
      backoffBaseMs: 1,
      backoffCapMs: 2,
      parkAfterFailures: 2,
      retireAfterFailures: 4,
      // Scaled down from the shipped 15min so the schedule is observable.
      retiredRecheckMs: 30,
      registryPollMs: 5,
      registryPath: path.join(dir, 'registry.json'),
      onLine: () => false,
      onUnavailable: (reason) => {
        reasons.push(reason);
        if (reasons.length >= 4) controller.abort();
      },
    });
    expect(reasons[2]).toContain('parked after 3 failed connections');
    expect(reasons[3]).toContain('retired after 4 failed connections');
    expect(reasons[3]).toContain('re-dialing in');
    // A retired peer still re-dials on a device refresh, so it is never stranded.
    expect(reasons[3]).toContain('or on a device refresh');
  });

  it('backs off a failing peer, surfaces its stderr, and parks it after three spawns', async () => {
    const dir = root();
    const log = path.join(dir, 'invocations');
    const ssh = fakeSsh(dir, `echo "$#" >> ${JSON.stringify(log)}\necho "ssh: connect to host peer-a port 22: No route to host" >&2\nexit 255`);
    const controller = new AbortController();
    const reasons: string[] = [];
    const started = Date.now();

    await streamFromPeer({
      device: device(),
      signal: controller.signal,
      command: 'agents sessions watch --json --local',
      sshBin: ssh,
      // Scaled down so the schedule is observable in a test, with the same
      // doubling and park behaviour the shipped defaults have.
      backoffBaseMs: 20,
      backoffCapMs: 80,
      registryPollMs: 10,
      registryPath: path.join(dir, 'registry.json'),
      onLine: () => false,
      onUnavailable: (reason) => {
        reasons.push(reason);
        // Three failed spawns is the park threshold; stop the loop there so the
        // assertion is about the schedule, not the test's patience.
        if (reasons.length >= PEER_PARK_AFTER_FAILURES) controller.abort();
      },
    });

    const invocations = fs.readFileSync(log, 'utf-8').trim().split('\n');
    expect(invocations).toHaveLength(3);
    // The reason carries the peer's own stderr instead of discarding it.
    expect(reasons[0]).toBe('ssh exited 255: ssh: connect to host peer-a port 22: No route to host');
    expect(reasons[1]).toBe(reasons[0]);
    expect(reasons[2]).toContain('parked after 3 failed connections');
    // 20ms + 40ms of backoff separates the three spawns.
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('resets the backoff when a peer delivers a healthy protocol line', async () => {
    const dir = root();
    const attempts = path.join(dir, 'attempts');
    // Fails twice, then serves one protocol line and exits; the healthy line
    // must clear the failure streak so the peer is not parked on the next exit.
    const ssh = fakeSsh(dir, [
      `n=$(cat ${JSON.stringify(attempts)} 2>/dev/null || echo 0)`,
      `echo $((n + 1)) > ${JSON.stringify(attempts)}`,
      'if [ "$n" -ge 2 ]; then echo \'{"ok":true}\'; fi',
      'exit 1',
    ].join('\n'));
    const controller = new AbortController();
    const reasons: string[] = [];
    let lines = 0;

    await streamFromPeer({
      device: device(),
      signal: controller.signal,
      command: 'agents sessions watch --json --local',
      sshBin: ssh,
      backoffBaseMs: 10,
      backoffCapMs: 40,
      registryPollMs: 10,
      registryPath: path.join(dir, 'registry.json'),
      onLine: () => { lines += 1; return true; },
      onUnavailable: (reason) => {
        reasons.push(reason);
        if (reasons.length >= 4) controller.abort();
      },
    });

    expect(lines).toBeGreaterThanOrEqual(1);
    // Two failures, then a healthy connection resets the streak — so the fourth
    // exit is failure #1 again and reports no park.
    expect(reasons.slice(0, 2).every((reason) => !reason.includes('parked'))).toBe(true);
    expect(reasons[3]).not.toContain('parked');
  });

  it('gives up without retrying when the device has no address at all', async () => {
    const dir = root();
    const ssh = fakeSsh(dir, 'exit 0');
    const reasons: string[] = [];
    await streamFromPeer({
      device: { ...device(), address: { via: 'manual' } } as DeviceProfile,
      signal: new AbortController().signal,
      command: 'agents sessions watch --json --local',
      sshBin: ssh,
      registryPath: path.join(dir, 'registry.json'),
      onLine: () => false,
      onUnavailable: (reason) => reasons.push(reason),
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('has no address');
  });
});
