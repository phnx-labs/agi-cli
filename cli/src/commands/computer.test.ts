import { describe, expect, it } from 'vitest';
import { COMPUTER_PASSTHROUGH_VERBS, shouldBlockOffPlatform } from './computer.js';

describe('shouldBlockOffPlatform', () => {
  it('never blocks on macOS (local Accessibility path)', () => {
    expect(shouldBlockOffPlatform({ platform: 'darwin', tcpConfigured: false })).toBe(false);
    expect(shouldBlockOffPlatform({ platform: 'darwin', tcpConfigured: true, device: 'win-mini' })).toBe(false);
  });

  it('blocks off macOS with no remote path configured', () => {
    expect(shouldBlockOffPlatform({ platform: 'linux', tcpConfigured: false })).toBe(true);
    expect(shouldBlockOffPlatform({ platform: 'win32', tcpConfigured: false })).toBe(true);
  });

  it('does NOT block off macOS when COMPUTER_HELPER_TCP is configured', () => {
    expect(shouldBlockOffPlatform({ platform: 'linux', tcpConfigured: true })).toBe(false);
  });

  it('does NOT block off macOS when a --device remote device is given', () => {
    expect(shouldBlockOffPlatform({ platform: 'linux', tcpConfigured: false, device: 'win-mini' })).toBe(false);
  });

  it('does NOT block off macOS when a --vnc desktop is configured', () => {
    expect(shouldBlockOffPlatform({ platform: 'linux', tcpConfigured: false, vncConfigured: true })).toBe(false);
  });
});

describe('COMPUTER_PASSTHROUGH_VERBS', () => {
  const names = COMPUTER_PASSTHROUGH_VERBS.map((v) => v.name);

  it('carries every interaction and observation verb the surface documents', () => {
    expect(names).toEqual([
      'run', 'apps', 'describe', 'screenshot', 'get-text', 'launch', 'raise',
      'click', 'right-click', 'type', 'type-text', 'key', 'drag', 'scroll',
      'ax-action', 'focus', 'wait',
    ]);
  });

  it('does NOT include the lifecycle verbs — those render the allow list before forwarding', () => {
    for (const lifecycle of ['setup', 'start', 'stop', 'reload', 'status']) {
      expect(names).not.toContain(lifecycle);
    }
  });

  it('does NOT include `sessions` — it reads agents-cli\'s own ledger and never reaches the engine', () => {
    expect(names).not.toContain('sessions');
  });

  it('gives every verb a description, since that is the only help agents-cli owns', () => {
    for (const verb of COMPUTER_PASSTHROUGH_VERBS) {
      expect(verb.description.length).toBeGreaterThan(10);
    }
  });
});
