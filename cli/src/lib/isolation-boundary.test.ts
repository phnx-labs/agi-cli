import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/** Completeness guard: pins the list of primitives that adopt an agent, each of which must call
 * `isVersionIsolated`. The boundary leaked three times as a convention (#1412, #1423, #1439). */
describe('isolation boundary — the gate is on every adopting primitive', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf-8');

  // Every primitive that can carry an agent across the boundary, and the file it
  // lives in. Adding one here without a gate fails the assertion below.
  const GATED: Array<{ fn: string; file: string }> = [
    { fn: 'createShim', file: 'src/lib/installations/shims.ts' },
    { fn: 'switchConfigSymlink', file: 'src/lib/installations/shims.ts' },
    { fn: 'switchHomeFileSymlinks', file: 'src/lib/installations/shims.ts' },
    { fn: 'adoptShadowingLauncher', file: 'src/lib/installations/shims.ts' },
    { fn: 'setGlobalDefault', file: 'src/lib/installations/versions.ts' },
  ];

  it.each(GATED)('$fn calls assertIsolationBoundary before doing anything', ({ fn, file }) => {
    const src = read(file);
    const start = src.indexOf(`export function ${fn}`) >= 0
      ? src.indexOf(`export function ${fn}`)
      : src.indexOf(`export async function ${fn}`);
    expect(start, `${fn} not found in ${file}`).toBeGreaterThan(-1);
    // Look only at the function's opening stretch — the gate must come before work.
    const head = src.slice(start, start + 1400);
    expect(head).toContain('assertIsolationBoundary');
  });

  it('no OTHER exported function in shims.ts writes to the real config dir ungated', () => {
    const src = read('src/lib/installations/shims.ts');
    // getAgentConfigPath() resolves the user's real ~/.<agent>. Any exported function
    // that both resolves it and mutates the filesystem is a boundary crossing.
    const MUTATORS = /\b(symlinkSync|renameSync|rmSync|unlinkSync|cpSync|writeFileSync)\s*\(/;
    // `repointAdoptedConfigToHome` has its own guard: it only retargets an already-adopted symlink
    // to an account slot home (PHNX-3940 T5) and refuses on a real directory, so it cannot call
    // `assertIsolationBoundary`.
    const OWN_GUARD_EXEMPT = new Set(['repointAdoptedConfigToHome']);
    // Bound each body at the next function declaration of ANY kind; slicing to the next exported
    // one pinned private helpers' mutations on the preceding export.
    const decls = [...src.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)];
    const offenders: string[] = [];
    for (let i = 0; i < decls.length; i++) {
      const name = decls[i][1];
      if (!decls[i][0].startsWith('export')) continue;
      const body = src.slice(decls[i].index!, decls[i + 1]?.index ?? src.length);
      if (!body.includes('getAgentConfigPath(')) continue;
      if (!MUTATORS.test(body)) continue;
      if (body.includes('assertIsolationBoundary')) continue;
      if (OWN_GUARD_EXEMPT.has(name) && body.includes('refusing to replace a real config directory')) continue;
      offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it('no file outside the gated primitives hand-rolls config-dir adoption', () => {
    // Scan the whole command/lib surface for the adoption shape, not just shims.ts: setup.ts once
    // did a hand-rolled adoption (rename + symlink) that bypassed every primitive.
    const roots = ['src/commands', 'src/lib'];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.resolve(process.cwd(), dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) files.push(rel);
      }
    };
    roots.forEach(walk);

    const offenders: string[] = [];
    for (const f of files) {
      const src = read(f);
      // Adoption's signature is moving the user's real config dir elsewhere. A looser match
      // flagged migrate.ts, which only repoints an already-symlinked config and never moves a real
      // directory.
      if (!/renameSync\(\s*(configDir|getAgentConfigPath\()/.test(src)) continue;
      if (src.includes('assertIsolationBoundary')) continue;
      offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('the predicate ignores scaffolding, so an adopting path cannot disarm it', () => {
    // Only real installs (node_modules/ or package.json) count toward protection; if bare dirs
    // counted, creating `<version>/home` before adopting would flip protection off and pass every
    // check.
    const src = read('src/lib/installations/shims.ts');
    const start = src.indexOf('export function isIsolationProtected');
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).toMatch(/node_modules|package\.json/);
  });

  it('the predicate is derived from the .isolated markers, not from stored config', () => {
    // Protection must not depend on a setting someone can leave in the wrong state —
    // it is computed from what is actually installed.
    const src = read('src/lib/installations/shims.ts');
    const start = src.indexOf('export function isIsolationProtected');
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).toContain('isInstalledVersionIsolated');
    expect(body).not.toContain('readMeta');
  });
});
