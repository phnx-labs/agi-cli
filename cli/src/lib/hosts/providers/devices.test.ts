/** Devices host provider guards: a device registered via `agents devices sync` appears in
 * `listAllHosts()`; a password-auth device is listed (`dispatchable: false`) but never
 * dispatched; an enrolled host shadows a same-name device and `Meta.hosts` caps merge in. */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devices-provider-test-'));
process.env.HOME = TEST_HOME;
process.env.AGENTS_DEVICES_DIR = path.join(TEST_HOME, '.agents', '.history', 'devices');

const { DevicesHostProvider } = await import('./devices.js');
const { listAllHosts, resolveHostByCap, resolveHost } = await import('../registry.js');
const { DeviceOffloadUnsupportedError } = await import('../types.js');
const { upsertDevice } = await import('../../devices/registry.js');
const { updateMeta } = await import('../../state.js');

function registryPath(): string {
  return path.join(TEST_HOME, '.agents', '.history', 'devices', 'registry.json');
}

beforeEach(async () => {
  fs.rmSync(registryPath(), { force: true });
  fs.rmSync(`${registryPath()}.lock`, { recursive: true, force: true });
  updateMeta((meta) => {
    const { hosts: _omit, ...rest } = meta;
    return rest;
  });
});

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('DevicesHostProvider.list', () => {
  it('lists key-auth devices as dispatchable hosts with presence', async () => {
    await upsertDevice('gpu-box', {
      platform: 'linux',
      user: 'taylor',
      address: { via: 'tailscale', dnsName: 'gpu-box.tail1a85a1.ts.net', ip: '100.68.1.2' },
      auth: { method: 'key', identityFile: '/keys/gpu-box' },
      tailscale: { id: 'n1', hostName: 'gpu-box', online: true },
    });

    const provider = new DevicesHostProvider();
    const hosts = await provider.list();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].name).toBe('gpu-box');
    expect(hosts[0].provider).toBe('devices');
    expect(hosts[0].address).toBe('gpu-box.tail1a85a1.ts.net');
    expect(hosts[0].status).toBe('online');
    expect(hosts[0].dispatchable).toBe(true);
    expect(hosts[0].identityFile).toBe('/keys/gpu-box');
  });

  it('lists password-auth devices marked non-dispatchable', async () => {
    await upsertDevice('win-mini', {
      platform: 'windows',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'win-mini.tail1a85a1.ts.net' },
      auth: { method: 'password', bundle: 'muqsit', bundleKey: 'password' },
    });

    const provider = new DevicesHostProvider();
    const hosts = await provider.list();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].dispatchable).toBe(false);
  });

  it('skips address-less device profiles (nothing to dispatch to)', async () => {
    await upsertDevice('ghost', {
      platform: 'linux',
      address: { via: 'manual' },
      auth: { method: 'key' },
    });
    const provider = new DevicesHostProvider();
    expect(await provider.list()).toHaveLength(0);
  });
});

describe('devices in the unified pool', () => {
  it('listAllHosts merges a same-name enrolled host with the device, per-field', async () => {
    await upsertDevice('shared-name', {
      platform: 'linux',
      user: 'device-user',
      address: { via: 'tailscale', dnsName: 'shared.tail.ts.net' },
      auth: { method: 'key' },
    });
    updateMeta((meta) => ({
      ...meta,
      hosts: { 'shared-name': { source: 'inline', address: '10.0.0.9', user: 'host-user', addedAt: new Date().toISOString() } },
    }));

    const all = await listAllHosts();
    const rows = all.filter((h) => h.name === 'shared-name');
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('local');
    // The device owns the connection fields (RUSH-1967). The old assertion expected the overlay's
    // '10.0.0.9', encoding the frozen-route bug: a stale enrolled address won after `devices sync`
    // moved the device, and `--device <cap>` dialed it.
    expect(rows[0].address).toBe('shared.tail.ts.net');
    expect(rows[0].user).toBe('device-user');
  });

  it('cap routing reaches a device enrolled with a tag (the hosts-add-from-device path)', async () => {
    await upsertDevice('gpu-dev', {
      platform: 'linux',
      user: 'taylor',
      address: { via: 'tailscale', dnsName: 'gpu-dev.tail.ts.net' },
      auth: { method: 'key' },
    });
    updateMeta((meta) => ({
      ...meta,
      hosts: {
        'gpu-dev': { source: 'inline', address: 'gpu-dev.tail.ts.net', user: 'taylor', caps: ['gpu'], addedAt: new Date().toISOString() },
      },
    }));

    const host = await resolveHostByCap('gpu');
    expect(host.name).toBe('gpu-dev');
    expect(host.address).toBe('gpu-dev.tail.ts.net');
  });

  it('resolveHost still throws the typed error for password-auth devices', async () => {
    await upsertDevice('win-mini', {
      platform: 'windows',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'win-mini.tail1a85a1.ts.net' },
      auth: { method: 'password', bundle: 'muqsit', bundleKey: 'password' },
    });
    const err = await resolveHost('win-mini').catch((e) => e as Error);
    expect(err).toBeInstanceOf(DeviceOffloadUnsupportedError);
    expect((err as Error).name).toBe('DeviceOffloadUnsupportedError');
  });
});
