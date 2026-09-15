/**
 * The pure half of the fd-3 / fd-4 contract with the standalone `browser` engine
 * (PHNX-4101): bin resolution, how a bin is invoked, and the NDJSON framing rules.
 *
 * The wiring half — real pipes, real fds, real exit codes — is exercised by the
 * real `browser` binary at runtime; there is deliberately no stand-in engine
 * fixture, which would only prove the client agrees with itself.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  BROWSER_CONTEXT_FD,
  BROWSER_EVENTS_FD,
  BrowserClientError,
  browserInstalled,
  _resetBrowserClientForTest,
  invocation,
  parseEventLines,
  resolveBrowserBin,
} from './browser-client.js';

describe('resolveBrowserBin', () => {
  const prev = process.env.BROWSER_BIN;
  beforeEach(() => _resetBrowserClientForTest());
  afterEach(() => {
    if (prev === undefined) delete process.env.BROWSER_BIN;
    else process.env.BROWSER_BIN = prev;
    _resetBrowserClientForTest();
  });

  it('prefers $BROWSER_BIN so a dev build needs no PATH surgery', () => {
    process.env.BROWSER_BIN = '/opt/dev/browser';
    expect(resolveBrowserBin()).toBe('/opt/dev/browser');
  });

  it('resolves the standalone from PATH, skipping a leftover dist/browser.js', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-resolution-'));
    const prevPath = process.env.PATH;
    try {
      const next = path.join(root, 'next');
      const dist = path.join(root, 'agents-cli', 'dist');
      for (const dir of [next, dist]) fs.mkdirSync(dir, { recursive: true });
      // A `dist/browser.js` explicit bin is rejected (it is agents-cli's own).
      const legacy = path.join(dist, 'browser.js');
      fs.writeFileSync(legacy, '', { mode: 0o755 });
      fs.writeFileSync(path.join(next, 'browser'), '', { mode: 0o755 });
      process.env.BROWSER_BIN = '';
      process.env.PATH = next;
      expect(resolveBrowserBin()).toBe(fs.realpathSync(path.join(next, 'browser')));
      _resetBrowserClientForTest();
      process.env.BROWSER_BIN = legacy;
      expect(() => resolveBrowserBin()).toThrow(BrowserClientError);
    } finally {
      process.env.PATH = prevPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves an npm batch shim to the standalone JavaScript launcher', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-npm-'));
    try {
      const launcher = path.join(root, 'node_modules', '@phnx-labs', 'browser-cli', 'bin', 'browser.cjs');
      fs.mkdirSync(path.dirname(launcher), { recursive: true });
      fs.writeFileSync(launcher, '');
      process.env.BROWSER_BIN = path.join(root, 'browser.cmd');
      expect(resolveBrowserBin()).toBe(launcher);
      expect(invocation(resolveBrowserBin())).toEqual({ command: process.execPath, prefix: [launcher] });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('fails LOUD with install guidance when the standalone is absent — there is no fallback engine', () => {
    process.env.BROWSER_BIN = '';
    const prevPath = process.env.PATH;
    process.env.PATH = path.join(path.sep, 'definitely-not-here');
    try {
      expect(() => resolveBrowserBin()).toThrow(BrowserClientError);
      expect(() => resolveBrowserBin()).toThrow(/npm i -g @phnx-labs\/browser-cli/);
      expect(browserInstalled()).toBe(false);
    } finally {
      process.env.PATH = prevPath;
    }
  });
});

describe('invocation', () => {
  it('runs a .js/.cjs/.mjs bin through this runtime, and a real executable directly', () => {
    expect(invocation('/usr/local/bin/browser')).toEqual({ command: '/usr/local/bin/browser', prefix: [] });
    expect(invocation('/x/browser.cjs')).toEqual({ command: process.execPath, prefix: ['/x/browser.cjs'] });
  });
});

describe('the fd numbers the engine is told to use', () => {
  it('are 3 for the context and 4 for the events', () => {
    // The launcher reads these by number out of BROWSER_CONTEXT_FD /
    // BROWSER_EVENTS_FD, so changing either is a wire-protocol break.
    expect(BROWSER_CONTEXT_FD).toBe(3);
    expect(BROWSER_EVENTS_FD).toBe(4);
  });
});

describe('parseEventLines — NDJSON framing', () => {
  it('carries a trailing partial line forward instead of losing or corrupting it', () => {
    const first = parseEventLines('{"command":"navigate"}\n{"command":"scre');
    expect(first.events).toEqual([{ command: 'navigate' }]);
    expect(first.rest).toBe('{"command":"scre');

    const second = parseEventLines(first.rest + 'enshot"}\n');
    expect(second.events).toEqual([{ command: 'screenshot' }]);
    expect(second.rest).toBe('');
  });

  it('drops an unreadable line rather than throwing — the action it describes already happened', () => {
    const { events } = parseEventLines('garbage\n\n{"command":"click"}\n');
    expect(events).toEqual([{ command: 'click' }]);
  });

  it('ignores a JSON object with no command — it is not an action event', () => {
    const { events } = parseEventLines('{"hello":"world"}\n{"command":"type"}\n');
    expect(events).toEqual([{ command: 'type' }]);
  });

  it("keeps the engine's full record, including task/profile/url", () => {
    const line = JSON.stringify({
      event: 'browser.action',
      command: 'navigate',
      invocationId: 'run-1',
      pid: 900,
      task: 'swift-crab-a1b2',
      profile: 'work',
      url: 'https://example.com',
      host: 'zion',
      actor: 'claude',
    });
    const { events } = parseEventLines(line + '\n');
    expect(events[0].invocationId).toBe('run-1');
    expect(events[0].task).toBe('swift-crab-a1b2');
    expect(events[0].profile).toBe('work');
    expect(events[0].url).toBe('https://example.com');
    expect(events[0].host).toBe('zion');
  });
});
