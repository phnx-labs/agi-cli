import type { AgentId } from '../types.js';

export type VersionSource =
  | 'explicit'
  | 'project-pin'
  | 'global-default'
  | 'isolated-default'
  | 'global-default(@pinned)'
  | 'sole-installed'
  | 'newest-installed'
  | 'alias-latest'
  | 'alias-oldest'
  | 'none';

export interface AgentTarget {
  agent: AgentId;
  version: string | null;
  source: VersionSource;
}

type AgentSpecErrorCode =
  | 'empty'
  | 'unknown-agent'
  | 'missing-version'
  | 'invalid-version'
  | 'not-installed'
  | 'no-default'
  | 'none-installed'
  | 'multi-not-allowed';

export class AgentSpecError extends Error {
  constructor(
    message: string,
    readonly code: AgentSpecErrorCode,
    readonly agent?: AgentId,
    readonly installed?: string[],
  ) {
    super(message);
    this.name = 'AgentSpecError';
  }
}

export interface VersionProvider {
  listInstalled(agent: AgentId): string[];
  getProjectVersion(agent: AgentId, cwd: string): string | null;
  getGlobalDefault(agent: AgentId): string | null;
  // Isolated defaults cannot acquire launcher, bare-shim, or real-config ownership.
  getIsolatedDefault(agent: AgentId): string | null;
  isInstalled(agent: AgentId, version: string): boolean;
}

export interface ResolveOptions {
  cwd?: string;
  availableAgents?: readonly AgentId[];
  onAmbiguous?: 'error' | 'newest';
}

export type FilterVersion = string | null | 'default';
export interface VersionFilter {
  version: FilterVersion;
  source: VersionSource | 'all-versions' | 'default';
}
