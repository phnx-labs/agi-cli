import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as secretsClient from '../secrets-client.js';
import * as stateModule from '../state.js';
import {
  isReapSafe,
  reapSafeOrphans,
  REAP_MIN_IDLE_SECS,
  pickLeaseBundleFromList,
  pickTailscaleBundleFromList,
  crabboxEnv,
  crabboxList,
  crabboxStatusReady,
  crabboxWarmup,
  crabboxWaitReady,
  parseCrabboxSshArgv,
  poolReusableBoxes,
  resetCrabboxSecretsMemosForTest,
  type CrabboxBox,
} from './cli.js';
import type { SecretsBundle } from '../secrets-types.js';

// Suites that stand up a fake `crabbox` on PATH are POSIX-only: the fake is a
// `#!/bin/sh` script with no .cmd/.exe extension, which Windows can neither
// resolve nor execute, so findCrabbox (cli.ts:74) throws "crabbox is not
// installed or not on PATH" before the behavior under test runs. The
// pure-function suites in this file still run everywhere.
const describePosix = describe.skipIf(process.platform === 'win32');
// Same POSIX-only guard for a single test that stands up a fake `crabbox` on PATH.
const itPosix = it.skipIf(process.platform === 'win32');

/**
 * Hermetic lease-bundle resolution for suites that call crabboxList / crabboxWarmup
 * / crabboxEnv but do not care about secrets. Without this, crabboxEnv auto-detects
 * the DEVELOPER's real provider-token bundle (e.g. a locked `hetzner.com`), and the
 * agentOnly read throws "not unlocked" (SEC-13) — a dev-machine-only failure that
 * has nothing to do with the box parsing / warmup argv under test. Pinning readMeta
 * → {} and the process client's listBundlesSync → [] makes resolveLeaseBundle find
 * nothing, so crabboxEnv injects no lease token (and never spawns the standalone);
 * resetting the memos keeps it isolated per test.
 */
function installHermeticLease(): void {
  beforeEach(() => {
    resetCrabboxSecretsMemosForTest();
    vi.spyOn(stateModule, 'readMeta').mockReturnValue({} as ReturnType<typeof stateModule.readMeta>);
    vi.spyOn(secretsClient, 'listBundlesSync').mockReturnValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetCrabboxSecretsMemosForTest();
  });
}

describe('pickLeaseBundleFromList', () => {
  const bundle = (name: string, keys: string[]): SecretsBundle =>
    ({ name, vars: Object.fromEntries(keys.map((k) => [k, 'x'])) }) as SecretsBundle;

  it('picks the first bundle that declares a provider token key', () => {
    const bundles = [bundle('misc', ['OPENAI_API_KEY']), bundle('hetzner.com', ['HCLOUD_TOKEN'])];
    expect(pickLeaseBundleFromList(bundles)).toBe('hetzner.com');
  });

  it('matches AWS and DigitalOcean token keys too', () => {
    expect(pickLeaseBundleFromList([bundle('aws', ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'])])).toBe('aws');
    expect(pickLeaseBundleFromList([bundle('do', ['DIGITALOCEAN_TOKEN'])])).toBe('do');
  });

  it('ignores bundles with no provider token key', () => {
    expect(pickLeaseBundleFromList([bundle('misc', ['OPENAI_API_KEY', 'FOO'])])).toBeUndefined();
  });

  it('returns undefined for an empty list', () => {
    expect(pickLeaseBundleFromList([])).toBeUndefined();
  });

  it('returns the first match in list order (deterministic)', () => {
    const bundles = [bundle('a', ['HCLOUD_TOKEN']), bundle('b', ['HCLOUD_TOKEN'])];
    expect(pickLeaseBundleFromList(bundles)).toBe('a');
  });
});

describe('pickTailscaleBundleFromList', () => {
  const bundle = (name: string, keys: string[]): SecretsBundle =>
    ({ name, vars: Object.fromEntries(keys.map((k) => [k, 'x'])) }) as SecretsBundle;

  it('picks the first bundle + key that declares a tailscale auth key', () => {
    const bundles = [bundle('misc', ['OPENAI_API_KEY']), bundle('tailnet', ['CRABBOX_TAILSCALE_AUTH_KEY'])];
    expect(pickTailscaleBundleFromList(bundles)).toEqual({ name: 'tailnet', key: 'CRABBOX_TAILSCALE_AUTH_KEY' });
  });

  it('accepts the common alternate key names', () => {
    expect(pickTailscaleBundleFromList([bundle('a', ['TS_AUTHKEY'])])).toEqual({ name: 'a', key: 'TS_AUTHKEY' });
    expect(pickTailscaleBundleFromList([bundle('b', ['TAILSCALE_AUTH_KEY'])])).toEqual({
      name: 'b',
      key: 'TAILSCALE_AUTH_KEY',
    });
  });

  it('returns undefined when no bundle declares one', () => {
    expect(pickTailscaleBundleFromList([bundle('misc', ['HCLOUD_TOKEN'])])).toBeUndefined();
    expect(pickTailscaleBundleFromList([])).toBeUndefined();
  });
});

const REAL_BIN = process.env.AGENTS_TEST_SECRETS_BIN;

/**
 * crabbox's lease + tailscale secrets reads now resolve through the standalone
 * `secrets` process client (PHNX-3989), so these exercise the REAL standalone
 * `secrets __serve` — no mocks (repo rule) — gated on AGENTS_TEST_SECRETS_BIN
 * exactly like secrets-client.test.ts; with it unset the block skips cleanly, so
 * CI (which has no standalone checkout) stays green.
 *
 * A spawn-counting wrapper on $SECRETS_BIN is the seam that proves crabbox's
 * process-lifetime memo: `crabboxEnv` runs on every crabboxWaitReady poll, so the
 * token must resolve ONCE and be served from the memo after — otherwise a lease
 * spends a `secrets __serve` spawn per poll (the per-poll storm the memo kills, now
 * a process spawn per read, not merely a keychain hit). The wrapper appends a line
 * per invocation, then execs the real bin, so the spawn count must not climb across
 * the repeated crabboxEnv calls.
 */
describe.skipIf(!REAL_BIN)('crabboxEnv secrets reads via the standalone client', () => {
  const ENV_KEYS = [
    'AGENTS_LEASE_SECRETS_BUNDLE',
    'CRABBOX_TAILSCALE_AUTH_KEY',
    'SECRETS_BIN',
    'SECRETS_REAL_BIN',
    'SECRETS_SPAWN_LOG',
    'HOME',
    'SECRETS_HOME',
    'AGENTS_SECRETS_PASSPHRASE',
    'SECRETS_NO_AGENT',
  ] as const;
  let saved: Record<string, string | undefined>;
  let home: string;
  let wrapperDir: string;
  let spawnLog: string;

  /** How many times the standalone `secrets` binary has been spawned so far. */
  const spawns = (): number => {
    try {
      return fs.readFileSync(spawnLog, 'utf-8').split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  };

  /** Write a real file-backend bundle + its items through the standalone client. */
  async function seedFileBundle(name: string, vars: Record<string, string>): Promise<void> {
    const bundle = {
      name,
      backend: 'file',
      vars: Object.fromEntries(Object.keys(vars).map((k) => [k, `keychain:${k}`])),
    } as SecretsBundle;
    const items = new Map(Object.entries(vars).map(([k, v]) => [`agents-cli.secrets.${name}.${k}`, v]));
    await secretsClient.writeBundleWithItems(bundle, items);
    // Seeding used the client (and its memos); start the crabbox read memos fresh so
    // the spawn count reflects only the crabboxEnv reads under test.
    resetCrabboxSecretsMemosForTest();
    fs.writeFileSync(spawnLog, '', 'utf-8');
  }

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ['AGENTS_LEASE_SECRETS_BUNDLE', 'CRABBOX_TAILSCALE_AUTH_KEY']) delete process.env[k];
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'crabbox-secrets-'));
    wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabbox-secrets-wrap-'));
    spawnLog = path.join(wrapperDir, 'spawns.log');
    fs.writeFileSync(spawnLog, '', 'utf-8');
    // A counting wrapper that records each spawn, then execs the real standalone —
    // the real dependency still runs, we just observe how often it is invoked.
    const wrapper = path.join(wrapperDir, 'secrets');
    fs.writeFileSync(
      wrapper,
      [
        '#!/bin/sh',
        'printf "x\\n" >> "$SECRETS_SPAWN_LOG"',
        'case "$SECRETS_REAL_BIN" in',
        '  *.js|*.mjs|*.cjs) exec node "$SECRETS_REAL_BIN" "$@" ;;',
        '  *) exec "$SECRETS_REAL_BIN" "$@" ;;',
        'esac',
      ].join('\n'),
      'utf-8',
    );
    fs.chmodSync(wrapper, 0o755);
    process.env.SECRETS_BIN = wrapper;
    process.env.SECRETS_REAL_BIN = REAL_BIN!;
    process.env.SECRETS_SPAWN_LOG = spawnLog;
    process.env.HOME = home; // the standalone file store lives under $HOME/.agents/.cache/secrets
    process.env.SECRETS_HOME = path.join(home, '.agents');
    process.env.AGENTS_SECRETS_PASSPHRASE = 'test-passphrase'; // file-backend key, bridged to SECRETS_PASSPHRASE
    process.env.SECRETS_NO_AGENT = '1'; // no broker in the test env
    secretsClient._resetSecretsClientForTest();
    resetCrabboxSecretsMemosForTest();
    // No configured lease.secretsBundle from a developer agents.yaml.
    vi.spyOn(stateModule, 'readMeta').mockReturnValue({} as ReturnType<typeof stateModule.readMeta>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    secretsClient._resetSecretsClientForTest();
    resetCrabboxSecretsMemosForTest();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(wrapperDir, { recursive: true, force: true });
  });

  it('resolves an explicit lease bundle once and injects the provider token, serving the memo after', async () => {
    await seedFileBundle('hetzner.com', { HCLOUD_TOKEN: 'tok-once' });

    const env1 = crabboxEnv({ secretsBundle: 'hetzner.com' });
    const afterFirst = spawns();
    const env2 = crabboxEnv({ secretsBundle: 'hetzner.com' });
    const env3 = crabboxEnv({ secretsBundle: 'hetzner.com' });

    expect(env1.HCLOUD_TOKEN).toBe('tok-once');
    expect(env2.HCLOUD_TOKEN).toBe('tok-once');
    expect(env3.HCLOUD_TOKEN).toBe('tok-once');
    // The real read went over the wire to the standalone...
    expect(afterFirst).toBeGreaterThan(0);
    // ...and it resolved ONCE: the loop-repeated crabboxEnv calls serve the memo, so
    // the spawn count does not climb across env2/env3.
    expect(spawns()).toBe(afterFirst);
  });

  it('reads a tailscale auth key at most once across repeated crabboxEnv calls', async () => {
    await seedFileBundle('tailnet', { TS_AUTHKEY: 'tskey-once' });

    const env1 = crabboxEnv({});
    const afterFirst = spawns();
    const env2 = crabboxEnv({});
    const env3 = crabboxEnv({});

    expect(env1.CRABBOX_TAILSCALE_AUTH_KEY).toBe('tskey-once');
    expect(env2.CRABBOX_TAILSCALE_AUTH_KEY).toBe('tskey-once');
    expect(env3.CRABBOX_TAILSCALE_AUTH_KEY).toBe('tskey-once');
    expect(afterFirst).toBeGreaterThan(0);
    expect(spawns()).toBe(afterFirst); // the memo serves the repeats — no re-spawn
  });

  it('wraps a failed lease read in the actionable crabbox message, memoizes it, and re-raises without re-reading', () => {
    // No bundle seeded: the standalone fails the read, crabbox wraps + memoizes it.
    // SEC-13 agentOnly enforcement now lives in the standalone; crabbox's contract
    // here is to fail loud with the "unset lease.secretsBundle" hint and NOT re-read.
    expect(() => crabboxEnv({ secretsBundle: 'no-such-bundle' })).toThrow(
      /Could not load secrets bundle "no-such-bundle" for crabbox/,
    );
    const afterFirst = spawns();
    // The memoized error re-raises on repeat calls WITHOUT re-issuing the read, so a
    // poll loop cannot re-storm it.
    expect(() => crabboxEnv({ secretsBundle: 'no-such-bundle' })).toThrow(/for crabbox/);
    expect(() => crabboxEnv({ secretsBundle: 'no-such-bundle' })).toThrow(/for crabbox/);
    expect(spawns()).toBe(afterFirst);
  });

  itPosix('a failed lease read propagates out of crabboxWaitReady before the poll loop runs', async () => {
    // crabboxWaitReady's first action is crabboxFind -> crabboxList -> crabboxEnv,
    // which throws synchronously for an unresolvable bundle. A fake `crabbox` on PATH
    // makes findCrabbox() pass so crabboxEnv is the thing that throws. The injected
    // `sleep` records any poll iteration; assert it is NEVER called.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabbox-lease-fail-'));
    fs.writeFileSync(
      path.join(dir, 'crabbox'),
      ['#!/bin/sh', 'case "$1" in', '  --help) exit 0 ;;', '  *) echo "[]" ; exit 0 ;;', 'esac'].join('\n'),
      'utf-8',
    );
    fs.chmodSync(path.join(dir, 'crabbox'), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
    let polls = 0;
    const sleep = async () => { polls++; };
    try {
      await expect(
        crabboxWaitReady('some-slug', { secretsBundle: 'no-such-bundle', timeoutMs: 60_000, intervalMs: 5_000, sleep }),
      ).rejects.toThrow(/Could not load secrets bundle "no-such-bundle" for crabbox/);
      expect(polls).toBe(0); // never entered the poll/sleep loop
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const NOW = 1_800_000_000; // fixed "now" in unix seconds

function box(over: Partial<CrabboxBox> = {}): CrabboxBox {
  return {
    name: 'crabbox-x',
    status: 'running',
    slug: 'x',
    lease: 'cbx_x',
    state: 'ready',
    ready: true,
    keep: true,
    createdAt: NOW - 10_000,
    expiresAt: NOW - 8_000, // expired by default
    lastTouchedAt: NOW - REAP_MIN_IDLE_SECS - 100, // stale by default
    idleTimeoutSecs: 1800,
    ...over,
  };
}

describe('isReapSafe', () => {
  it('reaps a genuine orphan: expired lease AND stale touch', () => {
    expect(isReapSafe(box(), NOW)).toBe(true);
  });

  it('never reaps a box touched within the safety window (TOCTOU guard)', () => {
    // Expired lease, but touched 1 minute ago → a concurrent run may be using it.
    expect(isReapSafe(box({ lastTouchedAt: NOW - 60 }), NOW)).toBe(false);
  });

  it('never reaps a box whose lease has not expired', () => {
    expect(isReapSafe(box({ expiresAt: NOW + 1_000 }), NOW)).toBe(false);
  });

  it('honors max(2×idleTimeout, 1h): a long idle-timeout widens the window', () => {
    // idleTimeout 40m → window = 80m. Touched 70m ago is still inside it.
    const b = box({ idleTimeoutSecs: 2400, lastTouchedAt: NOW - 70 * 60 });
    expect(isReapSafe(b, NOW)).toBe(false);
    // Touched 90m ago is outside the 80m window.
    expect(isReapSafe(box({ idleTimeoutSecs: 2400, lastTouchedAt: NOW - 90 * 60 }), NOW)).toBe(true);
  });

  it('never reaps a box with unknown age (null expiresAt or lastTouchedAt)', () => {
    expect(isReapSafe(box({ expiresAt: null }), NOW)).toBe(false);
    expect(isReapSafe(box({ lastTouchedAt: null }), NOW)).toBe(false);
  });
});

describe('reapSafeOrphans', () => {
  it('filters to orphans and sorts most-stale first', () => {
    const fresh = box({ slug: 'fresh', lastTouchedAt: NOW - 30 });          // in use
    const active = box({ slug: 'active', expiresAt: NOW + 500 });           // lease live
    const oldOrphan = box({ slug: 'old', lastTouchedAt: NOW - 100_000 });
    const newOrphan = box({ slug: 'new', lastTouchedAt: NOW - REAP_MIN_IDLE_SECS - 10 });
    const out = reapSafeOrphans([fresh, active, newOrphan, oldOrphan], NOW);
    expect(out.map((b) => b.slug)).toEqual(['old', 'new']); // oldest touch first, in-use/active excluded
  });

  it('returns empty when nothing is reap-safe', () => {
    expect(reapSafeOrphans([box({ expiresAt: NOW + 1 })], NOW)).toEqual([]);
  });
});

describe('poolReusableBoxes', () => {
  // A pool-eligible baseline: running, unexpired, public net, no profile label.
  const warm = (over: Partial<CrabboxBox> = {}): CrabboxBox =>
    box({ expiresAt: NOW + 3_600, lastTouchedAt: NOW - 60, ...over });

  it('matches a running, unexpired box on the same profile + netMode', () => {
    const out = poolReusableBoxes([warm({ slug: 'a', profile: 'agents-cli' })], {
      profile: 'agents-cli',
      nowSecs: NOW,
    });
    expect(out.map((b) => b.slug)).toEqual(['a']);
  });

  it('normalizes an unset profile to default on BOTH sides (sandbox.sh parity)', () => {
    // A run with no .crabbox.yaml profile matches a box with no profile label…
    expect(poolReusableBoxes([warm({ slug: 'a' })], { nowSecs: NOW })).toHaveLength(1);
    // …and a box crabbox explicitly labeled 'default'.
    expect(
      poolReusableBoxes([warm({ slug: 'b', profile: 'default' })], { nowSecs: NOW }),
    ).toHaveLength(1);
    // A box labeled 'default' does NOT match a named-profile run.
    expect(
      poolReusableBoxes([warm({ slug: 'c', profile: 'default' })], { profile: 'agents-cli', nowSecs: NOW }),
    ).toHaveLength(0);
  });

  it('skips a box on a different profile', () => {
    expect(
      poolReusableBoxes([warm({ profile: 'other-repo' })], { profile: 'agents-cli', nowSecs: NOW }),
    ).toEqual([]);
  });

  it('never hands a tailnet box to a public run, nor a public box to a tailnet run', () => {
    const tailnet = warm({ slug: 'ts', tailscaleIPv4: '100.64.0.1' });
    expect(poolReusableBoxes([tailnet], { nowSecs: NOW })).toEqual([]);
    expect(poolReusableBoxes([tailnet], { netMode: 'tailscale', nowSecs: NOW })).toHaveLength(1);
    const pub = warm({ slug: 'pub' });
    expect(poolReusableBoxes([pub], { netMode: 'tailscale', nowSecs: NOW })).toEqual([]);
  });

  it('skips non-running and expired boxes', () => {
    expect(poolReusableBoxes([warm({ status: 'off' })], { nowSecs: NOW })).toEqual([]);
    expect(poolReusableBoxes([warm({ expiresAt: NOW - 1 })], { nowSecs: NOW })).toEqual([]);
    // An unknown expiry is treated as live (same as reusableBoxes).
    expect(poolReusableBoxes([warm({ expiresAt: null })], { nowSecs: NOW })).toHaveLength(1);
  });

  it('does not gate on the list `state` label — sshd readiness is the caller’s check', () => {
    // sandbox.sh's running_slugs_for_profile filters on status only; a box whose
    // state label lags is still a candidate, gated later by crabboxStatusReady.
    const out = poolReusableBoxes([warm({ state: 'booting', ready: false })], { nowSecs: NOW });
    expect(out).toHaveLength(1);
  });

  it('sorts most-recently-touched first', () => {
    const out = poolReusableBoxes(
      [warm({ slug: 'stale', lastTouchedAt: NOW - 900 }), warm({ slug: 'hot', lastTouchedAt: NOW - 5 })],
      { nowSecs: NOW },
    );
    expect(out.map((b) => b.slug)).toEqual(['hot', 'stale']);
  });
});

describePosix('crabboxStatusReady', () => {
  function withStatusCrabbox(stdout: string, fn: () => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabbox-status-'));
    fs.writeFileSync(
      path.join(dir, 'crabbox'),
      [
        '#!/bin/sh',
        'case "$1" in',
        '  --help) exit 0 ;;',
        `  status) cat <<'EOF'\n${stdout}\nEOF\n    exit 0 ;;`,
        '  *) exit 1 ;;',
        'esac',
      ].join('\n'),
      'utf-8',
    );
    fs.chmodSync(path.join(dir, 'crabbox'), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
    try {
      fn();
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('is true only when the status output carries ready=true', () => {
    withStatusCrabbox('lease cbx_x\nready=true\nssh_port=2222\n', () => {
      expect(crabboxStatusReady('x')).toBe(true);
    });
    withStatusCrabbox('lease cbx_x\nready=false\n', () => {
      expect(crabboxStatusReady('x')).toBe(false);
    });
  });

  it('does not match a ready=true substring inside another token', () => {
    withStatusCrabbox('bootstrap_ready=true\nready=pending\n', () => {
      expect(crabboxStatusReady('x')).toBe(false);
    });
  });
});

describePosix('normalizeBox tailscale fields (via crabboxList)', () => {
  installHermeticLease();
  function withFakeCrabbox(listJson: unknown, fn: (dir: string) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabbox-ts-'));
    const listPath = path.join(dir, 'boxes.json');
    fs.writeFileSync(listPath, JSON.stringify(listJson), 'utf-8');
    fs.writeFileSync(
      path.join(dir, 'crabbox'),
      ['#!/bin/sh', 'case "$1" in', '  --help) exit 0 ;;', '  list) cat "$CRABBOX_LIST"; exit 0 ;;', '  *) exit 1 ;;', 'esac'].join('\n'),
      'utf-8',
    );
    fs.chmodSync(path.join(dir, 'crabbox'), 0o755);
    const oldPath = process.env.PATH;
    const oldList = process.env.CRABBOX_LIST;
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
    process.env.CRABBOX_LIST = listPath;
    try {
      fn(dir);
    } finally {
      process.env.PATH = oldPath;
      if (oldList === undefined) delete process.env.CRABBOX_LIST;
      else process.env.CRABBOX_LIST = oldList;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('parses tailscale_ipv4 / tailscale_fqdn from the box labels', () => {
    withFakeCrabbox(
      [
        {
          name: 'crabbox-tailnet',
          status: 'running',
          labels: {
            slug: 'tailnet-one',
            lease: 'cbx_ts',
            state: 'ready',
            tailscale_ipv4: '100.101.102.103',
            tailscale_fqdn: 'tailnet-one.tail1234.ts.net',
          },
          public_net: { ipv4: { ip: '203.0.113.9' } },
        },
      ],
      () => {
        const boxes = crabboxList();
        expect(boxes).toHaveLength(1);
        expect(boxes[0].tailscaleIPv4).toBe('100.101.102.103');
        expect(boxes[0].tailscaleFQDN).toBe('tailnet-one.tail1234.ts.net');
        expect(boxes[0].ip).toBe('203.0.113.9');
      },
    );
  });

  it('leaves tailscale fields undefined for a public-network box', () => {
    withFakeCrabbox(
      [{ name: 'crabbox-pub', status: 'running', labels: { slug: 'pub', lease: 'cbx_p', state: 'ready' } }],
      () => {
        const [b] = crabboxList();
        expect(b.tailscaleIPv4).toBeUndefined();
        expect(b.tailscaleFQDN).toBeUndefined();
      },
    );
  });
});

describePosix('crabboxList timeout — a slow provider never hangs an ambient command', () => {
  installHermeticLease();
  it('throws (does not hang) when `crabbox list` exceeds timeoutMs', () => {
    // Fake crabbox: --help is instant (findCrabbox passes), `list` blocks 30s.
    // With timeoutMs=400 the spawn is killed and we throw a clear message fast —
    // this is what keeps `agents devices` / `agents ssh <typo>` from blocking on
    // a slow/unreachable provider API.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabbox-slow-'));
    fs.writeFileSync(
      path.join(dir, 'crabbox'),
      ['#!/bin/sh', 'case "$1" in', '  --help) exit 0 ;;', '  list) sleep 30 ;;', '  *) exit 1 ;;', 'esac'].join('\n'),
      'utf-8',
    );
    fs.chmodSync(path.join(dir, 'crabbox'), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
    const startedAt = Date.now();
    try {
      expect(() => crabboxList({ timeoutMs: 400 })).toThrow(/timed out/);
      expect(Date.now() - startedAt).toBeLessThan(5000); // killed near the bound, not after 30s
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describePosix('crabboxWarmup netMode', () => {
  installHermeticLease();
  // A fake crabbox that records argv for `warmup` and returns a fresh box on `list`.
  function withRecordingCrabbox(fn: (log: string) => Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabbox-warm-'));
    const log = path.join(dir, 'crabbox.log');
    const before = path.join(dir, 'before.json');
    const after = path.join(dir, 'after.json');
    fs.writeFileSync(before, JSON.stringify([]), 'utf-8');
    fs.writeFileSync(
      after,
      JSON.stringify([
        { name: 'crabbox-new', status: 'running', labels: { slug: 'new', lease: 'cbx_new', state: 'ready' } },
      ]),
      'utf-8',
    );
    // list returns `before` until warmup runs (which flips a marker file), then `after`.
    fs.writeFileSync(
      path.join(dir, 'crabbox'),
      [
        '#!/bin/sh',
        'printf "%s\\n" "$*" >> "$CRABBOX_LOG"',
        'case "$1" in',
        '  --help) exit 0 ;;',
        '  warmup) touch "$CRABBOX_DIR/warmed"; echo "leased cbx_new"; exit 0 ;;',
        '  list) if [ -f "$CRABBOX_DIR/warmed" ]; then cat "$CRABBOX_DIR/after.json"; else cat "$CRABBOX_DIR/before.json"; fi; exit 0 ;;',
        '  *) exit 1 ;;',
        'esac',
      ].join('\n'),
      'utf-8',
    );
    fs.chmodSync(path.join(dir, 'crabbox'), 0o755);
    const old = { PATH: process.env.PATH, CRABBOX_LOG: process.env.CRABBOX_LOG, CRABBOX_DIR: process.env.CRABBOX_DIR };
    process.env.PATH = `${dir}${path.delimiter}${old.PATH ?? ''}`;
    process.env.CRABBOX_LOG = log;
    process.env.CRABBOX_DIR = dir;
    return fn(log).finally(() => {
      for (const [k, v] of Object.entries(old)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  it('adds --network tailscale and -tailscale-tags for a tailscale lease', async () => {
    await withRecordingCrabbox(async (log) => {
      const box = await crabboxWarmup({ netMode: 'tailscale' });
      expect(box.slug).toBe('new');
      const warmupLine = fs.readFileSync(log, 'utf-8').split('\n').find((l) => l.startsWith('warmup'));
      expect(warmupLine).toContain('--network tailscale');
      expect(warmupLine).toContain('-tailscale-tags tag:crabbox');
    });
  });

  it('omits tailscale flags for the default public lease', async () => {
    await withRecordingCrabbox(async (log) => {
      await crabboxWarmup({});
      const warmupLine = fs.readFileSync(log, 'utf-8').split('\n').find((l) => l.startsWith('warmup'));
      expect(warmupLine).not.toContain('tailscale');
    });
  });
});

describe('parseCrabboxSshArgv', () => {
  it('parses the shell-quoted ssh command crabbox emits (key + endpoint)', () => {
    const out = `lease cbx_x is claimed\n'ssh' '-i' '/home/u/.config/crabbox/testboxes/cbx_x/id_ed25519' '-o' 'IdentitiesOnly=yes' '-p' '2222' 'crabbox@157.90.242.199'\n`;
    const argv = parseCrabboxSshArgv(out);
    expect(argv?.[0]).toBe('ssh');
    expect(argv).toContain('/home/u/.config/crabbox/testboxes/cbx_x/id_ed25519');
    expect(argv?.[argv.length - 1]).toBe('crabbox@157.90.242.199');
  });

  it('returns null when no ssh command line is present', () => {
    expect(parseCrabboxSshArgv('lease not found\nsome error\n')).toBeNull();
  });
});
