/**
 * Transport precedence is the rule a user's existing environment depends on:
 * before PHNX-4075 the in-process client picked the backend, and it now has to
 * be decided here and handed to the engine. These cases pin that the answer did
 * not change.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { resolveTransport } from './context.js';

const ENV_KEYS = ['COMPUTER_HELPER_VNC', 'COMPUTER_HELPER_VNC_PASSWORD', 'COMPUTER_HELPER_TCP', 'COMPUTER_HELPER_TOKEN'] as const;
const saved = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe('resolveTransport', () => {
  it('defaults to the local macOS socket', () => {
    for (const key of ENV_KEYS) setEnv(key, undefined);
    const t = resolveTransport();
    expect(t.kind).toBe('socket');
    expect(t.socketPath).toMatch(/computer\.sock$/);
  });

  it('selects TCP from COMPUTER_HELPER_TCP, defaulting the host to loopback', () => {
    for (const key of ENV_KEYS) setEnv(key, undefined);
    setEnv('COMPUTER_HELPER_TCP', '9222');
    expect(resolveTransport()).toEqual({ kind: 'tcp', tcp: { host: '127.0.0.1', port: 9222 } });
  });

  it('parses an explicit host:port', () => {
    for (const key of ENV_KEYS) setEnv(key, undefined);
    setEnv('COMPUTER_HELPER_TCP', '10.0.0.4:8765');
    expect(resolveTransport()).toEqual({ kind: 'tcp', tcp: { host: '10.0.0.4', port: 8765 } });
  });

  it('lets VNC win over everything — --vnc names the desktop explicitly', () => {
    for (const key of ENV_KEYS) setEnv(key, undefined);
    setEnv('COMPUTER_HELPER_TCP', '9222');
    setEnv('COMPUTER_HELPER_VNC', '100.64.0.2:5901');
    setEnv('COMPUTER_HELPER_VNC_PASSWORD', 'hunter2');
    expect(resolveTransport()).toEqual({
      kind: 'vnc',
      vnc: { host: '100.64.0.2', port: 5901, password: 'hunter2' },
    });
  });

  it('defaults the VNC port to 5901', () => {
    for (const key of ENV_KEYS) setEnv(key, undefined);
    setEnv('COMPUTER_HELPER_VNC', 'desktop-box');
    expect(resolveTransport().vnc).toEqual({ host: 'desktop-box', port: 5901, password: '' });
  });

  it('prefers a caller-supplied endpoint over the ambient COMPUTER_HELPER_TCP', () => {
    // `start --device` has just opened a tunnel and knows its port before any
    // state file is re-read; that endpoint must win.
    for (const key of ENV_KEYS) setEnv(key, undefined);
    setEnv('COMPUTER_HELPER_TCP', '9222');
    expect(resolveTransport({ tcpOverride: { host: '127.0.0.1', port: 51234 } }))
      .toEqual({ kind: 'tcp', tcp: { host: '127.0.0.1', port: 51234 } });
  });

  it('ignores a malformed COMPUTER_HELPER_TCP rather than inventing a port', () => {
    for (const key of ENV_KEYS) setEnv(key, undefined);
    setEnv('COMPUTER_HELPER_TCP', 'not-a-port');
    expect(resolveTransport().kind).toBe('socket');
  });
});
