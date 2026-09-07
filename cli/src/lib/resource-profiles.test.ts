import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const tempDirs: string[] = [];
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-resource-profile-'));
  tempDirs.push(home);
  return home;
}

function runProbe(home: string, code: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', ['--import', 'tsx', '-e', code], {
    cwd: APP_ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      AGENTS_NO_UPDATE_CHECK: '1',
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_SKIP_MIGRATION: '1',
      AGENTS_SECRETS_NO_AGENT: '1',
    },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

describe('resource profiles', () => {
  it('filters source-qualified resource selectors and active rules preset', () => {
    const home = makeHome();
    const result = runProbe(home, `
      const {
        activeRulesPreset,
        filterNamesForActiveResourceProfile,
        setActiveResourceProfile,
        upsertResourceProfilePreset,
      } = await import('./src/lib/resource-profiles.ts');

      upsertResourceProfilePreset('work', {
        skills: ['user:deploy', 'shared'],
        rules: 'work-rules',
      });
      setActiveResourceProfile('work');

      const sourceMap = new Map([
        ['deploy', 'user'],
        ['debug', 'system'],
        ['shared', 'system'],
      ]);

      console.log(JSON.stringify({
        skills: filterNamesForActiveResourceProfile('skills', ['deploy', 'debug', 'shared'], sourceMap),
        rules: filterNamesForActiveResourceProfile('memory', ['default', 'work-rules']),
        activeRules: activeRulesPreset(),
      }));
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      skills: ['deploy', 'shared'],
      rules: ['work-rules'],
      activeRules: 'work-rules',
    });
  });

  it('lets source-qualified exclusions remove plain pattern inclusions', () => {
    const home = makeHome();
    const result = runProbe(home, `
      const {
        filterNamesForActiveResourceProfile,
        setActiveResourceProfile,
        upsertResourceProfilePreset,
      } = await import('./src/lib/resource-profiles.ts');

      upsertResourceProfilePreset('work', {
        skills: ['*', '!system:debug'],
      });
      setActiveResourceProfile('work');

      const sourceMap = new Map([
        ['keep', 'user'],
        ['debug', 'system'],
      ]);

      console.log(JSON.stringify(
        filterNamesForActiveResourceProfile('skills', ['keep', 'debug'], sourceMap)
      ));
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['keep']);
  });

  // PHNX-3989: the standalone `secrets` engine has no concept of a resource
  // profile (DEP-1) — the old in-repo engine used to auto-filter listBundles()
  // and auto-reject readAndResolveBundleEnv() for an inactive bundle, INSIDE
  // bundles.ts. That enforcement point is gone with the engine; the policy now
  // lives entirely in agents-cli (`secrets-policy.ts`'s
  // resolveSecretsContextForRun / resolveAllowedBundlesForActiveProfile),
  // which computes the allowed set from a real (unfiltered) bundle listing and
  // forwards it as `SecretsContext.allowedBundles` for the standalone to
  // enforce server-side. This proves the agents-cli-owned half: the computed
  // context is exactly the profile-restricted set, derived from the real
  // standalone's own listing.
  it('computes SecretsContext.allowedBundles from the active profile against the real bundle listing', () => {
    const home = makeHome();
    const result = runProbe(home, `
      const { setActiveResourceProfile, upsertResourceProfilePreset } = await import('./src/lib/resource-profiles.ts');
      const { listBundles, writeBundle } = await import('./src/lib/secrets-client.ts');
      const { resolveSecretsContextForRun } = await import('./src/lib/secrets-policy.ts');

      await writeBundle({ name: 'prod', vars: { API_KEY: { value: 'prod-key' } } });
      await writeBundle({ name: 'personal', vars: { API_KEY: { value: 'personal-key' } } });

      const noProfileContext = await resolveSecretsContextForRun('claude');

      upsertResourceProfilePreset('work', { secrets: ['prod'] });
      setActiveResourceProfile('work');

      const scopedContext = await resolveSecretsContextForRun('claude');
      console.log(JSON.stringify({
        bundles: (await listBundles()).map((bundle) => bundle.name).sort(),
        noProfileContext,
        scopedContext,
      }));
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      // The real listing is never auto-filtered — that filtering is now the
      // caller's job (resolveAllowedBundlesForActiveProfile), not the engine's.
      bundles: ['personal', 'prod'],
      // No active profile: full trust, only the scope rides the context.
      noProfileContext: { scope: 'claude' },
      // Active profile: allowedBundles is exactly the profile's restricted set.
      scopedContext: { allowedBundles: ['prod'], scope: 'claude' },
    });
  });
});
