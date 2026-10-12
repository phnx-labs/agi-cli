import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  COMPUTER_CONTEXT_FD,
  ComputerClientError,
  _resetComputerClientForTest,
  invocation,
  resolveComputerBin,
  parseTrustFromStatusJson,
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
  it('are 3 for the context', () => {
    expect(COMPUTER_CONTEXT_FD).toBe(3);
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
