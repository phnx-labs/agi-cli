/** The gh overload shim's script must be a faithful, self-healing passthrough: recursion-
 * guarded, intercepting only `pr checks`, and degrading to real gh when agents-cli is gone, so
 * a leftover shim can never break `gh`. */

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
    // If the sentinel is set OR agents-cli is missing, exec the real gh.
    expect(script).toMatch(/-n "\$AGENTS_GH_SHIM".*\n?.*exec "\$REAL_GH"/s);
    // The default tail passes every non-`pr checks` verb straight to real gh.
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
    // Bake SHIMS_DIR to this dir so find_real_gh skips it — the shim is then the
    // ONLY `gh` reachable, the exact gh-less condition that used to loop forever.
    const script = generateGhOverloadShim().replace(
      /^SHIMS_DIR=.*$/m,
      `SHIMS_DIR='${dir}'`,
    );
    const shim = path.join(dir, 'gh');
    fs.writeFileSync(shim, script, { mode: 0o755 });

    // Absolute /bin/sh so spawn finds the interpreter; PATH=dir means the ONLY
    // `gh` the shim can resolve is itself (the shim uses shell builtins only).
    const res = spawnSync('/bin/sh', [shim, 'pr', 'checks', '1'], {
      env: { PATH: dir },
      timeout: 5000,
      encoding: 'utf-8',
    });
    fs.rmSync(dir, { recursive: true, force: true });

    expect(res.signal).toBeNull(); // NOT killed by the timeout => it did not hang/loop
    expect(res.status).toBe(127); // clean command-not-found
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
