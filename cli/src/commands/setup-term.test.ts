import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isTermCliInstalled, runTermWizard } from './setup-term.js';

describe('agents setup term', () => {
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = ['TERM_BIN', 'PATH'];

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
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
