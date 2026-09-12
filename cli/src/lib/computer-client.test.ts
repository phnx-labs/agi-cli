/**
 * The fd-3 / fd-4 contract with the standalone `computer` engine, exercised
 * against a REAL child process (`testdata/fake-computer-engine.mjs`) over real
 * pipes — no mocking of spawn, of the fds, or of the framing. The fixture
 * implements the engine's half of the protocol; if the wiring here is wrong,
 * these tests fail the way production would.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPUTER_CONTEXT_FD,
  COMPUTER_EVENTS_FD,
  ComputerClientError,
  _resetComputerClientForTest,
  invocation,
  parseEventLines,
  resolveComputerBin,
  runComputer,
  type ComputerActionEvent,
} from './computer-client.js';

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata', 'fake-computer-engine.mjs');

const SAMPLE_CONTEXT = { version: 1 as const, marker: 'from-agents-cli' };

function withEngine(argv: string[], opts: Parameters<typeof runComputer>[0] extends infer T ? Partial<T> : never = {}) {
  return runComputer({ argv, context: SAMPLE_CONTEXT, ...opts } as Parameters<typeof runComputer>[0]);
}

describe('resolveComputerBin', () => {
  const prev = process.env.COMPUTER_BIN;
  beforeEach(() => _resetComputerClientForTest());
  afterEach(() => {
    if (prev === undefined) delete process.env.COMPUTER_BIN;
    else process.env.COMPUTER_BIN = prev;
    _resetComputerClientForTest();
  });

  it('prefers $COMPUTER_BIN so a dev build needs no PATH surgery', () => {
    process.env.COMPUTER_BIN = ENGINE;
    expect(resolveComputerBin()).toBe(ENGINE);
  });

  it('fails LOUD with install guidance when the standalone is absent — there is no fallback engine', () => {
    process.env.COMPUTER_BIN = '';
    // An empty PATH is the honest "not installed" shape; findInPath finds nothing.
    const prevPath = process.env.PATH;
    process.env.PATH = path.join(path.dirname(ENGINE), 'definitely-not-here');
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

describe('parseEventLines — NDJSON framing', () => {
  it('carries a trailing partial line forward instead of losing or corrupting it', () => {
    const first = parseEventLines('{"verb":"click"}\n{"verb":"ty');
    expect(first.events).toEqual([{ verb: 'click' }]);
    expect(first.rest).toBe('{"verb":"ty');

    const second = parseEventLines(first.rest + 'pe"}\n');
    expect(second.events).toEqual([{ verb: 'type' }]);
    expect(second.rest).toBe('');
  });

  it('drops an unreadable line rather than throwing — the action it describes already happened', () => {
    const { events } = parseEventLines('garbage\n\n{"verb":"key"}\n');
    expect(events).toEqual([{ verb: 'key' }]);
  });

  it('ignores a JSON object with no verb — it is not an action event', () => {
    const { events } = parseEventLines('{"hello":"world"}\n{"verb":"focus"}\n');
    expect(events).toEqual([{ verb: 'focus' }]);
  });
});

describe('runComputer — the live passthrough', () => {
  const prev = process.env.COMPUTER_BIN;
  beforeEach(() => {
    process.env.COMPUTER_BIN = ENGINE;
    _resetComputerClientForTest();
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.COMPUTER_BIN;
    else process.env.COMPUTER_BIN = prev;
    _resetComputerClientForTest();
  });

  it('delivers the context on fd 3, and names the fds in the environment', async () => {
    const { exitCode, stdout } = await withEngine(['echo-context'], { capture: true });
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(SAMPLE_CONTEXT);
    // The fixture read fd 3 by number from the env, so a wrong number would have
    // thrown there rather than produced this output.
    expect(COMPUTER_CONTEXT_FD).toBe(3);
    expect(COMPUTER_EVENTS_FD).toBe(4);
  });

  it('surfaces every action event the engine streams back on fd 4', async () => {
    const seen: ComputerActionEvent[] = [];
    const { exitCode } = await withEngine(['emit', '3'], { onEvent: (e) => seen.push(e) });
    expect(exitCode).toBe(0);
    expect(seen.map((e) => e.targetPid)).toEqual([100, 101, 102]);
    expect(seen.every((e) => e.verb === 'click')).toBe(true);
  });

  it('keeps the good events when the engine writes an unparseable line', async () => {
    const seen: ComputerActionEvent[] = [];
    await withEngine(['emit-garbage'], { onEvent: (e) => seen.push(e) });
    expect(seen).toEqual([{ verb: 'type' }]);
  });

  it('does not lose a final event that has no trailing newline', async () => {
    const seen: ComputerActionEvent[] = [];
    await withEngine(['emit-partial'], { onEvent: (e) => seen.push(e) });
    expect(seen).toEqual([{ verb: 'key' }]);
  });

  it('propagates the engine exit code so a failed verb fails the command', async () => {
    expect((await withEngine(['exit', '3'])).exitCode).toBe(3);
    expect((await withEngine(['exit', '0'])).exitCode).toBe(0);
  });

  it('survives an engine that exits before reading the context (EPIPE on fd 3)', async () => {
    // `--help` and a bad argv both do this in practice. The write must not
    // crash the CLI with an unhandled EPIPE.
    const { exitCode } = await withEngine(['ignore-context']);
    expect(exitCode).toBe(7);
  });

  it('fails loud when the executable does not exist', async () => {
    process.env.COMPUTER_BIN = '/nonexistent/computer-engine-binary';
    _resetComputerClientForTest();
    await expect(withEngine(['apps'])).rejects.toThrow(/Could not run/);
  });
});
