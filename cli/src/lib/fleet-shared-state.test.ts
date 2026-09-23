import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FLEET_SHARED_STATE_FILE,
  newestPeerReceivedAtMs,
  readFleetSharedDeviceStates,
  storePeerFleetSharedDeviceState,
  updateFleetSharedDeviceState,
} from './fleet-shared-state.js';

const dirs: string[] = [];
function tempStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-fleet-state-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('fleet shared daemon state (real files)', () => {
  it('merges independent usage and auth writers without losing either field', () => {
    const root = tempStore();
    const usage = {
      rows: {
        'claude:org=alpha': {
          capturedAt: '2026-08-30T20:00:00.000Z',
          windows: [{ key: 'five_hour' as const, label: 'Session', shortLabel: 'S', usedPercent: 42, resetsAt: null, windowMinutes: 300 }],
        },
      },
    };

    expect(updateFleetSharedDeviceState('zion', { usage }, root).changed).toBe(true);
    expect(updateFleetSharedDeviceState('zion', { auth: { status: 'ready' } }, root).changed).toBe(true);

    const read = readFleetSharedDeviceStates(root);
    expect(read.errors).toEqual([]);
    expect(read.states).toEqual([{ version: 1, device: 'zion', usage, auth: { status: 'ready' } }]);
  });

  it('carries the session mirror alongside usage/auth without losing a field (PHNX-3792)', () => {
    const root = tempStore();
    const sessions = {
      rows: [{
        id: 'aaaaaaaa-1111-2222-3333-444444444444',
        shortId: 'aaaaaaaa',
        agent: 'claude',
        machine: 'yosemite-m5',
        topic: 'refactor exec',
        firstUser: 'Refactor buildExecEnv.',
        lastActivity: '2026-09-01T12:00:00.000Z',
        timestamp: '2026-09-01T11:00:00.000Z',
        capturedAt: 1_756_000_000_000,
      }],
    };
    expect(updateFleetSharedDeviceState('yosemite-m5', { auth: { status: 'ready' } }, root).changed).toBe(true);
    expect(updateFleetSharedDeviceState('yosemite-m5', { sessions }, root).changed).toBe(true);
    const read = readFleetSharedDeviceStates(root);
    expect(read.errors).toEqual([]);
    expect(read.states).toEqual([{ version: 1, device: 'yosemite-m5', auth: { status: 'ready' }, sessions }]);
    // An unchanged re-publish of the same mirror does not dirty the repo.
    expect(updateFleetSharedDeviceState('yosemite-m5', { sessions }, root).changed).toBe(false);
  });

  it('rejects a session mirror whose envelope is not {rows: [...]}', () => {
    const root = tempStore();
    const dir = path.join(root, 'devices', 'yosemite-m6');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, FLEET_SHARED_STATE_FILE),
      JSON.stringify({ version: 1, device: 'yosemite-m6', sessions: { rows: 'nope' } }),
      'utf-8',
    );
    const read = readFleetSharedDeviceStates(root);
    expect(read.states).toEqual([]);
    expect(read.errors).toEqual([{ device: 'yosemite-m6', message: expect.stringContaining('session mirror') }]);
  });

  it('does not rewrite an unchanged state and isolates a malformed peer', () => {
    const root = tempStore();
    updateFleetSharedDeviceState('worker-a', { auth: { status: 'missing' } }, root);
    const file = path.join(root, 'devices', 'worker-a', FLEET_SHARED_STATE_FILE);
    const before = fs.statSync(file).mtimeMs;
    expect(updateFleetSharedDeviceState('worker-a', { auth: { status: 'missing' } }, root).changed).toBe(false);
    expect(fs.statSync(file).mtimeMs).toBe(before);

    const malformedDir = path.join(root, 'devices', 'worker-b');
    fs.mkdirSync(malformedDir, { recursive: true });
    fs.writeFileSync(path.join(malformedDir, FLEET_SHARED_STATE_FILE), '{broken', 'utf-8');
    const read = readFleetSharedDeviceStates(root);
    expect(read.states.map((state) => state.device)).toEqual(['worker-a']);
    expect(read.errors).toEqual([{ device: 'worker-b', message: expect.stringContaining('JSON') }]);
  });

  it('rejects a file copied into another device owner directory', () => {
    const root = tempStore();
    const dir = path.join(root, 'devices', 'worker-b');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, FLEET_SHARED_STATE_FILE),
      JSON.stringify({ version: 1, device: 'worker-a', auth: { status: 'ready' } }),
      'utf-8',
    );
    expect(readFleetSharedDeviceStates(root)).toMatchObject({
      states: [],
      errors: [{ device: 'worker-b', message: 'unrecognized shared-state envelope' }],
    });
  });
});

describe('peer envelopes received over the exchange (PHNX-4116)', () => {
  it('stores a peer envelope stamped receivedAt, merges field-by-field, and reports the newest stamp', () => {
    const root = tempStore();
    expect(newestPeerReceivedAtMs(root)).toBeNull();
    const first = storePeerFleetSharedDeviceState(
      { version: 1, device: 'peer-b', auth: { status: 'ready' }, accounts: { rows: [{ accountId: 'x' }] } },
      root,
      1_000,
    );
    expect(first).toEqual({ changed: true, path: path.join(root, 'devices', 'peer-b', FLEET_SHARED_STATE_FILE) });
    // A later partial envelope (sessions only) keeps the earlier auth + accounts fields.
    storePeerFleetSharedDeviceState({ version: 1, device: 'peer-b', sessions: { rows: [] } }, root, 2_000);
    storePeerFleetSharedDeviceState({ version: 1, device: 'peer-c' }, root, 1_500);
    const byDevice = Object.fromEntries(readFleetSharedDeviceStates(root).states.map((s) => [s.device, s]));
    expect(byDevice['peer-b']).toEqual({
      version: 1,
      device: 'peer-b',
      auth: { status: 'ready' },
      accounts: { rows: [{ accountId: 'x' }] },
      sessions: { rows: [] },
      receivedAt: 2_000,
    });
    expect(byDevice['peer-c'].receivedAt).toBe(1_500);
    expect(newestPeerReceivedAtMs(root)).toBe(2_000);
    // An unchanged re-store at the same stamp is a no-op write.
    expect(storePeerFleetSharedDeviceState({ version: 1, device: 'peer-c' }, root, 1_500).changed).toBe(false);
  });

  it('rejects a malformed receivedAt or accounts field as a distinct peer error', () => {
    const root = tempStore();
    const dir = path.join(root, 'devices', 'peer-x');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, FLEET_SHARED_STATE_FILE), JSON.stringify({ version: 1, device: 'peer-x', receivedAt: 'yesterday' }), 'utf-8');
    expect(readFleetSharedDeviceStates(root).errors).toEqual([{ device: 'peer-x', message: 'unrecognized receivedAt' }]);
    fs.writeFileSync(path.join(dir, FLEET_SHARED_STATE_FILE), JSON.stringify({ version: 1, device: 'peer-x', accounts: { rows: 'nope' } }), 'utf-8');
    expect(readFleetSharedDeviceStates(root).errors).toEqual([{ device: 'peer-x', message: 'unrecognized account verdict rows' }]);
  });
});
