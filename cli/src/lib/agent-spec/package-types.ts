/** Types for the portable agent-package resolver and native-home materializer (PHNX-3838). A
 * package is an `agent.yaml` (schema v3 `execution`) reduced to one canonical resource set and
 * projected into a Claude Code, Codex or OpenCode home (PR muqsitnawaz/agents#2055). */
import type { AgentId } from '../types.js';

export type PackageResourceKind = 'instructions' | 'skills' | 'subagents' | 'mcp' | 'hooks';

/** Where a resolved resource came from — the provenance a conflict resolution decision needs. */
export type ResourceProvenance = 'portable' | 'overlay';

/** Thrown on any bad package or unsatisfiable materialization request. Never `process.exit`. */
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

/** One MCP server declared by a package's `mcp/*.yaml` resource file. */
export interface PackageMcpServer {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** One lifecycle hook declared by a package's `hooks/*.yaml` resource file. */
export interface PackageHook {
  name: string;
  /** Path to the hook's script, relative to the hook manifest's own directory. */
  script: string;
  events: string[];
  matcher?: string;
  timeout?: number;
}

/** A harness-scoped overlay: the same resource-directory shape as the package root. */
export interface PackageHarnessOverlay {
  instructions?: string;
  skills?: string[];
  subagents?: string[];
  mcp?: string[];
  hooks?: string[];
}

/** Parsed + shape-validated `execution` block of a schema-v3 `agent.yaml`. */
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

/** One resource in the canonical, resolved package — before harness projection. */
export interface ResolvedResource {
  kind: PackageResourceKind;
  /** Stable resource name within its kind (skill/subagent/mcp-server/hook name, or 'instructions'). */
  name: string;
  /** Absolute path to the resource's source — a file for instructions/mcp/hooks, a dir for skills/subagents. */
  sourcePath: string;
  /** Deterministic content hash — a single file's sha256, or a directory's combined sha256. */
  sha256: string;
  provenance: ResourceProvenance;
  /** Parsed definition, kind === 'mcp' only. */
  mcp?: PackageMcpServer;
  /** Parsed definition + resolved script path, kind === 'hooks' only. */
  hook?: { def: PackageHook; scriptPath: string };
}

/** The one canonical resolution of a package: portable resources plus each harness's overlay. */
export interface ResolvedAgentPackage {
  manifest: AgentPackageManifest;
  packageDir: string;
  /** Deterministic digest over every declared resource (portable + all overlays), independent of harness. */
  digest: string;
  portable: ResolvedResource[];
  overlays: Partial<Record<AgentId, ResolvedResource[]>>;
}

export interface MaterializationReceiptEntry {
  kind: PackageResourceKind;
  name: string;
  /** Path the materializer wrote, relative to the output home. */
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
  /** Harness version — gates per-kind capability support (e.g. codex hooks need >= 0.116.0). */
  harnessVersion: string;
  /** Absolute path to the fresh, isolated home to materialize into. Created if missing. */
  outputHome: string;
}
