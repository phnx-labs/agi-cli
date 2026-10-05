import type { AgentId } from '../../types.js';
import type { ResourceKind } from './kinds.js';

export interface WriteArgs<Sel> {
  version: string;
  versionHome: string;
  selection: Sel;
  cwd: string;
}

export interface WriteResult {
  synced: string[];
  paths?: string[];
  errors?: string[];
}

export interface RemoveArgs {
  version: string;
  versionHome: string;
  name: string;
  cwd: string;
}

export interface RemoveResult {
  removed: boolean;
}

export interface ResourceWriter<Sel = string[]> {
  readonly kind: ResourceKind;
  readonly agent: AgentId;
  write(args: WriteArgs<Sel>): WriteResult;
  remove?(args: RemoveArgs): RemoveResult;
}
