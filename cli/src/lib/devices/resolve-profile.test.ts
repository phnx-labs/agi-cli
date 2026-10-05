import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The profile resolver: config layers (per-device doc `config:` over central
 * `fleet.defaults.config`) overlay the registry's discovery record. */
let TMP = '';

async function freshModules() {
  vi.resetModules();
  const resolver = await import('./resolve-profile.js');
  const connect = await import('./connect.js');
  const registry = await import('./registry.js');
  return { ...resolver, ...connect, ...registry };
}

function writeCentral(yamlText: string) {
  fs.mkdirSync(path.join(TMP, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(TMP, '.agents', 'agents.yaml'), yamlText);
}

function writeDeviceDoc(name: string, yamlText: string) {
  const dir = path.join(TMP, '.agents', 'devices', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents.yaml'), yamlText);
}

const NOW = new Date().toISOString();
function profile(over: Record<string, unknown> = {}) {
  return {
    name: 'worker',
    platform: 'linux',
    shell: 'posix',
    user: 'discovered',
    address: { via: 'tailscale', dnsName: 'worker.example.ts.net' },
    auth: { method: 'key' },
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as any;
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-resolve-profile-test-'));
  process.env.HOME = TMP;
  process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
  process.env.AGENTS_DEVICES_DIR = path.join(TMP, '.agents', '.history', 'devices');
});
afterEach(() => {
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  delete process.env.AGENTS_DEVICES_DIR;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {  }
});

describe('resolveDeviceProfile', () => {
  it('returns the registry profile unchanged when no config is set', async () => {
    const { resolveDeviceProfile } = await freshModules();
    const p = profile();
    expect(resolveDeviceProfile(p)).toBe(p);
  });

  it('overlays per-device doc ssh.* / platform / user values onto the registry profile', async () => {
    writeDeviceDoc('worker', 'config:\n  sshUser: ops\n  sshIdentityFile: /keys/fleet\n  platform: windows\n');
    const { resolveDeviceProfile } = await freshModules();

    const resolved = resolveDeviceProfile(profile());

    expect(resolved.user).toBe('ops');
    expect(resolved.auth.identityFile).toBe('/keys/fleet');
    expect(resolved.platform).toBe('windows');
    expect(resolved.shell).toBe('powershell');
    expect(resolved.address.dnsName).toBe('worker.example.ts.net');
  });

  it('fleet defaults apply fleet-wide; the device doc wins on conflict', async () => {
    writeCentral('fleet:\n  devices: {}\n  defaults:\n    config:\n      sshUser: fleetops\n      platform: windows\n');
    writeDeviceDoc('worker', 'config:\n  platform: linux\n');
    const { resolveDeviceProfile } = await freshModules();

    const resolved = resolveDeviceProfile(profile());
    expect(resolved.user).toBe('fleetops');
    expect(resolved.platform).toBe('linux');
  });

  it('a doc ssh.identity-file wins in the real buildSshInvocation argv', async () => {
    writeDeviceDoc('worker', 'config:\n  sshIdentityFile: /keys/central\n');
    const { buildSshInvocation } = await freshModules();

    const { args } = buildSshInvocation(profile({ auth: { method: 'key', identityFile: '/keys/registry' } }), ['uptime'], '/tmp/askpass.sh');

    const i = args.indexOf('-i');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('/keys/central');
    expect(args).toContain('IdentitiesOnly=yes');
    expect(args).toContain('discovered@worker.example.ts.net');
  });

  it('a doc ssh.user overrides the dial user', async () => {
    writeDeviceDoc('worker', 'config:\n  sshUser: ops\n');
    const { buildSshInvocation } = await freshModules();

    const { args } = buildSshInvocation(profile(), ['uptime'], '/tmp/askpass.sh');
    expect(args).toContain('ops@worker.example.ts.net');
  });

  it('a doc platform=windows switches the remote command wrap to PowerShell', async () => {
    writeDeviceDoc('worker', 'config:\n  platform: windows\n');
    const { buildSshInvocation } = await freshModules();

    const { args } = buildSshInvocation(profile(), ['uptime'], '/tmp/askpass.sh');
    const remote = args[args.length - 1];
    expect(remote).toMatch(/^powershell -NoProfile -EncodedCommand /);
  });

  it('a doc ssh.auth=password drives the askpass auth path', async () => {
    writeDeviceDoc('worker', 'config:\n  sshAuth: password\n  sshBundle: fleet\n  sshBundleKey: password.work\n');
    const { buildSshInvocation, ASKPASS_BUNDLE_ENV, ASKPASS_KEY_ENV } = await freshModules();

    const { args, env } = buildSshInvocation(profile(), ['uptime'], '/tmp/askpass.sh');
    expect(args).toContain('PreferredAuthentications=password');
    expect(env.SSH_ASKPASS).toBe('/tmp/askpass.sh');
    expect(env[ASKPASS_BUNDLE_ENV]).toBe('fleet');
    expect(env[ASKPASS_KEY_ENV]).toBe('password.work');
  });
});
