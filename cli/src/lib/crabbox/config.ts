/** The repo-local `.crabbox.yaml`. crabbox reads it when warming (its `profile:` becomes the box
 * label), but `agents run --lease` deliberately does not inherit that repo/CI label; leases share
 * the default pool unless `leaseProfile:` opts in. */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

/** The profile label a warm pool shares, matching sandbox.sh's `PROFILE=default`: an unconfigured
 * run and an unlabeled box normalize to it and still match. */
export const DEFAULT_CRABBOX_PROFILE = 'default';

function readCrabboxRepoConfig(repoRoot: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(repoRoot, '.crabbox.yaml'), 'utf-8');
  } catch {
    return undefined; // no repo crabbox config — crabbox's own default applies
  }
  let parsed: unknown;
  try {
    parsed = yaml.parse(raw);
  } catch {
    return undefined;
  }
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
}

/** Pool label for `agents run --lease`. The generic `profile:` key stays with repo sandbox/CI
 * scripts; only an explicit `leaseProfile:` opts lease runs out of the shared pool. */
export function readCrabboxLeaseProfile(repoRoot: string): string {
  const profile = readCrabboxRepoConfig(repoRoot)?.leaseProfile;
  return typeof profile === 'string' && profile.length > 0 ? profile : DEFAULT_CRABBOX_PROFILE;
}
