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

  it('gives every verb a description, since that is the only help agents-cli owns', () => {
    for (const verb of COMPUTER_PASSTHROUGH_VERBS) {
      expect(verb.description.length).toBeGreaterThan(10);
    }
  });
});

describe.skipIf(process.platform === 'darwin' || process.platform === 'win32')('agents computer sessions off macOS', () => {
  it('lists the engine history without the local-driving gate', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { runAgents, writeUpdateCache } = await import('./sessions.test-fixture.js');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-computer-sessions-'));
    try {
      writeUpdateCache(home);
      const testdata = path.resolve(import.meta.dirname, '../lib/feed/testdata');
      const argvLog = path.join(home, 'argv.log');
      const result = runAgents(['computer', 'sessions', '--json', '--no-interactive'], home, home, {
        COMPUTER_BIN: path.join(testdata, 'bin', 'computer'),
        COMPUTER_SESSIONS_FIXTURE: path.join(testdata, 'computer-sessions.json'),
        TOOL_FIXTURE_ARGV_LOG: argvLog,
      });
      expect(result.stderr).not.toContain('macOS only for local driving');
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(JSON.parse(fs.readFileSync(path.join(testdata, 'computer-sessions.json'), 'utf8')));
      expect(fs.readFileSync(argvLog, 'utf8').trim()).toBe('computer sessions --json --no-interactive');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
