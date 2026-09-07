/**
 * Proves the packed `@phnx-labs/agents-cli` tarball ships no trace of the
 * in-repo secrets engine (PHNX-3989 DIST-1) — real `bun run build` + real
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
  const distEntry = path.join(CLI_ROOT, 'dist', 'index.js');
  if (!fs.existsSync(distEntry)) {
    execFileSync('bun', ['run', 'build'], { cwd: CLI_ROOT, stdio: 'inherit' });
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-pack-'));
  try {
    const pack = spawnSync('npm', ['pack', '--silent', '--pack-destination', tmp], {
      cwd: CLI_ROOT,
      encoding: 'utf-8',
    });
    if (pack.status !== 0) {
      throw new Error(`npm pack failed (status ${pack.status}): ${pack.stdout}${pack.stderr}`);
    }
    const tgzName = pack.stdout.trim().split('\n').pop()!;
    const tgzPath = path.join(tmp, tgzName);
    expect(fs.existsSync(tgzPath), `npm pack did not produce ${tgzName} in ${tmp}`).toBe(true);
    const listing = execFileSync('tar', ['tzf', tgzPath], { encoding: 'utf-8' });
    return listing.trim().split('\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
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
