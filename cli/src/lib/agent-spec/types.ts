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

/** Thrown on any bad spec, never `process.exit`, so the engine is safe on the hot path and in
 * libraries. `code` and `installed` let callers render consistent messages without
 * string-matching. */
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

/** The filesystem/meta seam: the pure resolver takes this instead of importing versions.ts, so it
 * is unit-testable with in-memory fixtures (no $HOME, no subprocess). `provider.ts` is the
 * production adapter. */
export interface VersionProvider {
  listInstalled(agent: AgentId): string[];
  getProjectVersion(agent: AgentId, cwd: string): string | null;
  getGlobalDefault(agent: AgentId): string | null;
  /** The preferred isolated copy, separate from getGlobalDefault on purpose: a global default owns
   * the launcher, bare shim and ~/.<agent> config symlink, which an isolated version must never
   * acquire. Merging them would hand an isolated version to callers assuming it owns the launcher. */
  getIsolatedDefault(agent: AgentId): string | null;
  isInstalled(agent: AgentId, version: string): boolean;
}

export interface ResolveOptions {
  cwd?: string;
  availableAgents?: readonly AgentId[];
  /** Bare spec, >1 installed, no pin/default: `'error'` (default) throws AgentSpecError
   * `no-default`, safe for state-mutating commands (sync/use); `'newest'` picks the newest
   * installed (source `newest-installed`) for execution verbs (run/exec); callers should note it. */
  onAmbiguous?: 'error' | 'newest';
}

export type FilterVersion = string | null | 'default';
export interface VersionFilter {
  version: FilterVersion;
  source: VersionSource | 'all-versions' | 'default';
}
