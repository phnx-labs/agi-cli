import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  COMPUTER_CONTEXT_FD,
  COMPUTER_EVENTS_FD,
  ComputerClientError,
  _resetComputerClientForTest,
  invocation,
  parseEventLines,
  resolveComputerBin,
  parseTrustFromStatusJson,
  resolveDeviceHost,
  withHostFlag,
} from './computer-client.js';

const mockGetConfigValue = vi.fn();
const mockResolveRemoteDevice = vi.fn();
vi.mock('./device-config.js', () => ({ getConfigValue: (...args: unknown[]) => mockGetConfigValue(...args) }));
vi.mock('./ssh-tunnel.js', () => ({ resolveRemoteDevice: (...args: unknown[]) => mockResolveRemoteDevice(...args) }));

describe('resolveComputerBin', () => {
  const prev = process.env.COMPUTER_BIN;
  beforeEach(() => _resetComputerClientForTest());
  afterEach(() => {
    if (prev === undefined) delete process.env.COMPUTER_BIN;
    else process.env.COMPUTER_BIN = prev;
    _resetComputerClientForTest();
  });

  it('prefers $COMPUTER_BIN so a dev build needs no PATH surgery', () => {
    process.env.COMPUTER_BIN = '/opt/dev/computer';
    expect(resolveComputerBin()).toBe('/opt/dev/computer');
  });

  it('skips the old npm computer bin and resolves a later standalone', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-resolution-'));
    const prevPath = process.env.PATH;
    try {
      const old = path.join(root, 'old');
      const next = path.join(root, 'next');
      const dist = path.join(root, 'agents-cli', 'dist');
      for (const dir of [old, next, dist]) fs.mkdirSync(dir, { recursive: true });
      const legacy = path.join(dist, 'computer.js');
      fs.writeFileSync(legacy, '', { mode: 0o755 });
      fs.symlinkSync(legacy, path.join(old, 'computer'));
      fs.writeFileSync(path.join(next, 'computer'), '', { mode: 0o755 });
      process.env.COMPUTER_BIN = '';
      process.env.PATH = [old, next].join(path.delimiter);
      expect(resolveComputerBin()).toBe(fs.realpathSync(path.join(next, 'computer')));
      _resetComputerClientForTest();
      process.env.COMPUTER_BIN = path.join(old, 'computer');
      expect(() => resolveComputerBin()).toThrow(ComputerClientError);
    } finally {
      process.env.PATH = prevPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves an npm batch shim to the standalone JavaScript launcher', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-npm-'));
    try {
      const launcher = path.join(root, 'node_modules', '@phnx-labs', 'computer-cli', 'bin', 'computer.cjs');
      fs.mkdirSync(path.dirname(launcher), { recursive: true });
      fs.writeFileSync(launcher, '');
      process.env.COMPUTER_BIN = path.join(root, 'computer.cmd');
      expect(resolveComputerBin()).toBe(launcher);
      expect(invocation(resolveComputerBin())).toEqual({ command: process.execPath, prefix: [launcher] });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('fails LOUD with install guidance when the standalone is absent — there is no fallback engine', () => {
    process.env.COMPUTER_BIN = '';
    const prevPath = process.env.PATH;
    process.env.PATH = path.join(path.sep, 'definitely-not-here');
    try {
      expect(() => resolveComputerBin()).toThrow(ComputerClientError);
      expect(() => resolveComputerBin()).toThrow(/npm i -g @phnx-labs\/computer-cli/);
    } finally {
      process.env.PATH = prevPath;
    }
  });
});

describe('invocation', () => {
  it('runs a .js/.mjs bin through this runtime, and a real executable directly', () => {
    expect(invocation('/usr/local/bin/computer')).toEqual({ command: '/usr/local/bin/computer', prefix: [] });
    expect(invocation('/x/computer.mjs')).toEqual({ command: process.execPath, prefix: ['/x/computer.mjs'] });
  });
});

describe('the fd numbers the engine is told to use', () => {
  it('are 3 for the context and 4 for the events', () => {
    expect(COMPUTER_CONTEXT_FD).toBe(3);
    expect(COMPUTER_EVENTS_FD).toBe(4);
  });
});

describe('parseEventLines — NDJSON framing', () => {
  it('carries a trailing partial line forward instead of losing or corrupting it', () => {
    const first = parseEventLines('{"command":"click"}\n{"command":"ty');
    expect(first.events).toEqual([{ command: 'click' }]);
    expect(first.rest).toBe('{"command":"ty');

    const second = parseEventLines(first.rest + 'pe"}\n');
    expect(second.events).toEqual([{ command: 'type' }]);
    expect(second.rest).toBe('');
  });

  it('drops an unreadable line rather than throwing — the action it describes already happened', () => {
    const { events } = parseEventLines('garbage\n\n{"command":"key"}\n');
    expect(events).toEqual([{ command: 'key' }]);
  });

  it('ignores a JSON object with no command — it is not an action event', () => {
    const { events } = parseEventLines('{"hello":"world"}\n{"command":"focus"}\n');
    expect(events).toEqual([{ command: 'focus' }]);
  });

  it('keeps the engine\'s full record, not a narrowed projection of it', () => {
    const line = JSON.stringify({
      event: 'computer.action',
      command: 'click',
      invocationId: 'run-1',
      pid: 900,
      targetPid: 4211,
      bundle: 'com.apple.notes',
      host: 'win-mini',
      actor: 'muqsit',
    });
    const { events } = parseEventLines(line + '\n');
    expect(events[0].invocationId).toBe('run-1');
    expect(events[0].host).toBe('win-mini');
    expect(events[0].actor).toBe('muqsit');
  });
});

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
    expect(parseTrustFromStatusJson('')).toBe(false);
    expect(parseTrustFromStatusJson('daemon not running')).toBe(false);
    expect(parseTrustFromStatusJson('{oops')).toBe(false);
  });

  it('treats a missing or non-boolean `trusted` as untrusted', () => {
    expect(parseTrustFromStatusJson('{"pid":1}')).toBe(false);
    expect(parseTrustFromStatusJson('{"trusted":"yes"}')).toBe(false);
  });
});

describe('withHostFlag', () => {
  it('re-inserts --host right after the verb so the engine sees the remote selector', () => {
    expect(withHostFlag(['setup'], 'ssh://Administrator@win-mini')).toEqual(['setup', '--host', 'ssh://Administrator@win-mini']);
  });

  it('keeps the verb\'s own operands, after the flag', () => {
    expect(withHostFlag(['screenshot', '-o', '/tmp/win.png'], 'vnc://10.0.0.5:5901'))
      .toEqual(['screenshot', '--host', 'vnc://10.0.0.5:5901', '-o', '/tmp/win.png']);
  });

  it('leaves a local invocation untouched', () => {
    expect(withHostFlag(['apps', '--json'])).toEqual(['apps', '--json']);
  });

  it('never overwrites an explicit --host the caller already typed', () => {
    expect(withHostFlag(['screenshot', '--host', 'vnc://explicit:5901'], 'ssh://fallback@win-mini'))
      .toEqual(['screenshot', '--host', 'vnc://explicit:5901']);
  });
});

describe('resolveDeviceHost', () => {
  beforeEach(() => {
    mockGetConfigValue.mockReset();
    mockResolveRemoteDevice.mockReset();
  });

  it('forwards a vnc:// computer.host with no fleet ssh identity resolution', async () => {
    mockGetConfigValue.mockReturnValue({ value: 'vnc://10.0.0.5:5901' });
    const result = await resolveDeviceHost('linux-desk');
    expect(result.host).toBe('vnc://10.0.0.5:5901');
    expect(result.target.sshArgs).toEqual([]);
    expect(mockResolveRemoteDevice).not.toHaveBeenCalled();
  });

  it('resolves fleet ssh identity for an ssh:// computer.host, with no Windows expectation', async () => {
    mockGetConfigValue.mockReturnValue({ value: 'ssh://muqsit@linux-desk' });
    mockResolveRemoteDevice.mockResolvedValue({
      target: 'muqsit@linux-desk', user: 'muqsit', host: 'linux-desk',
      device: { platform: 'linux' }, identityArgs: ['-i', '/key'],
    });
    const result = await resolveDeviceHost('linux-desk');
    expect(result.host).toBe('ssh://muqsit@linux-desk');
    expect(result.target.sshArgs).toEqual(['-i', '/key']);
    expect(mockResolveRemoteDevice).toHaveBeenCalledWith('linux-desk', {});
  });

  it('uses the configured ssh:// host/user, not the registry\'s own resolution, when they disagree', async () => {
    mockGetConfigValue.mockReturnValue({ value: 'ssh://otheruser@otherhost:2222' });
    mockResolveRemoteDevice.mockResolvedValue({
      target: 'muqsit@linux-desk', user: 'muqsit', host: 'linux-desk',
      device: { platform: 'linux' }, identityArgs: ['-i', '/key'],
    });
    const result = await resolveDeviceHost('linux-desk');
    expect(result.host).toBe('ssh://otheruser@otherhost:2222');
    expect(result.target.host).toBe('otheruser@otherhost');
    expect(result.target.hostname).toBe('otherhost');
    expect(result.target.sshArgs).toEqual(['-i', '/key']);
  });

  it('falls back to the Windows-only fleet ssh tunnel with no computer.host configured', async () => {
    mockGetConfigValue.mockReturnValue({ value: undefined });
    mockResolveRemoteDevice.mockResolvedValue({
      target: 'Administrator@win-mini', user: 'Administrator', host: 'win-mini',
      device: { platform: 'windows' }, identityArgs: [],
    });
    const result = await resolveDeviceHost('win-mini');
    expect(result.host).toBe('ssh://Administrator@win-mini');
    expect(mockResolveRemoteDevice).toHaveBeenCalledWith('win-mini', expect.objectContaining({ expectPlatform: 'windows' }));
  });
});
