
import { describe, expect, it } from 'vitest';
import { generateGhOverloadShim, isGhOverloadShim } from './shims.js';
import { generateBrandShim } from './shims.js';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('generateGhOverloadShim', () => {
  const script = generateGhOverloadShim();

  it('only intercepts `pr checks`, routing it to the hidden __gh verb', () => {
    expect(script).toContain('__gh --real-gh');
    expect(script).toMatch(/\[ "\$1" = "pr" \] && \[ "\$2" = "checks" \]/);
  });

  it('carries a recursion guard (sentinel) and self-heals to real gh', () => {
    expect(script).toContain('AGENTS_GH_SHIM=1');
    expect(script).toMatch(/-n "\$AGENTS_GH_SHIM".*\n?.*exec "\$REAL_GH"/s);
    expect(script.trimEnd().endsWith('exec "$REAL_GH" "$@"')).toBe(true);
  });

  it('resolves the real gh from PATH excluding the shims dir', () => {
    expect(script).toContain('find_real_gh');
    expect(script).toContain('"$_d" = "$SHIMS_DIR"');
  });
});

describe('no real gh on PATH — fails loud, never loops (review blocker)', () => {
  it('exits 127 like command-not-found instead of infinite-recursing into itself', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-noloop-'));
    const script = generateGhOverloadShim().replace(
      /^SHIMS_DIR=.*$/m,
      `SHIMS_DIR='${dir}'`,
    );
    const shim = path.join(dir, 'gh');
    fs.writeFileSync(shim, script, { mode: 0o755 });

    const res = spawnSync('/bin/sh', [shim, 'pr', 'checks', '1'], {
      env: { PATH: dir },
      timeout: 5000,
      encoding: 'utf-8',
    });
    fs.rmSync(dir, { recursive: true, force: true });

    expect(res.signal).toBeNull();
    expect(res.status).toBe(127);
    expect(res.stderr).toContain('not found');
  });
});

describe('isGhOverloadShim', () => {
  it('recognizes our shim and rejects a brand shim / arbitrary file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-shim-'));
    const ours = path.join(dir, 'gh');
    fs.writeFileSync(ours, generateGhOverloadShim());
    const brand = path.join(dir, 'browser');
    fs.writeFileSync(brand, generateBrandShim('browser'));
    const plain = path.join(dir, 'realgh');
    fs.writeFileSync(plain, '#!/bin/sh\nexec /usr/bin/gh "$@"\n');

    expect(isGhOverloadShim(ours)).toBe(true);
    expect(isGhOverloadShim(brand)).toBe(false);
    expect(isGhOverloadShim(plain)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
