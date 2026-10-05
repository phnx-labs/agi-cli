import { describe, expect, it, vi, afterEach } from 'vitest';
import { registerChannelProvider, type ChannelProvider } from './registry.js';
import { lookupTransport, resolveTransport } from './resolve.js';
import type { Meta } from '../types.js';

const stub = (name: string): ChannelProvider => ({
  name,
  async send() {
    return { ok: true, channel: name, id: 'x' };
  },
});

registerChannelProvider(stub('telegram'));
registerChannelProvider(stub('openclaw-telegram'));
registerChannelProvider(stub('slack'));

const emptyMeta = {} as Meta;

afterEach(() => vi.restoreAllMocks());

describe('resolveTransport', () => {
  it('uses notify.transports mapping when present (telegram -> openclaw-telegram)', () => {
    const meta = { notify: { transports: { telegram: 'openclaw-telegram' } } } as Meta;
    expect(resolveTransport('telegram', meta).name).toBe('openclaw-telegram');
  });

  it('defaults to name-identity when no mapping (channel slack -> provider slack)', () => {
    expect(resolveTransport('slack', emptyMeta).name).toBe('slack');
  });

  it('dies loud on an unregistered provider — never silently reroutes', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as typeof process.exit);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => resolveTransport('nonexistent-channel', emptyMeta)).toThrow(/process\.exit/);
    expect(exitSpy).toHaveBeenCalled();
  });
});

describe('lookupTransport (the non-exiting seam daemons resolve through)', () => {
  it('returns the mapped provider like resolveTransport does', () => {
    const meta = { notify: { transports: { telegram: 'openclaw-telegram' } } } as Meta;
    expect(lookupTransport('telegram', meta).provider?.name).toBe('openclaw-telegram');
  });

  it('returns the failure instead of exiting on an unregistered provider', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as typeof process.exit);
    const result = lookupTransport('nonexistent-channel', emptyMeta);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(result.provider).toBeUndefined();
    expect(result.error).toMatch(/No channel provider 'nonexistent-channel'/);
  });

  it('names the notify.transports mapping in the error when the channel was remapped', () => {
    const meta = { notify: { transports: { telegram: 'ghost-provider' } } } as Meta;
    const result = lookupTransport('telegram', meta);
    expect(result.providerName).toBe('ghost-provider');
    expect(result.error).toMatch(/mapped from channel 'telegram' via notify\.transports/);
  });
});
