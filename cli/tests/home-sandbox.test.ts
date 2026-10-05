import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { getHomeDir, getUserAgentsDir } from '../src/lib/state.js';


describe('vitest HOME sandbox (RUSH-2639)', () => {
  it('process.env.HOME is redirected to a fork-private sandbox, not the real OS home', () => {
    const home = process.env.HOME;
    expect(home).toBeTruthy();
    const realOsHome = os.userInfo().homedir;
    expect(home).not.toBe(realOsHome);
    expect(path.basename(path.dirname(home as string))).toMatch(/^agents-vitest-/);
  });

  it('state.ts captured the sandboxed HOME at import time, not the real home', () => {
    const realOsHome = os.userInfo().homedir;
    expect(getHomeDir()).toBe(process.env.HOME);
    expect(getUserAgentsDir()).toBe(path.join(process.env.HOME as string, '.agents'));
    expect(getUserAgentsDir()).not.toBe(path.join(realOsHome, '.agents'));
  });

  it('pins the explicit real-home seam to the same fork-private sandbox', () => {
    expect(process.env.AGENTS_REAL_HOME).toBe(process.env.HOME);
    expect(process.env.AGENTS_REAL_HOME).not.toBe(os.userInfo().homedir);
  });

  it('a naive subprocess spawn (env: {...process.env}) inherits the sandboxed HOME for free', () => {
    const out = execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(`${process.env.HOME || ""}\n${process.env.AGENTS_REAL_HOME || ""}`)'],
      { env: { ...process.env } },
    ).toString();
    expect(out).toBe(`${process.env.HOME}\n${process.env.HOME}`);
  });
});
