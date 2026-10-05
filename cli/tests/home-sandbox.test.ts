/** RUSH-2639: the vitest suite must be structurally unable to touch the developer's real ~/.agents
 * (or ~/.claude, ~/.codex): tests/setup.ts redirects HOME itself before any test imports. These
 * FAIL on the old setup.ts, which pinned only specific sub-paths, and PASS once HOME is redirected. */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { getHomeDir, getUserAgentsDir } from '../src/lib/state.js';

describe('vitest HOME sandbox (RUSH-2639)', () => {
  it('process.env.HOME is redirected to a fork-private sandbox, not the real OS home', () => {
    const home = process.env.HOME;
    expect(home).toBeTruthy();
    // The real OS-reported home for this uid, ignoring any env override —
    // what a leaking test would resolve into on unfixed code.
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
    // The historical bug class: a test spawns a subprocess with the parent env spread and never
    // thinks about HOME. Before the fix that meant the developer's real HOME; now the child
    // inherits the sandboxed one.
    const out = execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(`${process.env.HOME || ""}\n${process.env.AGENTS_REAL_HOME || ""}`)'],
      { env: { ...process.env } },
    ).toString();
    expect(out).toBe(`${process.env.HOME}\n${process.env.HOME}`);
  });
});
