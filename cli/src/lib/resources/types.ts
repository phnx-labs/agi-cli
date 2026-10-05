
import type { AgentId } from '../types.js';
export type { AgentId };
export type Layer = 'system' | 'user' | 'project' | 'plugin';
export type ResourceKind = 'command' | 'hook' | 'skill' | 'rule' | 'mcp' | 'permission' | 'subagent' | 'workflow' | 'memory' | 'plugin';

export interface ResolvedItem<T> {
  name: string;
  item: T;
  layer: Layer;
  path: string;
}

export interface ResourceHandler<T> {
  readonly kind: ResourceKind;

  listAll(agent: AgentId, cwd?: string): ResolvedItem<T>[];

  resolve(agent: AgentId, name: string, cwd?: string): ResolvedItem<T> | null;

  sync(agent: AgentId, versionHome: string, cwd?: string): void;

  format(agent: AgentId): 'md' | 'toml' | 'json' | 'yaml';

  targetDir(agent: AgentId): string;

  configPath?(agent: AgentId, versionHome: string): string | null;

  hash?(item: T): string;

  diff?(agent: AgentId, versionHome: string, cwd?: string): ResourceDiff[];
}

export interface ResourceDiff {
  name: string;
  status: 'added' | 'modified' | 'removed';
  sourceLayer: Layer | null;
  sourceHash: string | null;
  targetHash: string | null;
}

export interface LayerDirs {
  system: string;
  user: string;
  project: string | null;
  extra: string[];
}
