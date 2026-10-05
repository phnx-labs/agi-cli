import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-resolve-target-test-'));
process.env.HOME = TEST_HOME;
process.env.AGENTS_DEVICES_DIR = path.join(TEST_HOME, '.agents', '.history', 'devices');
process.env.USERPROFILE = TEST_HOME;

const { resolveExplicitTargets, resolveExplicitTargetSet, resolveDeviceTarget } = await import('../resolve-target.js');
const { resolveHost } = await import('../../hosts/registry.js');
const { sshTargetFor } = await import('../../hosts/types.js');
const { upsertDevice } = await import('../registry.js');

function registryPath(): string {
  return path.join(TEST_HOME, '.agents', '.history', 'devices', 'registry.json');
}
function metaPath(): string {
  return path.join(TEST_HOME, '.agents', 'agents.yaml');
}
function writeSshConfig(text: string): void {
  fs.mkdirSync(path.join(TEST_HOME, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(TEST_HOME, '.ssh', 'config'), text);
}

beforeEach(() => {
  fs.rmSync(registryPath(), { force: true });
  fs.rmSync(`${registryPath()}.lock`, { recursive: true, force: true });
  fs.rmSync(metaPath(), { force: true });
  fs.rmSync(path.join(TEST_HOME, '.ssh', 'config'), { force: true });
});

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

async function addDevice(name: string, over: Partial<Parameters<typeof upsertDevice>[1]> = {}): Promise<void> {
  await upsertDevice(name, {
    platform: 'linux',
    user: 'muqsit',
    address: { via: 'tailscale', dnsName: `${name}.tail1a85a1.ts.net` },
    auth: { method: 'key' },
    ...over,
  });
}

describe('resolveExplicitTargets — fan-out through the unified core', () => {
  it('dials a bare device name via its live Tailscale route, not the literal alias', async () => {
    await addDevice('yosemite-s0');
    const [r] = await resolveExplicitTargets(['yosemite-s0']);
    expect(r).toEqual({
      target: 'muqsit@yosemite-s0.tail1a85a1.ts.net',
      machine: 'yosemite-s0',
      name: 'yosemite-s0',
      os: 'linux',
    });
  });

  it('carries the registered identity into explicit fan-out targets', async () => {
    await addDevice('keyed', { auth: { method: 'key', identityFile: '/keys/keyed' } });
    const [r] = await resolveExplicitTargets(['keyed']);
    expect(r?.extraSshArgs).toEqual(['-i', '/keys/keyed', '-o', 'IdentitiesOnly=yes']);
  });

  it('matches a tailnet FQDN / different case to the same device (normalized)', async () => {
    await addDevice('yosemite-s0');
    expect((await resolveExplicitTargets(['YOSEMITE-S0.tail1a85a1.ts.net']))[0]?.target).toBe(
      'muqsit@yosemite-s0.tail1a85a1.ts.net',
    );
  });

  it('overrides only the login user for user@device (still the Tailscale route)', async () => {
    await addDevice('yosemite-s0');
    const [r] = await resolveExplicitTargets(['root@yosemite-s0']);
    expect(r?.target).toBe('root@yosemite-s0.tail1a85a1.ts.net');
    expect(r?.machine).toBe('yosemite-s0');
  });

  it('keeps a user@host literal when the host matches no device', async () => {
    const [r] = await resolveExplicitTargets(['root@some-box']);
    expect(r?.target).toBe('root@some-box');
    expect(r?.machine).toBe('some-box');
  });

  it('makes an ssh_config-only alias visible to the fan-out (divergence #2)', async () => {
    writeSshConfig('Host only-in-ssh\n  HostName 10.0.0.9\n');
    const [r] = await resolveExplicitTargets(['only-in-ssh']);
    expect(r?.target).toBe('only-in-ssh');
    expect(r?.machine).toBe('only-in-ssh');
  });

  it('skips an addressless device with a note rather than dialing a bad literal', async () => {
    await addDevice('no-addr', { address: { via: 'manual' } });
    expect(await resolveExplicitTargets(['no-addr'])).toEqual([]);
  });

  it('skips a bare unknown word (a typo is not a literal to dial)', async () => {
    expect(await resolveExplicitTargets(['definitely-not-here'])).toEqual([]);
  });

  it('retains unresolved tokens for coverage-sensitive fan-outs', async () => {
    await addDevice('known');
    const resolved = await resolveExplicitTargetSet(['known', 'definitely-not-here']);
    expect(resolved.targets.map((target) => target.name)).toEqual(['known']);
    expect(resolved.unresolved).toEqual(['definitely-not-here']);
  });

  it('skips an injection-unsafe token', async () => {
    expect(await resolveExplicitTargets(['bad;rm -rf'])).toEqual([]);
  });
});

describe('run --device and sessions --device resolve to the SAME target (divergence table)', () => {
  async function bothTargets(token: string): Promise<{ dispatch?: string; fanout?: string }> {
    const host = await resolveHost(token);
    const dispatch = host ? sshTargetFor(host) : undefined;
    const fanout = (await resolveExplicitTargets([token]))[0]?.target;
    return { dispatch, fanout };
  }

  it('#1 name in BOTH ssh_config and the device registry → device route wins for both', async () => {
    await addDevice('mac-mini', { platform: 'macos', address: { via: 'tailscale', dnsName: 'mac-mini.tail1a85a1.ts.net' } });
    writeSshConfig('Host mac-mini\n  HostName 192.168.1.50\n');
    const { dispatch, fanout } = await bothTargets('mac-mini');
    expect(dispatch).toBe('muqsit@mac-mini.tail1a85a1.ts.net');
    expect(fanout).toBe(dispatch);
  });

  it('#3 user@device → both dial the Tailscale route with the user overridden', async () => {
    await addDevice('mac-mini', { platform: 'macos', address: { via: 'tailscale', dnsName: 'mac-mini.tail1a85a1.ts.net' } });
    const { dispatch, fanout } = await bothTargets('muqsit@mac-mini');
    expect(dispatch).toBe('muqsit@mac-mini.tail1a85a1.ts.net');
    expect(fanout).toBe(dispatch);
  });

  it('#4 tailnet FQDN → both resolve to the same device route', async () => {
    await addDevice('yosemite-s0');
    const { dispatch, fanout } = await bothTargets('yosemite-s0.tail1a85a1.ts.net');
    expect(dispatch).toBe('muqsit@yosemite-s0.tail1a85a1.ts.net');
    expect(fanout).toBe(dispatch);
  });

  it('ad-hoc user@host → identical literal target for both', async () => {
    const { dispatch, fanout } = await bothTargets('ubuntu@203.0.113.9');
    expect(dispatch).toBe('ubuntu@203.0.113.9');
    expect(fanout).toBe(dispatch);
  });
});

describe('resolveDeviceTarget — agents ssh grammar', () => {
  it('returns the full profile for a bare device name', async () => {
    await addDevice('yosemite-s0');
    const r = await resolveDeviceTarget('yosemite-s0');
    expect(r?.name).toBe('yosemite-s0');
    expect(r?.user).toBe('muqsit');
    expect(r?.address.dnsName).toBe('yosemite-s0.tail1a85a1.ts.net');
  });

  it('overrides only the login user for user@device', async () => {
    await addDevice('yosemite-s0');
    const r = await resolveDeviceTarget('root@yosemite-s0');
    expect(r?.name).toBe('yosemite-s0');
    expect(r?.user).toBe('root');
    expect(r?.address.dnsName).toBe('yosemite-s0.tail1a85a1.ts.net');
    expect(r?.auth.method).toBe('key');
  });

  it('synthesizes an ad-hoc profile for a user@ip literal', async () => {
    const r = await resolveDeviceTarget('ubuntu@203.0.113.9');
    expect(r?.user).toBe('ubuntu');
    expect(r?.address.ip).toBe('203.0.113.9');
    expect(r?.address.dnsName).toBeUndefined();
  });

  it('synthesizes an ad-hoc profile for a dotted hostname literal', async () => {
    const r = await resolveDeviceTarget('box.example.com');
    expect(r?.address.dnsName).toBe('box.example.com');
    expect(r?.user).toBeUndefined();
  });

  it('returns undefined for a bare unregistered alias ("Unknown device")', async () => {
    expect(await resolveDeviceTarget('not-a-device')).toBeUndefined();
  });

  it('returns undefined for an ssh_config-only alias (agents ssh stays devices+literals only)', async () => {
    writeSshConfig('Host only-in-ssh\n  HostName 10.0.0.9\n');
    expect(await resolveDeviceTarget('only-in-ssh')).toBeUndefined();
  });

  it('returns undefined for an injection-unsafe token', async () => {
    expect(await resolveDeviceTarget('bad;rm -rf')).toBeUndefined();
  });
});
