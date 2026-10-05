/** resolveDeviceTarget, the `agents ssh` adapter over the shared host resolver, covers the `auto`
 * sentinel (RUSH-2185): `agents ssh auto` used to fail "Unknown device"; matchHost now resolves
 * it, and this pins that the pick yields a full DeviceProfile like an explicit name. */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-resolve-target-test-'));
process.env.HOME = TEST_HOME;
process.env.AGENTS_DEVICES_DIR = path.join(TEST_HOME, '.agents', '.history', 'devices');
process.env.USERPROFILE = TEST_HOME;

const { resolveDeviceTarget } = await import('./resolve-target.js');
const { upsertDevice } = await import('./registry.js');
const { machineId } = await import('../machine-id.js');

function registryPath(): string {
  return path.join(TEST_HOME, '.agents', '.history', 'devices', 'registry.json');
}

beforeEach(() => {
  fs.rmSync(registryPath(), { force: true });
  fs.rmSync(`${registryPath()}.lock`, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('resolveDeviceTarget — `auto` affinity sentinel (RUSH-2185)', () => {
  it('resolves `auto` to the affinity-picked device, matching a device name lookup', async () => {
    await upsertDevice('mac-mini', {
      platform: 'macos',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'mac-mini.tail1a85a1.ts.net' },
      auth: { method: 'key' },
    });

    const byName = await resolveDeviceTarget('mac-mini');
    const byAuto = await resolveDeviceTarget('auto', {
      resolveAuto: () => ({ host: 'mac-mini', deviceCandidates: [], pickedDeviceKey: 'mac-mini' }),
    });
    expect(byAuto).toBeDefined();
    expect(byAuto!.name).toBe(byName!.name);
    expect(byAuto!.address).toEqual(byName!.address);
  });

  it('resolves a local-machine pick (plan.host === null) to this box\'s own device entry', async () => {
    const self = machineId();
    await upsertDevice(self, {
      platform: 'linux',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: `${self}.tail1a85a1.ts.net` },
      auth: { method: 'key' },
    });

    const device = await resolveDeviceTarget('auto', {
      resolveAuto: () => ({ host: null, deviceCandidates: [], pickedDeviceKey: null }),
    });
    expect(device).toBeDefined();
    expect(device!.name).toBe(self);
  });

  it('still reports a bare unregistered alias as unresolved (unrelated to `auto`)', async () => {
    expect(await resolveDeviceTarget('totally-unknown-box')).toBeUndefined();
  });
});
