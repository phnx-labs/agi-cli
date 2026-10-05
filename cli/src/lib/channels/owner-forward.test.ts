import { afterEach, describe, expect, it } from 'vitest';
import type { Meta } from '../types.js';
import type { SendResult } from './registry.js';
import type { DeviceProfile } from '../devices/registry.js';
import {
  OWNER_FORWARD_GUARD_ENV,
  forwardOwnerNotifyToPeer,
  isRushBackedTransport,
  planOwnerForward,
} from './owner-forward.js';

function device(name: string, platform: DeviceProfile['platform']): DeviceProfile {
  return {
    name,
    platform,
    shell: platform === 'windows' ? 'powershell' : 'posix',
    address: { via: 'manual', dnsName: `${name}.example` },
    auth: { method: 'key' },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function rushOwnerMeta(overrides: Partial<Meta> = {}): Meta {
  return {
    notify: { owner: { channel: 'imessage', to: '+18055551234' } },
    ...overrides,
  } as Meta;
}

describe('isRushBackedTransport', () => {
  it('is true for a rush-family owner channel (macOS-only)', () => {
    expect(isRushBackedTransport('imessage', rushOwnerMeta())).toBe(true);
  });

  it('is false for a Linux-capable transport (openclaw-telegram)', () => {
    const meta = { notify: { transports: { telegram: 'openclaw-telegram' } } } as Meta;
    expect(isRushBackedTransport('telegram', meta)).toBe(false);
  });

  it('follows the notify.transports mapping to a rush channel', () => {
    const meta = { notify: { transports: { owner: 'imessage' } } } as Meta;
    expect(isRushBackedTransport('owner', meta)).toBe(true);
  });
});

describe('planOwnerForward', () => {
  const devices = [
    device('mac-mini', 'macos'),
    device('yosemite-m3', 'linux'),
    device('win-mini', 'windows'),
    device('studio', 'macos'),
  ];

  it('does not forward when guarded (a box that already received a forward)', () => {
    const plan = planOwnerForward('imessage', rushOwnerMeta(), devices, 'yosemite-m3', { guarded: true });
    expect(plan).toEqual({ candidates: [], skip: 'guarded' });
  });

  it('does not forward a Linux-capable transport — no wrong-OS problem to solve', () => {
    const meta = {
      notify: { owner: { channel: 'telegram', to: 'c1' }, transports: { telegram: 'openclaw-telegram' } },
    } as Meta;
    expect(planOwnerForward('telegram', meta, devices, 'yosemite-m3').skip).toBe('not-rush-backed');
  });

  it('selects only macOS peers, excludes self, and lists them as candidates', () => {
    const plan = planOwnerForward('imessage', rushOwnerMeta(), devices, 'yosemite-m3');
    expect(plan.skip).toBeUndefined();
    expect(plan.candidates.sort()).toEqual(['mac-mini', 'studio']);
  });

  it('excludes the calling box even when it is a mac', () => {
    const plan = planOwnerForward('imessage', rushOwnerMeta(), devices, 'mac-mini');
    expect(plan.candidates).toEqual(['studio']);
  });

  it('tries the configured interactive.host first (where rush is signed in)', () => {
    const meta = rushOwnerMeta({ config: { interactiveHost: 'studio' } });
    const plan = planOwnerForward('imessage', meta, devices, 'yosemite-m3');
    expect(plan.candidates[0]).toBe('studio');
    expect(plan.candidates).toContain('mac-mini');
  });

  it('skips a mac whose reachability snapshot says offline', () => {
    const asleep = device('studio', 'macos');
    asleep.tailscale = { online: false, direct: false };
    const plan = planOwnerForward('imessage', rushOwnerMeta(), [device('mac-mini', 'macos'), asleep], 'yosemite-m3');
    expect(plan.candidates).toEqual(['mac-mini']);
  });

  it('reports no-capable-peer when the fleet has no reachable mac', () => {
    const plan = planOwnerForward('imessage', rushOwnerMeta(), [device('yosemite-m3', 'linux')], 'yosemite-m3');
    expect(plan).toEqual({ candidates: [], skip: 'no-capable-peer' });
  });
});

describe('forwardOwnerNotifyToPeer', () => {
  const savedGuard = process.env[OWNER_FORWARD_GUARD_ENV];
  afterEach(() => {
    if (savedGuard === undefined) delete process.env[OWNER_FORWARD_GUARD_ENV];
    else process.env[OWNER_FORWARD_GUARD_ENV] = savedGuard;
  });

  const devices = [device('mac-mini', 'macos'), device('studio', 'macos'), device('yosemite-m3', 'linux')];

  function okResult(machine: string): SendResult {
    return { ok: true, channel: 'imessage', id: `owner-via-${machine}` };
  }
  function failResult(): SendResult {
    return { ok: false, channel: 'imessage', id: '+18055551234', error: 'rush signed out' };
  }

  it('delivers via the first capable peer and stops the sweep', async () => {
    delete process.env[OWNER_FORWARD_GUARD_ENV];
    const tried: string[] = [];
    const meta = rushOwnerMeta({ config: { interactiveHost: 'studio' } });
    const result = await forwardOwnerNotifyToPeer('ping', 'imessage', '+18055551234', meta, {
      self: 'yosemite-m3',
      devices,
      send: async (machine) => {
        tried.push(machine);
        return okResult(machine);
      },
    });
    expect(result?.ok).toBe(true);
    expect(result?.id).toBe('owner-via-studio');
    expect(tried).toEqual(['studio']);
  });

  it('passes portable thread and sender fields to the peer send', async () => {
    delete process.env[OWNER_FORWARD_GUARD_ENV];
    let received: unknown;
    await forwardOwnerNotifyToPeer('ping', 'slack', 'D123', rushOwnerMeta(), {
      self: 'yosemite-m3',
      devices,
      envelope: { thread: 'thread-42', from: 'monitor' },
      send: async (_machine, _text, _channel, _target, envelope) => {
        received = envelope;
        return { ok: true, channel: 'slack', id: 'D123' };
      },
    });
    expect(received).toEqual({ thread: 'thread-42', from: 'monitor' });
  });

  it('skips a peer that reports its own failure and tries the next', async () => {
    delete process.env[OWNER_FORWARD_GUARD_ENV];
    const tried: string[] = [];
    const result = await forwardOwnerNotifyToPeer('ping', 'imessage', '+18055551234', rushOwnerMeta(), {
      self: 'yosemite-m3',
      devices,
      send: async (machine) => {
        tried.push(machine);
        return machine === 'studio' ? okResult(machine) : failResult();
      },
    });
    expect(result?.ok).toBe(true);
    expect(tried).toContain('mac-mini');
    expect(tried).toContain('studio');
  });

  it('returns undefined when every capable peer fails — caller keeps its local error', async () => {
    delete process.env[OWNER_FORWARD_GUARD_ENV];
    const tried: string[] = [];
    const result = await forwardOwnerNotifyToPeer('ping', 'imessage', '+18055551234', rushOwnerMeta(), {
      self: 'yosemite-m3',
      devices,
      send: async (machine) => {
        tried.push(machine);
        return failResult();
      },
    });
    expect(result).toBeUndefined();
    expect(tried.sort()).toEqual(['mac-mini', 'studio']);
  });

  it('returns undefined (never forwards) when no capable peer exists', async () => {
    delete process.env[OWNER_FORWARD_GUARD_ENV];
    let called = false;
    const result = await forwardOwnerNotifyToPeer('ping', 'imessage', '+18055551234', rushOwnerMeta(), {
      self: 'yosemite-m3',
      devices: [device('yosemite-m3', 'linux'), device('win-mini', 'windows')],
      send: async () => {
        called = true;
        return okResult('x');
      },
    });
    expect(result).toBeUndefined();
    expect(called).toBe(false);
  });

  it('does not forward onward from a box that already received a forward (loop guard)', async () => {
    process.env[OWNER_FORWARD_GUARD_ENV] = '1';
    let called = false;
    const result = await forwardOwnerNotifyToPeer('ping', 'imessage', '+18055551234', rushOwnerMeta(), {
      self: 'yosemite-m3',
      devices,
      send: async () => {
        called = true;
        return okResult('x');
      },
    });
    expect(result).toBeUndefined();
    expect(called).toBe(false);
  });
});
