import { beforeEach, describe, expect, it, vi } from 'vitest';

// The fleet/config/actor boundary is mocked so the fd-3 context SHAPE — the wire
// contract with the standalone `browser` engine — is asserted deterministically
// without a real device registry. The real device resolution is covered by
// `ssh-tunnel`'s own tests; here we pin what agents-cli hands the engine.
const mockResolveRemoteDevice = vi.fn();
const mockGetConfigValue = vi.fn();
vi.mock('../ssh-tunnel.js', () => ({ resolveRemoteDevice: (...a: unknown[]) => mockResolveRemoteDevice(...a) }));
vi.mock('../device-config.js', () => ({ getConfigValue: (...a: unknown[]) => mockGetConfigValue(...a) }));
vi.mock('../actor.js', () => ({ resolveActor: () => ({ id: 'claude' }) }));

import { buildBrowserContext, remoteControlEnabled } from './context.js';

beforeEach(() => {
  mockResolveRemoteDevice.mockReset();
  mockGetConfigValue.mockReset();
  mockGetConfigValue.mockReturnValue({ value: undefined });
});

describe('buildBrowserContext', () => {
  it('a local invocation ships NO target key and version 1', async () => {
    const ctx = await buildBrowserContext();
    expect(ctx.version).toBe(1);
    expect('target' in ctx).toBe(false);
    expect(ctx.session.actor).toBe('claude');
    expect(mockResolveRemoteDevice).not.toHaveBeenCalled();
  });

  it('--device resolves to the fleet target the engine matches its alias against', async () => {
    mockResolveRemoteDevice.mockResolvedValue({
      target: 'user@100.1.2.3',
      user: 'user',
      host: '100.1.2.3',
      device: { platform: 'darwin' },
      identityArgs: ['-i', '/home/u/.ssh/id_agents'],
    });
    const ctx = await buildBrowserContext({ device: 'zion' });
    expect(mockResolveRemoteDevice).toHaveBeenCalledWith('zion');
    expect(ctx.target).toEqual({
      alias: 'zion',
      host: 'user@100.1.2.3',
      user: 'user',
      hostname: '100.1.2.3',
      platform: 'darwin',
      sshArgs: ['-i', '/home/u/.ssh/id_agents'],
    });
  });

  it('--device local forces this machine — no target, no fleet resolution', async () => {
    const ctx = await buildBrowserContext({ device: 'local' });
    expect('target' in ctx).toBe(false);
    expect(mockResolveRemoteDevice).not.toHaveBeenCalled();
  });

  it('carries the machine\'s remote-control consent from config, unset = deny', async () => {
    mockGetConfigValue.mockReturnValue({ value: undefined });
    expect((await buildBrowserContext()).remoteControl.allowed).toBe(false);
    mockGetConfigValue.mockReturnValue({ value: true });
    expect((await buildBrowserContext()).remoteControl.allowed).toBe(true);
    expect(remoteControlEnabled()).toBe(true);
  });
});
