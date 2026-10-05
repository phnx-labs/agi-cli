import type { AgentId } from '../types.js';

export const INSTALLATION_SCHEMA = 1;

export const INSTALLATION_RECORD_FILE = 'installation.json';

export interface InstallationRelease {
  releaseVersion: string;
  at: string;
}

export interface Installation {
  schema: number;
  id: string;
  agent: AgentId;
  label: string;
  releaseVersion: string;
  createdAt: string;
  updatedAt: string;
  history: InstallationRelease[];
  updatePolicy?: UpdatePolicy;
}

export type UpdatePolicy = 'latest' | 'pinned';

export type UpdateStrategyId =
  | 'npm-package'
  | 'global-binary'
  | 'install-script';

export interface UpdateOutcome {
  installation: Installation;
  strategy: UpdateStrategyId;
  fromRelease: string;
  toRelease: string;
  unchanged: boolean;
  deferred?: string;
  alsoUpdated: Installation[];
}
