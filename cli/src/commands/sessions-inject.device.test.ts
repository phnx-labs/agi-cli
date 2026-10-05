
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-inject-device-test-'));
process.env.HOME = TEST_HOME;
process.env.AGENTS_DEVICES_DIR = path.join(TEST_HOME, '.agents', '.history', 'devices');
process.env.USERPROFILE = TEST_HOME;

const { resolveInjectSshTarget } = await import('./sessions-inject.js');
const { upsertDevice } = await import('../lib/devices/registry.js');
const { DeviceOffloadUnsupportedError } = await import('../lib/hosts/registry.js');

function registryPath(): string {
  return path.join(TEST_HOME, '.agents', '.history', 'devices', 'registry.json');
}

beforeEach(() => {
  fs.rmSync(registryPath(), { force: true });
  fs.rmSync(path.join(TEST_HOME, '.ssh', 'config'), { force: true });
});

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('resolveInjectSshTarget', () => {
  it('resolves a registered key-auth device to its user@dnsName', async () => {
    await upsertDevice('mac-mini', {
      platform: 'macos',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'mac-mini.tail1a85a1.ts.net', ip: '100.68.1.2' },
      auth: { method: 'key' },
    });
    expect(await resolveInjectSshTarget('mac-mini')).toBe('muqsit@mac-mini.tail1a85a1.ts.net');
  });

  it('hands a bare unknown ad-hoc user@host to ssh verbatim', async () => {
    expect(await resolveInjectSshTarget('deploy@1.2.3.4')).toBe('deploy@1.2.3.4');
  });

  it('FAILS LOUD for a password-auth device instead of degrading to the raw name', async () => {
    await upsertDevice('win-mini', {
      platform: 'windows',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'win-mini.tail1a85a1.ts.net' },
      auth: { method: 'password', bundle: 'muqsit', bundleKey: 'password' },
    });
    await expect(resolveInjectSshTarget('win-mini')).rejects.toBeInstanceOf(DeviceOffloadUnsupportedError);
  });
});
