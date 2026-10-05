import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-run-target-test-'));
process.env.HOME = TEST_HOME;
process.env.AGENTS_DEVICES_DIR = path.join(TEST_HOME, '.agents', '.history', 'devices');

const { resolveHostRunTarget, resolveHostSessionId, HostResolutionError } = await import('./run-target.js');
const { DeviceOffloadUnsupportedError } = await import('./registry.js');
const { sshTargetFor } = await import('./types.js');
const { upsertDevice } = await import('../devices/registry.js');
const { updateMeta } = await import('../state.js');

function registryPath(): string {
  return path.join(TEST_HOME, '.agents', '.history', 'devices', 'registry.json');
}

beforeEach(async () => {
  fs.rmSync(registryPath(), { force: true });
  fs.rmSync(`${registryPath()}.lock`, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('resolveHostRunTarget — exact name', () => {
  it('resolves a key-auth device by name, matching resolveHost', async () => {
    await upsertDevice('gpu-box', {
      platform: 'linux',
      user: 'taylor',
      address: { via: 'tailscale', dnsName: 'gpu-box.tail1a85a1.ts.net' },
      auth: { method: 'key' },
    });

    const host = await resolveHostRunTarget('gpu-box');
    expect(host.name).toBe('gpu-box');
    expect(sshTargetFor(host)).toBe('taylor@gpu-box.tail1a85a1.ts.net');
  });

  it('resolves an ad-hoc user@host with nothing registered', async () => {
    const host = await resolveHostRunTarget('deploy@1.2.3.4');
    expect(sshTargetFor(host)).toBe('deploy@1.2.3.4');
  });
});

describe('resolveHostRunTarget — capability fall-through', () => {
  it('falls through to a capability tag when the name matches no host', async () => {
    await updateMeta((meta) => {
      meta.hosts = {
        'gpu-a': { source: 'inline', address: '100.68.0.1', user: 'a', caps: ['gpu'], addedAt: new Date().toISOString() },
      };
      return meta;
    });
    const host = await resolveHostRunTarget('gpu');
    expect(host.name).toBe('gpu-a');
  });

  it('surfaces the ambiguous-tag verdict verbatim', async () => {
    await updateMeta((meta) => {
      meta.hosts = {
        'gpu-a': { source: 'inline', address: '100.68.0.1', user: 'a', caps: ['gpu'], addedAt: new Date().toISOString() },
        'gpu-b': { source: 'inline', address: '100.68.0.2', user: 'b', caps: ['gpu'], addedAt: new Date().toISOString() },
      };
      return meta;
    });
    const err = await resolveHostRunTarget('gpu').catch((e) => e as Error);
    expect(err).toBeInstanceOf(HostResolutionError);
    expect(err.message).toMatch(/^Multiple hosts tagged "gpu"/);
  });

  it('resolves an ambiguous tag with any:true', async () => {
    await updateMeta((meta) => {
      meta.hosts = {
        'gpu-a': { source: 'inline', address: '100.68.0.1', user: 'a', caps: ['gpu'], addedAt: new Date().toISOString() },
        'gpu-b': { source: 'inline', address: '100.68.0.2', user: 'b', caps: ['gpu'], addedAt: new Date().toISOString() },
      };
      return meta;
    });
    const host = await resolveHostRunTarget('gpu', { any: true });
    expect(['gpu-a', 'gpu-b']).toContain(host.name);
  });

  it('degrades "no host tagged" to the generic unknown-host error', async () => {
    await updateMeta((meta) => {
      meta.hosts = {};
      return meta;
    });
    const err = await resolveHostRunTarget('nonexistent').catch((e) => e as Error);
    expect(err).toBeInstanceOf(HostResolutionError);
    expect(err.message).toBe('Unknown host "nonexistent". List devices: agents devices list');
  });
});

describe('resolveHostRunTarget — password-auth device', () => {
  it('propagates DeviceOffloadUnsupportedError untouched (top-level catch contract)', async () => {
    await upsertDevice('win-mini', {
      platform: 'windows',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'win-mini.tail1a85a1.ts.net' },
      auth: { method: 'password', bundle: 'muqsit', bundleKey: 'password' },
    });

    const err = await resolveHostRunTarget('win-mini').catch((e) => e as Error);
    expect(err).toBeInstanceOf(DeviceOffloadUnsupportedError);
    expect(err.name).toBe('DeviceOffloadUnsupportedError');
  });
});

describe('resolveHostSessionId', () => {
  const explicitId = '11111111-2222-4333-8444-555555555555';

  it('adopts an explicit id for a fresh Claude host run', () => {
    expect(resolveHostSessionId('claude', undefined, explicitId)).toBe(explicitId);
  });

  it('mints an id when a fresh Claude host run has no explicit id', () => {
    expect(resolveHostSessionId('claude')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not force an id for resume or an agent that creates its own id', () => {
    expect(resolveHostSessionId('claude', explicitId, 'ignored')).toBeUndefined();
    expect(resolveHostSessionId('codex', undefined, explicitId)).toBeUndefined();
  });
});

describe('resolveHostSessionId — run auto session-id forwarding (RUSH-2132)', () => {
  it('forwards an explicit id for a remote claude pick, but never mints one', () => {
    expect(resolveHostSessionId('auto', undefined, 'fixed-id')).toBe('fixed-id');
    expect(resolveHostSessionId('auto')).toBeUndefined();
    expect(resolveHostSessionId('auto', 'resume-id', 'fixed-id')).toBeUndefined();
  });

  it('claude semantics unchanged: adopt explicit, mint when absent, never on resume', () => {
    expect(resolveHostSessionId('claude', undefined, 'fixed-id')).toBe('fixed-id');
    expect(typeof resolveHostSessionId('claude')).toBe('string');
    expect(resolveHostSessionId('claude', 'resume-id', 'fixed-id')).toBeUndefined();
    expect(resolveHostSessionId('codex', undefined, 'fixed-id')).toBeUndefined();
  });
});
