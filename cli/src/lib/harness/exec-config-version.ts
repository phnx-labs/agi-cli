import { getVersionHomePath, isVersionInstalled, resolveVersion } from '../installations/versions.js';
import type { AgentId } from '../types.js';

interface ResolvedConfigVersion {
  version: string | null;
  versionHome: string | null;
}

export function resolveConfigVersion(agent: AgentId, cwd: string, optionsVersion?: string): ResolvedConfigVersion {
  const resolvedVersion = optionsVersion ?? resolveVersion(agent, cwd);
  const version = optionsVersion
    ? resolvedVersion
    : (resolvedVersion && isVersionInstalled(agent, resolvedVersion) ? resolvedVersion : null);
  const versionHome = version ? getVersionHomePath(agent, version) : null;
  return { version: version ?? null, versionHome };
}
