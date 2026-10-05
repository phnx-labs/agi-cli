import { describe, it, expect, afterEach } from 'vitest';
import type { Command } from 'commander';

import { resolveSurface } from './utils.js';

function fakeCmd(opts: Record<string, unknown>): Command {
  return { optsWithGlobals: () => opts } as unknown as Command;
}

const origIn = process.stdin.isTTY;
const origOut = process.stdout.isTTY;
function setTty(v: boolean): void {
  (process.stdin as { isTTY?: boolean }).isTTY = v;
  (process.stdout as { isTTY?: boolean }).isTTY = v;
}
afterEach(() => {
  (process.stdin as { isTTY?: boolean }).isTTY = origIn;
  (process.stdout as { isTTY?: boolean }).isTTY = origOut;
});

describe('resolveSurface', () => {
  it('reads --json / --quiet / --yes from the merged option set', () => {
    setTty(true);
    const s = resolveSurface(fakeCmd({ json: true, quiet: true, yes: true }));
    expect(s.json).toBe(true);
    expect(s.quiet).toBe(true);
    expect(s.assumeYes).toBe(true);
  });

  it('assumeYes is true in a non-interactive shell even without --yes (no one to prompt)', () => {
    setTty(false);
    const s = resolveSurface(fakeCmd({}));
    expect(s.assumeYes).toBe(true);
    expect(s.interactive).toBe(false);
  });

  it('assumeYes is false at a TTY without --yes (a human should be asked)', () => {
    setTty(true);
    const s = resolveSurface(fakeCmd({}));
    expect(s.assumeYes).toBe(false);
    expect(s.interactive).toBe(true);
  });

  it('--json forces interactive=false even at a real TTY (a JSON consumer is a machine)', () => {
    setTty(true);
    const s = resolveSurface(fakeCmd({ json: true }));
    expect(s.json).toBe(true);
    expect(s.interactive).toBe(false);
  });

  it('defaults are all false/off when no flags and no TTY info', () => {
    setTty(false);
    const s = resolveSurface(fakeCmd({}));
    expect(s.json).toBe(false);
    expect(s.quiet).toBe(false);
    expect(s.interactive).toBe(false);
    expect(s.assumeYes).toBe(true);
  });
});
