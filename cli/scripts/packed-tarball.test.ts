/**
 * Proves the packed `@phnx-labs/agents-cli` tarball ships no trace of the
 * in-repo secrets engine (PHNX-3989 DIST-1) — a real `tsc` build + real
 * `npm pack` + a real `tar tzf` of the produced .tgz, not a grep of the
 * `files` allowlist in package.json. The engine (`cli/src/lib/secrets/**`,
 * the keychain-helper Swift source, the two build/verify scripts) is gone
 * from this repo; this test is what would catch it coming back inside the
 * shipped artifact even if a future change re-added the source elsewhere.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CLI_ROOT = path.resolve(__dirname, '..');

function packedEntries(): string[] {
  // Build into a throwaway package dir and pack THAT — never the live `dist/`.
  //
  // `dist/` is gitignored and `tsc` never deletes an output whose source is gone,
  // so on a reused worktree (a fleet test-runner's cached tree, in particular) a
  // rebuild in place still leaves yesterday's `dist/lib/secrets/*.js` sitting
  // beside today's output, and `npm pack` ships them: this test then fails on a
  // tree that is actually clean (the 1.22.85 attestation run on a shard box).
  // Wiping `dist/` first is not an option either — other tests in the same run
  // exec `dist/index.js`. Build into a fresh dir to check the CLI allowlist and
  // secrets exclusion. The release producer's build.sh also bundles the session
  // tracker; release-attestation-produce.test.ts covers that packaging step.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-pack-'));
  try {
    execFileSync(
      path.join(CLI_ROOT, 'node_modules', '.bin', 'tsc'),
      ['-p', CLI_ROOT, '--outDir', path.join(stage, 'dist')],
      { cwd: CLI_ROOT, stdio: 'inherit' },
    );
    // Everything else the `files` allowlist admits, copied from the tree so the
    // pack sees the same allowlist against the same non-dist inputs a release does.
    // `prepack` (`cp ../README.md README.md`) is what puts README.md in place, so
    // do that copy here. The staged package.json carries NO `scripts` block: the
    // allowlist alone decides tarball content, and `npm pack --ignore-scripts` is
    // not honored for `prepare` on every npm (the GitHub runner's ran
    // `prepare` -> `npm run build` -> a global tsc against a dir with no
    // tsconfig and failed the pack) — the flag is a courtesy, the absent block is
    // the guarantee.
    const pkg = JSON.parse(fs.readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf-8')) as {
      files: string[];
      scripts?: Record<string, string>;
    };
    for (const entry of pkg.files) {
      if (entry.startsWith('dist/')) continue;
      const src = path.join(CLI_ROOT, entry);
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.dirname(path.join(stage, entry)), { recursive: true });
      fs.cpSync(src, path.join(stage, entry), { recursive: true });
    }
    const { scripts: _scripts, ...packable } = pkg;
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(packable, null, 2));
    fs.copyFileSync(path.join(CLI_ROOT, '..', 'README.md'), path.join(stage, 'README.md'));

    const pack = spawnSync('npm', ['pack', '--silent', '--ignore-scripts', '--pack-destination', stage], {
      cwd: stage,
      encoding: 'utf-8',
    });
    if (pack.status !== 0) {
      throw new Error(`npm pack failed (status ${pack.status}): ${pack.stdout}${pack.stderr}`);
    }
    const tgzName = pack.stdout.trim().split('\n').pop()!;
    const tgzPath = path.join(stage, tgzName);
    expect(fs.existsSync(tgzPath), `npm pack did not produce ${tgzName} in ${stage}`).toBe(true);
    const listing = execFileSync('tar', ['tzf', tgzPath], { encoding: 'utf-8' });
    return listing.trim().split('\n');
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

describe('packed tarball excludes the in-repo secrets engine (PHNX-3989)', () => {
  const entries = packedEntries();

  it('is non-empty and carries the real entry point', () => {
    expect(entries.length).toBeGreaterThan(10);
    expect(entries).toContain('package/dist/index.js');
  });

  it('ships no dist/lib/secrets/ directory', () => {
    const secretsEntries = entries.filter((e) => e.startsWith('package/dist/lib/secrets/'));
    expect(secretsEntries, `unexpected secrets-engine entries: ${secretsEntries.join(', ')}`).toEqual([]);
  });

  it('ships no keychain-helper build artifact or source', () => {
    // Scoped to the deleted engine's own helper, not every "keychain" hit —
    // `openclaw-keychain.js` is an unrelated, still-shipped OpenClaw module.
    const keychainEntries = entries.filter((e) => /keychain-helper|secrets\/agent\b|Agents[ _]CLI\.app/i.test(e));
    expect(keychainEntries, `unexpected keychain-helper entries: ${keychainEntries.join(', ')}`).toEqual([]);
  });

  it('ships the standalone-secrets process client and policy modules, not the deleted engine', () => {
    expect(entries).toContain('package/dist/lib/secrets-client.js');
    expect(entries).toContain('package/dist/lib/secrets-policy.js');
    expect(entries).toContain('package/dist/lib/reserved-stores.js');
  });

  it('ships no native .app bundle of any kind (RUSH-3100 — helpers are downloaded, not bundled)', () => {
    const appEntries = entries.filter((e) => e.includes('.app/'));
    expect(appEntries, `unexpected bundled .app entries: ${appEntries.join(', ')}`).toEqual([]);
  });
});
