
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

export const DEFAULT_CRABBOX_PROFILE = 'default';

function readCrabboxRepoConfig(repoRoot: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(repoRoot, '.crabbox.yaml'), 'utf-8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = yaml.parse(raw);
  } catch {
    return undefined;
  }
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
}

export function readCrabboxLeaseProfile(repoRoot: string): string {
  const profile = readCrabboxRepoConfig(repoRoot)?.leaseProfile;
  return typeof profile === 'string' && profile.length > 0 ? profile : DEFAULT_CRABBOX_PROFILE;
}
