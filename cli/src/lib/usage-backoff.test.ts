import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  formatBackoffRemaining,
  noteUsageRateLimited,
  parseRetryAfterMs,
  setUsageBackoffDirForTest,
  usageRateLimitedUntil,
} from './usage-backoff.js';

const NOW = 1_800_000_000_000;

describe('parseRetryAfterMs', () => {
  it('reads delta-seconds — the form the usage endpoint actually sent', () => {
    expect(parseRetryAfterMs('2678', NOW)).toBe(2678 * 1000);
  });

  it('reads an HTTP-date, the other form the spec allows', () => {
    const at = new Date(NOW + 10 * 60 * 1000).toUTCString();
    expect(parseRetryAfterMs(at, NOW)).toBeGreaterThan(9 * 60 * 1000);
    expect(parseRetryAfterMs(at, NOW)).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it('caps a hostile or mistaken value at an hour', () => {
    expect(parseRetryAfterMs('99999999', NOW)).toBe(60 * 60 * 1000);
  });

  it('returns null for a missing, empty, elapsed, or unparseable header', () => {
    expect(parseRetryAfterMs(null, NOW)).toBeNull();
    expect(parseRetryAfterMs('', NOW)).toBeNull();
    expect(parseRetryAfterMs('0', NOW)).toBeNull();
    expect(parseRetryAfterMs('later please', NOW)).toBeNull();
    expect(parseRetryAfterMs(new Date(NOW - 60_000).toUTCString(), NOW)).toBeNull();
  });
});

describe('the recorded backoff survives across processes', () => {
  let dir: string;
  let prevDir: string | null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-backoff-'));
    prevDir = setUsageBackoffDirForTest(dir);
  });

  afterEach(() => {
    setUsageBackoffDirForTest(prevDir);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes to the overridden dir and NOT the real cache dir', () => {
    noteUsageRateLimited('claude', '2678');
    expect(fs.readdirSync(dir).some((n) => n.startsWith('claude.'))).toBe(true);
  });

  it('holds a provider off for the window the server asked for', () => {
    expect(usageRateLimitedUntil('claude')).toBeNull();

    noteUsageRateLimited('claude', '2678');

    const until = usageRateLimitedUntil('claude');
    expect(until).not.toBeNull();
    expect(until! - Date.now()).toBeGreaterThan(40 * 60 * 1000);
  });

  it('still backs off when the server sends no usable Retry-After', () => {
    noteUsageRateLimited('claude', null);
    expect(usageRateLimitedUntil('claude')).not.toBeNull();
  });

  it('never shortens an existing longer penalty', () => {
    noteUsageRateLimited('claude', '2678');
    const long = usageRateLimitedUntil('claude')!;

    noteUsageRateLimited('claude', '10');

    expect(usageRateLimitedUntil('claude')).toBe(long);
  });

  it('reads as free once the window has elapsed', () => {
    noteUsageRateLimited('claude', '1', { now: Date.now() - 60_000 });
    expect(usageRateLimitedUntil('claude')).toBeNull();
  });

  it('is per-provider — one throttled endpoint does not mute the others', () => {
    noteUsageRateLimited('claude', '2678');
    expect(usageRateLimitedUntil('kimi')).toBeNull();
    expect(usageRateLimitedUntil('droid')).toBeNull();
  });
});

describe('formatBackoffRemaining', () => {
  it('reads like a person wrote it, not a duration serializer', () => {
    expect(formatBackoffRemaining(NOW + 45 * 60 * 1000, NOW)).toBe('45 minutes');
    expect(formatBackoffRemaining(NOW + 30 * 1000, NOW)).toBe('under a minute');
    expect(formatBackoffRemaining(NOW + 60 * 60 * 1000, NOW)).toBe('about an hour');
    expect(formatBackoffRemaining(NOW + 3 * 60 * 60 * 1000, NOW)).toBe('about 3 hours');
  });
});

describe('a shorter deadline cannot displace a longer one', () => {
  let dir: string;
  let prevDir: string | null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-backoff-mono-'));
    prevDir = setUsageBackoffDirForTest(dir);
  });

  afterEach(() => {
    setUsageBackoffDirForTest(prevDir);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('takes the furthest deadline when several are recorded', () => {
    noteUsageRateLimited('claude', '60');
    noteUsageRateLimited('claude', '2678');

    expect(usageRateLimitedUntil('claude')! - Date.now()).toBeGreaterThan(40 * 60 * 1000);
  });

  it('is unaffected by the ORDER they were written in', () => {
    noteUsageRateLimited('claude', '2678');
    const long = usageRateLimitedUntil('claude')!;

    noteUsageRateLimited('claude', '10');

    expect(usageRateLimitedUntil('claude')).toBe(long);
  });

  it('keeps both writers when they land together, rather than losing one', () => {
    noteUsageRateLimited('claude', '2678');
    noteUsageRateLimited('kimi', '600');

    expect(usageRateLimitedUntil('claude')).not.toBeNull();
    expect(usageRateLimitedUntil('kimi')).not.toBeNull();
  });

  it('sweeps elapsed deadlines instead of letting them pile up', () => {
    noteUsageRateLimited('claude', '1', { now: Date.now() - 60_000 });
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('claude.')).length).toBe(1);

    expect(usageRateLimitedUntil('claude')).toBeNull();

    expect(fs.readdirSync(dir).filter((n) => n.startsWith('claude.')).length).toBe(0);
  });
});

describe('per-account backoff scope (RUSH-3036)', () => {
  let dir: string;
  let prevDir: string | null;
  const A = 'claude:org=aaaa-1111';
  const B = 'claude:org=bbbb-2222';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-backoff-acct-'));
    prevDir = setUsageBackoffDirForTest(dir);
  });
  afterEach(() => {
    setUsageBackoffDirForTest(prevDir);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("one account's 429 parks THAT account, not its siblings or the provider", () => {
    const now = 1_000_000;
    noteUsageRateLimited('claude', '3600', { now, account: A });
    expect(usageRateLimitedUntil('claude', now + 1, A)).toBe(now + 3600_000);
    expect(usageRateLimitedUntil('claude', now + 1, B)).toBeNull();
    expect(usageRateLimitedUntil('claude', now + 1)).toBeNull();
  });

  it('a provider-wide penalty still parks every account', () => {
    const now = 2_000_000;
    noteUsageRateLimited('claude', '600', { now });
    expect(usageRateLimitedUntil('claude', now + 1, A)).toBe(now + 600_000);
    expect(usageRateLimitedUntil('claude', now + 1, B)).toBe(now + 600_000);
    expect(usageRateLimitedUntil('claude', now + 1)).toBe(now + 600_000);
  });

  it('account slugs with dots cannot swallow a longer sibling scope', () => {
    const now = 3_000_000;
    noteUsageRateLimited('claude', '600', { now, account: 'x.y' });
    expect(usageRateLimitedUntil('claude', now + 1, 'x')).toBeNull();
    expect(usageRateLimitedUntil('claude', now + 1, 'x.y')).toBe(now + 600_000);
  });

  it('an elapsed account penalty is swept and the account frees up', () => {
    const now = 4_000_000;
    noteUsageRateLimited('claude', '60', { now, account: A });
    expect(usageRateLimitedUntil('claude', now + 61_000, A)).toBeNull();
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });
});
