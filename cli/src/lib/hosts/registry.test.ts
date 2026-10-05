/** resolveHost fall-through guards: a machine registered only via `agents devices sync` resolves
 * by `--device <name>` as `user@dnsName`; an ad-hoc `user@host` needs no registration; a bare
 * unknown name returns null for cap routing; a password-auth device throws a typed error. */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Set HOME before state.ts loads so its module-level root picks it up. USERPROFILE too:
// os.homedir() ignores HOME on Windows and ssh-config.ts builds ~/.ssh from it, so the stanza
// written below would be invisible.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-host-resolve-test-'));
process.env.HOME = TEST_HOME;
process.env.AGENTS_DEVICES_DIR = path.join(TEST_HOME, '.agents', '.history', 'devices');
process.env.USERPROFILE = TEST_HOME;

const { resolveHost, listAllHosts, DeviceOffloadUnsupportedError } = await import('./registry.js');
const { sshTargetFor } = await import('./types.js');
const { upsertDevice } = await import('../devices/registry.js');
const { updateMeta } = await import('../state.js');

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

beforeEach(async () => {
  fs.rmSync(registryPath(), { force: true });
  fs.rmSync(`${registryPath()}.lock`, { recursive: true, force: true });
  fs.rmSync(metaPath(), { force: true });
  fs.rmSync(path.join(TEST_HOME, '.ssh', 'config'), { force: true });
});

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('resolveHost — devices fall-through', () => {
  it('resolves a key-auth device by name to a user@dnsName host', async () => {
    await upsertDevice('mac-mini', {
      platform: 'macos',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'mac-mini.tail1a85a1.ts.net', ip: '100.68.1.2' },
      auth: { method: 'key' },
    });

    const host = await resolveHost('mac-mini');
    expect(host).not.toBeNull();
    expect(host!.name).toBe('mac-mini');
    expect(sshTargetFor(host!)).toBe('muqsit@mac-mini.tail1a85a1.ts.net');
    expect(host!.os).toBe('macos');
  });

  it('falls back to the raw ip when a device has no dnsName', async () => {
    await upsertDevice('box', {
      platform: 'linux',
      user: 'root',
      address: { via: 'manual', ip: '100.68.9.9' },
      auth: { method: 'key' },
    });

    const host = await resolveHost('box');
    expect(sshTargetFor(host!)).toBe('root@100.68.9.9');
  });
});

describe('resolveHost — ad-hoc and unknown', () => {
  it('resolves an ad-hoc user@host with nothing registered', async () => {
    const host = await resolveHost('deploy@1.2.3.4');
    expect(host).not.toBeNull();
    expect(host!.user).toBe('deploy');
    expect(host!.address).toBe('1.2.3.4');
    expect(sshTargetFor(host!)).toBe('deploy@1.2.3.4');
  });

  it('returns null for a bare unknown name so capability routing stays reachable', async () => {
    expect(await resolveHost('gpu')).toBeNull();
  });
});

describe('resolveHost — password-auth device', () => {
  it('throws a typed, actionable error instead of dispatching an unusable run', async () => {
    await upsertDevice('win-mini', {
      platform: 'windows',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'win-mini.tail1a85a1.ts.net' },
      auth: { method: 'password', bundle: 'muqsit', bundleKey: 'password' },
    });

    await expect(resolveHost('win-mini')).rejects.toBeInstanceOf(DeviceOffloadUnsupportedError);
    await expect(resolveHost('win-mini')).rejects.toThrow(/password auth/);
    const err = await resolveHost('win-mini').catch((e) => e as Error);
    expect(err.name).toBe('DeviceOffloadUnsupportedError');
  });
});

describe('resolveHost — merge, not shadow (RUSH-1967)', () => {
  it('an enrolled device dials the LIVE registry address, not the overlay snapshot (frozen-route fix)', async () => {
    await upsertDevice('mac-mini', {
      platform: 'macos',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'mac-mini.tail1a85a1.ts.net' },
      auth: { method: 'key' },
    });
    updateMeta((m) => ({ ...m, hosts: { 'mac-mini': { source: 'inline', address: 'mac-mini.OLD.ts.net', user: 'muqsit', caps: ['gpu'] } } }));

    const host = await resolveHost('mac-mini');
    expect(sshTargetFor(host!)).toBe('muqsit@mac-mini.tail1a85a1.ts.net');
    expect(host!.caps).toEqual(['gpu']);
  });

  it('a device keeps its presence + dispatchable when an inline overlay shadows it', async () => {
    await upsertDevice('yosemite-s0', {
      platform: 'linux',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'yosemite-s0.tail1a85a1.ts.net' },
      auth: { method: 'key' },
      tailscale: { online: true, direct: true },
    });
    updateMeta((m) => ({ ...m, hosts: { 'yosemite-s0': { source: 'inline', address: 'yosemite-s0.tail1a85a1.ts.net', caps: ['builder'] } } }));

    const host = await resolveHost('yosemite-s0');
    expect(host!.status).toBe('online');
    expect(host!.dispatchable).toBe(true);
    expect(host!.caps).toEqual(['builder']);
  });

  it('an inline overlay cannot make a password-auth device dispatchable (guard-bypass fix)', async () => {
    await upsertDevice('winbox', {
      platform: 'windows',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'winbox.tail1a85a1.ts.net' },
      auth: { method: 'password', bundle: 'muqsit' },
    });
    updateMeta((m) => ({ ...m, hosts: { winbox: { source: 'inline', address: 'winbox', user: 'muqsit' } } }));

    await expect(resolveHost('winbox')).rejects.toBeInstanceOf(DeviceOffloadUnsupportedError);
  });

  it('a device wins over a same-name ssh_config stanza (divergence #1)', async () => {
    await upsertDevice('mac-mini', {
      platform: 'macos',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'mac-mini.tail1a85a1.ts.net' },
      auth: { method: 'key' },
    });
    writeSshConfig('Host mac-mini\n  HostName 192.168.1.50\n');
    const host = await resolveHost('mac-mini');
    expect(sshTargetFor(host!)).toBe('muqsit@mac-mini.tail1a85a1.ts.net');
  });
});

describe('resolveHost — ssh_config grammar', () => {
  it('resolves a bare ssh_config alias to its bare name (ssh applies the stanza)', async () => {
    writeSshConfig('Host bastion\n  HostName 10.0.0.1\n  User ops\n');
    const host = await resolveHost('bastion');
    expect(host).not.toBeNull();
    expect(sshTargetFor(host!)).toBe('bastion');
  });

  it('resolves user@device through the overlay/registry grammar the old exact-key chain lacked', async () => {
    await upsertDevice('mac-mini', {
      platform: 'macos',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'mac-mini.tail1a85a1.ts.net' },
      auth: { method: 'key' },
    });
    const host = await resolveHost('root@mac-mini');
    expect(sshTargetFor(host!)).toBe('root@mac-mini.tail1a85a1.ts.net');
  });
});

describe('resolveHost — `auto` affinity sentinel (RUSH-2185)', () => {
  it('resolves `auto` to the affinity-picked device, same engine as `run --device auto`', async () => {
    await upsertDevice('mac-mini', {
      platform: 'macos',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'mac-mini.tail1a85a1.ts.net' },
      auth: { method: 'key' },
    });

    const { matchHost } = await import('./registry.js');
    const host = await matchHost('auto', {
      resolveAuto: () => ({ host: 'mac-mini', deviceCandidates: [], pickedDeviceKey: 'mac-mini' }),
    });
    expect(host).not.toBeNull();
    expect(host!.name).toBe('mac-mini');
    expect(sshTargetFor(host!)).toBe('muqsit@mac-mini.tail1a85a1.ts.net');
  });

  it('is case-insensitive, matching `agents run --device Auto`', async () => {
    await upsertDevice('mac-mini', {
      platform: 'macos',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'mac-mini.tail1a85a1.ts.net' },
      auth: { method: 'key' },
    });

    const { matchHost } = await import('./registry.js');
    const host = await matchHost('AUTO', {
      resolveAuto: () => ({ host: 'mac-mini', deviceCandidates: [], pickedDeviceKey: 'mac-mini' }),
    });
    expect(host?.name).toBe('mac-mini');
  });

  it('resolves the local-machine pick (plan.host === null) to this box\'s own device entry, not a miss', async () => {
    const { machineId } = await import('../machine-id.js');
    const self = machineId();
    await upsertDevice(self, {
      platform: 'linux',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: `${self}.tail1a85a1.ts.net` },
      auth: { method: 'key' },
    });

    const { matchHost } = await import('./registry.js');
    const host = await matchHost('auto', {
      resolveAuto: () => ({ host: null, deviceCandidates: [], pickedDeviceKey: null }),
    });
    expect(host).not.toBeNull();
    expect(host!.name).toBe(self);
  });
});

describe('listAllHosts — merge same-name rows (RUSH-1967)', () => {
  it('keeps the device status + dispatchable on an enrolled row instead of dropping them', async () => {
    await upsertDevice('yosemite-s0', {
      platform: 'linux',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'yosemite-s0.tail1a85a1.ts.net' },
      auth: { method: 'key' },
      tailscale: { online: true, direct: true },
    });
    updateMeta((m) => ({ ...m, hosts: { 'yosemite-s0': { source: 'inline', address: 'yosemite-s0.tail1a85a1.ts.net', caps: ['builder'] } } }));

    const rows = (await listAllHosts()).filter((h) => h.name === 'yosemite-s0');
    expect(rows).toHaveLength(1);
    expect(rows[0].caps).toEqual(['builder']);
    expect(rows[0].status).toBe('online');
    expect(rows[0].dispatchable).toBe(true);
  });

  it('a password-auth device behind an inline overlay stays non-dispatchable in listings', async () => {
    await upsertDevice('winbox', {
      platform: 'windows',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'winbox.tail1a85a1.ts.net' },
      auth: { method: 'password', bundle: 'muqsit' },
    });
    updateMeta((m) => ({ ...m, hosts: { winbox: { source: 'inline', address: 'winbox', user: 'muqsit', caps: ['gpu'] } } }));

    const row = (await listAllHosts()).find((h) => h.name === 'winbox');
    expect(row?.dispatchable).toBe(false);
  });

  it('the LIVE device address wins over a stale enrolled overlay address', async () => {
    // The frozen-route bug via listAllHosts: after enrolling a device to tag it, `devices sync`
    // moves its address but the overlay keeps the old one, so preferring the overlay serves a dead
    // route; resolveHostByCap hands a listAllHosts() row straight to dispatch.
    await upsertDevice('mac-mini', {
      platform: 'macos',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'mac-mini.NEW.ts.net' },
      auth: { method: 'key' },
      tailscale: { online: true, direct: true },
    });
    updateMeta((m) => ({
      ...m,
      hosts: { 'mac-mini': { source: 'inline', address: 'mac-mini.OLD.ts.net', user: 'muqsit', caps: ['gpu'] } },
    }));

    const row = (await listAllHosts()).find((h) => h.name === 'mac-mini');
    expect(row?.address).toBe('mac-mini.NEW.ts.net');
    expect(row?.caps).toEqual(['gpu']);
  });

  it('cap-tag routing dispatches to the live device address, not the stale overlay', async () => {
    await upsertDevice('mac-mini', {
      platform: 'macos',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'mac-mini.NEW.ts.net' },
      auth: { method: 'key' },
      tailscale: { online: true, direct: true },
    });
    updateMeta((m) => ({
      ...m,
      hosts: { 'mac-mini': { source: 'inline', address: 'mac-mini.OLD.ts.net', user: 'muqsit', caps: ['gpu'] } },
    }));

    const { resolveHostByCap } = await import('./registry.js');
    expect(sshTargetFor(await resolveHostByCap('gpu'))).toBe('muqsit@mac-mini.NEW.ts.net');
  });
});

describe('matchHost — `interactive` sentinel', () => {
  it('resolves `interactive` to the device pinned as interactive.host', async () => {
    await upsertDevice('mac-mini', {
      platform: 'macos',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'mac-mini.tail1a85a1.ts.net' },
      auth: { method: 'key' },
    });
    const { setConfigValue } = await import('../device-config.js');
    setConfigValue('interactive.host', 'mac-mini');

    const { matchHost } = await import('./registry.js');
    const host = await matchHost('interactive', {});
    expect(host?.name).toBe('mac-mini');
    expect(sshTargetFor(host!)).toBe('muqsit@mac-mini.tail1a85a1.ts.net');
  });

  it('is case-insensitive, like `auto`', async () => {
    await upsertDevice('mac-mini', {
      platform: 'macos',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'mac-mini.tail1a85a1.ts.net' },
      auth: { method: 'key' },
    });
    const { setConfigValue } = await import('../device-config.js');
    setConfigValue('interactive.host', 'mac-mini');

    const { matchHost } = await import('./registry.js');
    expect((await matchHost('INTERACTIVE', {}))?.name).toBe('mac-mini');
  });

  it('throws with the fix command when no host is pinned', async () => {
    const { matchHost } = await import('./registry.js');
    await expect(matchHost('interactive', {})).rejects.toThrow(
      /agents config set interactive\.host/,
    );
  });
});
