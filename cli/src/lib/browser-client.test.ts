import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  BROWSER_CONTEXT_FD,
  BrowserClientError,
  browserInstalled,
  _resetBrowserClientForTest,
  invocation,
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

describe('the fd the engine is told to read its context from', () => {
  it('is 3', () => {
    expect(BROWSER_CONTEXT_FD).toBe(3);
  });
});
