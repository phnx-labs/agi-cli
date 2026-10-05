import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import {
  validateHetznerToken,
  fmtDurationShort,
  fmtIdleShort,
  fmtExpiresShort,
  boxAddress,
  boxStatus,
  reusableBoxes,
  formatBoxRow,
  registerLeaseCommand,
} from './lease.js';
import type { CrabboxBox } from '../lib/crabbox/cli.js';

const NOW = 1_700_000_000;

describe('lease command registration', () => {
  it('registers every lease verb below devices, not at the top level', () => {
    const program = new Command();
    const devices = program.command('devices');
    registerLeaseCommand(devices);

    expect(program.commands.map((command) => command.name())).toEqual(['devices']);
    expect(devices.commands.map((command) => command.name())).toEqual(['lease']);
    expect(devices.commands[0].commands.map((command) => command.name())).toEqual([
      'setup',
      'list',
      'stop',
      'prune',
    ]);
  });

  it('keeps the old `gc` spelling working as a hidden alias of prune', () => {
    const program = new Command();
    const devices = program.command('devices');
    registerLeaseCommand(devices);

    const prune = devices.commands[0].commands.find((command) => command.name() === 'prune');
    expect(prune?.aliases()).toContain('gc');
  });
});

function box(over: Partial<CrabboxBox> = {}): CrabboxBox {
  return {
    name: 'crabbox-x',
    status: 'running',
    slug: 'x',
    lease: 'cbx_x',
    state: 'ready',
    ready: true,
    keep: false,
    createdAt: NOW - 600,
    expiresAt: NOW + 3600,
    lastTouchedAt: NOW - 120,
    idleTimeoutSecs: 1800,
    ...over,
  };
}

const fakeFetch = (status: number, throws = false): typeof fetch =>
  (async () => {
    if (throws) throw new Error('network down');
    return { ok: status >= 200 && status < 300, status } as Response;
  }) as unknown as typeof fetch;

describe('validateHetznerToken', () => {
  it('returns valid on 200', async () => {
    expect(await validateHetznerToken('t', fakeFetch(200))).toBe('valid');
  });

  it('returns invalid on 401 and 403 (bad/insufficient token)', async () => {
    expect(await validateHetznerToken('t', fakeFetch(401))).toBe('invalid');
    expect(await validateHetznerToken('t', fakeFetch(403))).toBe('invalid');
  });

  it('returns unreachable on an unexpected status', async () => {
    expect(await validateHetznerToken('t', fakeFetch(500))).toBe('unreachable');
  });

  it('returns unreachable when the request throws (offline)', async () => {
    expect(await validateHetznerToken('t', fakeFetch(0, true))).toBe('unreachable');
  });
});

describe('fmtDurationShort', () => {
  it('formats seconds, minutes, and hours; clamps negatives to 0s', () => {
    expect(fmtDurationShort(5)).toBe('5s');
    expect(fmtDurationShort(59)).toBe('59s');
    expect(fmtDurationShort(120)).toBe('2m');
    expect(fmtDurationShort(3600)).toBe('1h');
    expect(fmtDurationShort(3900)).toBe('1h 5m');
    expect(fmtDurationShort(-42)).toBe('0s');
  });
});

describe('fmtIdleShort / fmtExpiresShort', () => {
  it('renders idle from lastTouchedAt and time-left from expiresAt', () => {
    expect(fmtIdleShort(box({ lastTouchedAt: NOW - 300 }), NOW)).toBe('idle 5m');
    expect(fmtIdleShort(box({ lastTouchedAt: null }), NOW)).toBe('idle ?');
    expect(fmtExpiresShort(box({ expiresAt: NOW + 2520 }), NOW)).toBe('expires 42m');
    expect(fmtExpiresShort(box({ expiresAt: null }), NOW)).toBe('expires ?');
    expect(fmtExpiresShort(box({ expiresAt: NOW - 10 }), NOW)).toBe('expired');
  });
});

describe('boxAddress', () => {
  it('prefers tailnet FQDN, then tailnet IPv4, then public IP', () => {
    expect(boxAddress(box({ tailscaleFQDN: 'x.ts.net', tailscaleIPv4: '100.1.1.1', ip: '203.0.113.9' }))).toBe('x.ts.net');
    expect(boxAddress(box({ tailscaleFQDN: undefined, tailscaleIPv4: '100.1.1.1', ip: '203.0.113.9' }))).toBe('100.1.1.1');
    expect(boxAddress(box({ tailscaleFQDN: undefined, tailscaleIPv4: undefined, ip: '203.0.113.9' }))).toBe('203.0.113.9');
    expect(boxAddress(box({ tailscaleFQDN: undefined, tailscaleIPv4: undefined, ip: undefined }))).toBeUndefined();
  });
});

describe('boxStatus', () => {
  it('is "ready" when usable, else the raw bootstrap state', () => {
    expect(boxStatus(box({ ready: true }))).toBe('ready');
    expect(boxStatus(box({ ready: false, state: 'provisioning' }))).toBe('provisioning');
  });
});

describe('reusableBoxes', () => {
  it('keeps only ready + unexpired boxes, most-recently-touched first', () => {
    const ready1 = box({ slug: 'a', ready: true, lastTouchedAt: NOW - 500 });
    const readyFresh = box({ slug: 'b', ready: true, lastTouchedAt: NOW - 10 });
    const notReady = box({ slug: 'c', ready: false, state: 'provisioning' });
    const expired = box({ slug: 'd', ready: true, expiresAt: NOW - 1 });
    const neverExpires = box({ slug: 'e', ready: true, expiresAt: null, lastTouchedAt: NOW - 9999 });
    const out = reusableBoxes([ready1, readyFresh, notReady, expired, neverExpires], NOW);
    expect(out.map((b) => b.slug)).toEqual(['b', 'a', 'e']);
  });
});

describe('formatBoxRow', () => {
  it('includes slug, class, address, status, idle, and expires', () => {
    const row = formatBoxRow(
      box({ slug: 'blue-hermit', class: 'cpu-4', tailscaleFQDN: 'bh.ts.net', lastTouchedAt: NOW - 60, expiresAt: NOW + 600 }),
      NOW,
    );
    expect(row).toContain('blue-hermit');
    expect(row).toContain('cpu-4');
    expect(row).toContain('bh.ts.net');
    expect(row).toContain('ready');
    expect(row).toContain('idle 1m');
    expect(row).toContain('expires 10m');
  });
});
