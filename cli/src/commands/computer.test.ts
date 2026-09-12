import { describe, expect, it } from 'vitest';
import {
  COMPUTER_PASSTHROUGH_VERBS,
  parseTrustFromStatusJson,
  shouldBlockOffPlatform,
  withDeviceFlag,
} from './computer.js';

// The `computer` preAction hook calls process.exit(1) exactly when
// shouldBlockOffPlatform() is true. These cases pin the rule that off-macOS
// invocations are NOT blocked once a remote daemon is reachable.
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
    // A Linux host with a tunnel to a Windows daemon must be allowed to drive it.
    expect(shouldBlockOffPlatform({ platform: 'linux', tcpConfigured: true })).toBe(false);
  });

  it('does NOT block off macOS when a --device remote device is given', () => {
    // The engine resolves and hydrates the endpoint for that device itself.
    expect(shouldBlockOffPlatform({ platform: 'linux', tcpConfigured: false, device: 'win-mini' })).toBe(false);
  });

  it('does NOT block off macOS when a --vnc desktop is configured', () => {
    // A Linux host driving a GUI desktop over RFB/VNC must be allowed.
    expect(shouldBlockOffPlatform({ platform: 'linux', tcpConfigured: false, vncConfigured: true })).toBe(false);
  });
});

// The verb catalog is agents-cli's half of the contract with the standalone
// engine: it is what `agents computer --help` lists and what the help groups
// index. A verb dropped here silently disappears from the surface even though
// the engine still implements it, so the catalog is pinned.
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

// The trust probe is the one place agents-cli reads engine stdout instead of
// passing it through, so its parsing has to survive real-world output shapes.
describe('parseTrustFromStatusJson', () => {
  it('reads trusted:true out of a clean JSON status', () => {
    expect(parseTrustFromStatusJson('{"trusted":true,"pid":4211}')).toBe(true);
  });

  it('reads trusted:false', () => {
    expect(parseTrustFromStatusJson('{"trusted":false}')).toBe(false);
  });

  it('tolerates a banner line printed before the JSON', () => {
    expect(parseTrustFromStatusJson('checking helper...\n{"trusted":true}\n')).toBe(true);
  });

  it('returns false — never throws — on empty or unparseable output', () => {
    // The wizard polls this while the user is in System Settings; a throw would
    // abort the very flow that fixes the untrusted state.
    expect(parseTrustFromStatusJson('')).toBe(false);
    expect(parseTrustFromStatusJson('daemon not running')).toBe(false);
    expect(parseTrustFromStatusJson('{oops')).toBe(false);
  });

  it('treats a missing or non-boolean `trusted` as untrusted', () => {
    expect(parseTrustFromStatusJson('{"pid":1}')).toBe(false);
    expect(parseTrustFromStatusJson('{"trusted":"yes"}')).toBe(false);
  });
});

// The engine selects the remote path from its OWN argv, but commander consumes
// the `--device` each verb declares — so the consumer has to put it back. This
// is the regression that made `agents computer setup --device win-mini` install
// the macOS helper locally instead of provisioning the Windows box.
describe('withDeviceFlag', () => {
  it('re-inserts --device right after the verb so the engine sees the remote selector', () => {
    expect(withDeviceFlag(['setup'], 'win-mini')).toEqual(['setup', '--device', 'win-mini']);
  });

  it('keeps the verb\'s own operands, after the flag', () => {
    expect(withDeviceFlag(['screenshot', '-o', '/tmp/win.png'], 'win-mini'))
      .toEqual(['screenshot', '--device', 'win-mini', '-o', '/tmp/win.png']);
  });

  it('leaves a local invocation untouched', () => {
    expect(withDeviceFlag(['apps', '--json'])).toEqual(['apps', '--json']);
  });
});
