import type { AgentId } from '../types.js';

export type PackageResourceKind = 'instructions' | 'skills' | 'subagents' | 'mcp' | 'hooks';

export type ResourceProvenance = 'portable' | 'overlay';

export class AgentPackageError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid-manifest'
      | 'invalid-resource'
      | 'duplicate-resource'
      | 'path-escape'
      | 'unsupported-harness'
      | 'unsupported-capability',
    readonly details?: string[],
  ) {
    super(message);
    this.name = 'AgentPackageError';
  }
}

export interface PackageMcpServer {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface PackageHook {
  name: string;
  script: string;
  events: string[];
  matcher?: string;
  timeout?: number;
}

export interface PackageHarnessOverlay {
  instructions?: string;
  skills?: string[];
  subagents?: string[];
  mcp?: string[];
  hooks?: string[];
}

export interface AgentPackageManifest {
  schemaVersion: 3;
  name: string;
  slug: string;
  description?: string;
  execution: {
    mode: 'cloud' | 'local';
    harnesses: { default: AgentId; supported: AgentId[] };
    instructions: string;
    skills: string[];
    subagents: string[];
    mcp: string[];
    hooks: string[];
    harnessOverlays: Partial<Record<AgentId, PackageHarnessOverlay>>;
  };
}

export interface ResolvedResource {
  kind: PackageResourceKind;
  name: string;
  sourcePath: string;
  sha256: string;
  provenance: ResourceProvenance;
  mcp?: PackageMcpServer;
  hook?: { def: PackageHook; scriptPath: string };
}

export interface ResolvedAgentPackage {
  manifest: AgentPackageManifest;
  packageDir: string;
  digest: string;
  portable: ResolvedResource[];
  overlays: Partial<Record<AgentId, ResolvedResource[]>>;
}

export interface MaterializationReceiptEntry {
  kind: PackageResourceKind;
  name: string;
  target: string;
  sha256: string;
  provenance: ResourceProvenance;
}

export interface MaterializationReceipt {
  schemaVersion: 1;
  agent: { ref: string; digest: string };
  harness: { id: AgentId; version: string };
  resources: MaterializationReceiptEntry[];
  warnings: string[];
}

export interface MaterializeOptions {
  harness: AgentId;
  harnessVersion: string;
  outputHome: string;
}
