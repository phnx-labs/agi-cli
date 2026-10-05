/** Unified resource system types. Resources merge from system, user and project layers: all are
 * unioned, and on a name conflict the higher layer wins (project > user > system). */

// Import + re-export the canonical AgentId so resource handlers never drift
// from the main registry (lib/types.ts). A local copy previously omitted amp + muse.
import type { AgentId } from '../types.js';
export type { AgentId };
/** Resource origin. Precedence (highest first): project > user > plugin > system. */
export type Layer = 'system' | 'user' | 'project' | 'plugin';
export type ResourceKind = 'command' | 'hook' | 'skill' | 'rule' | 'mcp' | 'permission' | 'subagent' | 'workflow' | 'memory' | 'plugin';

/** A resolved resource with its origin layer. */
export interface ResolvedItem<T> {
  name: string;
  item: T;
  layer: Layer;
  path: string;
}

/** Resource handler interface: each resource type (commands, hooks, skills, ...) implements it for
 * consistent list/resolve/sync behavior across agent types. */
export interface ResourceHandler<T> {
  readonly kind: ResourceKind;

  /** List all resources across layers as a union deduplicated by name, the higher layer winning a
   * conflict. */
  listAll(agent: AgentId, cwd?: string): ResolvedItem<T>[];

  /** Resolve one resource by name: the winning layer's version, or null if not found. */
  resolve(agent: AgentId, name: string, cwd?: string): ResolvedItem<T> | null;

  /** Sync resolved resources to the agent's version home directory, copying or transforming into the
   * agent's expected format. */
  sync(agent: AgentId, versionHome: string, cwd?: string): void;

  /**
   * Get the file format this resource uses for a given agent.
   */
  format(agent: AgentId): 'md' | 'toml' | 'json' | 'yaml';

  /**
   * Get the target directory name in the agent's version home.
   */
  targetDir(agent: AgentId): string;

  /** For resources that modify config files (MCP, permissions), the config file path; null if not
   * applicable. */
  configPath?(agent: AgentId, versionHome: string): string | null;

  /** Content hash of a resource item for change detection, so diff() can spot modifications without
   * a full content comparison. Optional: handlers without it fall back to full sync. */
  hash?(item: T): string;

  /** Compare source layers vs the synced target and list differing resources (added, modified,
   * removed), enabling incremental sync and "X resources out of sync" status. Optional: handlers
   * without it always report "unknown". */
  diff?(agent: AgentId, versionHome: string, cwd?: string): ResourceDiff[];
}

/** Result of comparing source vs target for a single resource. */
export interface ResourceDiff {
  name: string;
  status: 'added' | 'modified' | 'removed';
  sourceLayer: Layer | null;
  sourceHash: string | null;
  targetHash: string | null;
}

/** Helper to get layer directories for resource resolution. */
export interface LayerDirs {
  system: string;
  user: string;
  project: string | null;
  extra: string[];
}
