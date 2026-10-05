/** Benchmark for the `--device` dispatch hot path: host resolution and the pure SSH command
 * builders. It seeds its own fork-private 14-device registry because tests/setup.ts empties the
 * real one. Not in `vitest run`; run by hand with `npx vitest bench --run dispatch.bench.ts`. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, bench } from 'vitest';
import type { DispatchOptions } from './dispatch.js';

// state.ts getDevicesDir() reads this at call time, so reassigning it repoints loadDevices() at a
// registry this file controls.
const BENCH_DEVICES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-hosts-bench-devices-'));
process.env.AGENTS_DEVICES_DIR = BENCH_DEVICES_DIR;

const PLATFORMS = ['macos', 'linux', 'windows'] as const;
const DEVICE_COUNT = 14;
const seededRegistry: Record<string, unknown> = {};
for (let i = 0; i < DEVICE_COUNT; i++) {
  const name = `bench-device-${i}`;
  const platform = PLATFORMS[i % PLATFORMS.length];
  seededRegistry[name] = {
    name,
    platform,
    shell: platform === 'windows' ? 'powershell' : 'posix',
    user: 'bench',
    address: { via: 'tailscale', dnsName: `${name}.tailnet-bench.ts.net`, ip: `100.64.0.${i + 1}` },
    auth: { method: 'key' },
    tailscale: { online: true, direct: i % 2 === 0, relay: i % 2 === 0 ? undefined : 'sfo', lastSeen: '2026-01-01T00:00:00Z' },
    reachability: { reachable: true, via: 'tailscale', checkedAt: '2026-01-01T00:00:00Z' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}
fs.mkdirSync(BENCH_DEVICES_DIR, { recursive: true });
fs.writeFileSync(path.join(BENCH_DEVICES_DIR, 'registry.json'), JSON.stringify(seededRegistry, null, 2));

const { matchHost, resolveHost } = await import('./registry.js');
const { resolveRemoteOsSync } = await import('./remote-os.js');
const {
  buildRunForwardedArgs,
  remoteCdPrefix,
  buildDetachedLaunchCommand,
  withActorEnv,
  remoteRunShellPrelude,
} = await import('./dispatch.js');
const { loadDevices, loadDevicesSync } = await import('../devices/registry.js');
const { readMeta } = await import('../state.js');
const { isSshConfigHost } = await import('./ssh-config.js');

const REAL_DEVICE_NAME = 'bench-device-0';
const ALL_DEVICE_NAMES = Array.from({ length: DEVICE_COUNT }, (_, i) => `bench-device-${i}`);

describe('matchHost / resolveHost — device resolution (registry.ts:196, :296)', () => {
  bench(`matchHost: registered device short-circuit ("${REAL_DEVICE_NAME}")`, async () => {
    await matchHost(REAL_DEVICE_NAME);
  });

  bench(`resolveHost: same device, plus control/password/address checks (registry.ts:296)`, async () => {
    await resolveHost(REAL_DEVICE_NAME);
  });
});

describe('matchHost — miss path (worst case: device miss -> overlay miss -> real ~/.ssh/config scan -> null)', () => {
  bench('matchHost: bare name matching nothing (loadDevices + readMeta + isSshConfigHost all pay, registry.ts:217-236)', async () => {
    await matchHost('agents-cli-bench-nonexistent-host-zzz');
  });

  bench('matchHost: ad-hoc user@literal (skips the ssh-config scan; still pays loadDevices + readMeta, registry.ts:241-243)', async () => {
    await matchHost('bench-user@203.0.113.5');
  });
});

describe('loadDevices / loadDevicesSync — UNCACHED read+JSON.parse of the whole registry file (devices/registry.ts:255, :279)', () => {
  bench('loadDevices (async, fs.readFile) — every matchHost call pays this fresh, no mtime cache unlike readMeta', async () => {
    await loadDevices();
  });

  bench('loadDevicesSync (fs.readFileSync) — resolveRemoteOsSync pays this fresh on every call too', () => {
    loadDevicesSync();
  });
});

describe('resolveRemoteOsSync — UNCACHED loadDevicesSync call (remote-os.ts:21)', () => {
  bench(`resolveRemoteOsSync("${REAL_DEVICE_NAME}") — re-reads + re-parses the registry file every call, called once in matchHost's ssh-config branch and again in dispatch.ts:339 launchDetached when host.os is undefined`, () => {
    resolveRemoteOsSync(REAL_DEVICE_NAME);
  });
});

describe('readMeta vs isSshConfigHost — the CACHED overlay lookup next to the UNCACHED ssh-config scan (state.ts:1124, ssh-config.ts:117)', () => {
  bench('readMeta() — mtime-cached (state.ts:1130-1134); this box has no top-level `hosts:` overlay so every matchHost overlay lookup is a real miss', () => {
    readMeta();
  });

  bench('isSshConfigHost("agents-cli-bench-nonexistent-host-zzz") — fs.readFileSync(~/.ssh/config) + full re-parse, no cache at all (ssh-config.ts:67-90, :117-119)', () => {
    isSshConfigHost('agents-cli-bench-nonexistent-host-zzz');
  });
});

describe('matchHost fan-out — resolving every device in a 14-host fleet sequentially (agents fleet status / doctor --devices / teams --device shape)', () => {
  bench(`matchHost across all ${DEVICE_COUNT} seeded devices, one call per host — each pays a fresh loadDevices() with no cache`, async () => {
    for (const name of ALL_DEVICE_NAMES) {
      await matchHost(name);
    }
  });
});

describe('dispatch.ts — pure command-building (runs on every --device dispatch before the ssh round-trip)', () => {
  const opts: DispatchOptions = {
    agent: 'claude',
    prompt: 'benchmark prompt for the host dispatch path',
    mode: 'auto',
    env: ['FOO=bar', 'BAZ=qux'],
    addDir: ['/tmp/one', '/tmp/two'],
    name: 'bench-run',
  };

  bench('buildRunForwardedArgs (dispatch.ts:511)', () => {
    buildRunForwardedArgs(opts);
  });

  bench('remoteCdPrefix, mirrored home-relative cwd (dispatch.ts:79)', () => {
    remoteCdPrefix('~/src/github.com/muqsitnawaz/agents-cli', { mirror: true });
  });

  bench('buildDetachedLaunchCommand (dispatch.ts:147)', () => {
    buildDetachedLaunchCommand(
      "agents run claude 'hi' --quiet > $HOME/.agents/.cache/hosts/x.log 2>&1; echo $? > $HOME/.agents/.cache/hosts/x.exit",
    );
  });

  bench('withActorEnv — resolveActor() + terminalIdEnv() on every launchDetached/runInteractiveOnHost call (dispatch.ts:98)', () => {
    withActorEnv();
  });

  bench('remoteRunShellPrelude — full env-export prelude assembled for every launchDetached call (dispatch.ts:113)', () => {
    remoteRunShellPrelude('claude');
  });
});
