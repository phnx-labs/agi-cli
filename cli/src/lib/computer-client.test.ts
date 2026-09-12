/**
 * The pure half of the fd-3 / fd-4 contract: bin resolution, how a bin is
 * invoked, and the NDJSON framing rules.
 *
 * The wiring half — real pipes, real fds, real exit codes — is
 * `computer-client.e2e.test.ts`, which drives the REAL compiled `computer`
 * engine. There is deliberately no stand-in engine fixture: a fake implements
 * whatever protocol we assumed, so it proves the client agrees with itself
 * rather than with the thing it has to talk to.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
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
} from './computer-client.js';

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

  it('fails LOUD with install guidance when the standalone is absent — there is no fallback engine', () => {
    process.env.COMPUTER_BIN = '';
    // An empty PATH is the honest "not installed" shape; findInPath finds nothing.
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
    // The engine reads these by number out of COMPUTER_CONTEXT_FD /
    // COMPUTER_EVENTS_FD, so changing either is a wire-protocol break.
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
