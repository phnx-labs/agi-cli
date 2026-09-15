import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isTermCliInstalled, runTermWizard } from './setup-term.js';

/**
 * `agents setup term` installs the standalone `term` CLI when missing
 * (PHNX-4092), the PTY engine the setup-token mint behind `agents accounts
 * add`/`login` spawns on demand (extracted PHNX-4091). agents-cli never
 * rebundles it. With PATH empty,
 * npm is unreachable so install fails closed and the wizard still returns false
 * (no throw). Presence on PATH is the whole readiness signal — there is no
 * further onboarding to configure.
 */
describe('agents setup term', () => {
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = ['TERM_BIN', 'PATH'];

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    // A PATH with no `term` on it and no explicit override — deterministic
    // "not installed" regardless of what's on the real machine running this.
    delete process.env.TERM_BIN;
    process.env.PATH = '';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('reports not installed when $TERM_BIN is unset and PATH has no `term`', () => {
    expect(isTermCliInstalled()).toBe(false);
  });

  it('prints install guidance and returns false rather than throwing', async () => {
    expect(await runTermWizard()).toBe(false);
  });

  it('reports installed once $TERM_BIN points at a real executable', () => {
    const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agents-setup-term-')), 'term');
    fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.TERM_BIN = fake;
    expect(isTermCliInstalled()).toBe(true);
  });

  it('is a no-op wizard once installed — presence is readiness, nothing to configure', async () => {
    const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agents-setup-term-')), 'term');
    fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.TERM_BIN = fake;
    expect(await runTermWizard()).toBe(true);
  });
});
