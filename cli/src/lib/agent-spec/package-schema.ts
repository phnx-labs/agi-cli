import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { AgentId } from '../types.js';
import { ALL_AGENT_IDS } from './agents.js';
import { AgentPackageError } from './package-types.js';
import type { AgentPackageManifest, PackageHarnessOverlay } from './package-types.js';

const AGENT_ID_SET = new Set<string>(ALL_AGENT_IDS);

function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && AGENT_ID_SET.has(value);
}

function fail(message: string, details?: string[]): never {
  throw new AgentPackageError(message, 'invalid-manifest', details);
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    fail(`agent.yaml: '${field}' must be a list of strings`);
  }
  return value as string[];
}

function parseHarnessOverlay(raw: unknown, agent: string): PackageHarnessOverlay {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`agent.yaml: execution.harness_overlays.${agent} must be a mapping`);
  }
  const r = raw as Record<string, unknown>;
  if (r.instructions !== undefined && typeof r.instructions !== 'string') {
    fail(`agent.yaml: execution.harness_overlays.${agent}.instructions must be a string`);
  }
  return {
    instructions: r.instructions as string | undefined,
    skills: stringArray(r.skills, `execution.harness_overlays.${agent}.skills`),
    subagents: stringArray(r.subagents, `execution.harness_overlays.${agent}.subagents`),
    mcp: stringArray(r.mcp, `execution.harness_overlays.${agent}.mcp`),
    hooks: stringArray(r.hooks, `execution.harness_overlays.${agent}.hooks`),
  };
}

export function parseAgentPackageManifest(raw: unknown, sourceLabel: string): AgentPackageManifest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${sourceLabel}: expected a YAML mapping at the document root`);
  }
  const doc = raw as Record<string, unknown>;

  if (doc.schema_version !== 3) {
    fail(`${sourceLabel}: schema_version must be 3 (got ${JSON.stringify(doc.schema_version)}) — this resolver only understands schema v3 execution blocks`);
  }
  if ('http_tools' in doc) {
    fail(`${sourceLabel}: 'http_tools' is forbidden at schema v3 — use execution.mcp instead`);
  }
  if (typeof doc.name !== 'string' || doc.name.length === 0) {
    fail(`${sourceLabel}: 'name' is required and must be a non-empty string`);
  }
  if (typeof doc.slug !== 'string' || doc.slug.length === 0) {
    fail(`${sourceLabel}: 'slug' is required and must be a non-empty string`);
  }
  if (doc.description !== undefined && typeof doc.description !== 'string') {
    fail(`${sourceLabel}: 'description' must be a string`);
  }

  const execution = doc.execution;
  if (execution === null || typeof execution !== 'object' || Array.isArray(execution)) {
    fail(`${sourceLabel}: 'execution' block is required`);
  }
  const ex = execution as Record<string, unknown>;

  const mode = ex.mode;
  if (mode !== 'cloud' && mode !== 'local') {
    fail(`${sourceLabel}: execution.mode must be 'cloud' or 'local' (got ${JSON.stringify(mode)})`);
  }

  const harnesses = ex.harnesses;
  if (harnesses === null || typeof harnesses !== 'object' || Array.isArray(harnesses)) {
    fail(`${sourceLabel}: execution.harnesses is required`);
  }
  const h = harnesses as Record<string, unknown>;
  if (!isAgentId(h.default)) {
    fail(`${sourceLabel}: execution.harnesses.default must name a known agent id (got ${JSON.stringify(h.default)})`);
  }
  const supportedRaw = stringArray(h.supported, 'execution.harnesses.supported');
  if (supportedRaw.length === 0) {
    fail(`${sourceLabel}: execution.harnesses.supported must list at least one agent id`);
  }
  const badIds = supportedRaw.filter((id) => !isAgentId(id));
  if (badIds.length > 0) {
    fail(`${sourceLabel}: execution.harnesses.supported names unknown agent id(s): ${badIds.join(', ')}`);
  }
  const supported = supportedRaw as AgentId[];
  if (!supported.includes(h.default as AgentId)) {
    fail(`${sourceLabel}: execution.harnesses.default (${String(h.default)}) must also appear in execution.harnesses.supported`);
  }

  if (typeof ex.instructions !== 'string' || ex.instructions.length === 0) {
    fail(`${sourceLabel}: execution.instructions is required and must be a non-empty relative path`);
  }

  const harnessOverlaysRaw = ex.harness_overlays;
  const harnessOverlays: Partial<Record<AgentId, PackageHarnessOverlay>> = {};
  if (harnessOverlaysRaw !== undefined) {
    if (harnessOverlaysRaw === null || typeof harnessOverlaysRaw !== 'object' || Array.isArray(harnessOverlaysRaw)) {
      fail(`${sourceLabel}: execution.harness_overlays must be a mapping`);
    }
    for (const [agent, overlay] of Object.entries(harnessOverlaysRaw as Record<string, unknown>)) {
      if (!isAgentId(agent)) {
        fail(`${sourceLabel}: execution.harness_overlays names unknown agent id: ${agent}`);
      }
      harnessOverlays[agent] = parseHarnessOverlay(overlay, agent);
    }
  }

  return {
    schemaVersion: 3,
    name: doc.name,
    slug: doc.slug,
    description: doc.description as string | undefined,
    execution: {
      mode,
      harnesses: { default: h.default as AgentId, supported },
      instructions: ex.instructions,
      skills: stringArray(ex.skills, 'execution.skills'),
      subagents: stringArray(ex.subagents, 'execution.subagents'),
      mcp: stringArray(ex.mcp, 'execution.mcp'),
      hooks: stringArray(ex.hooks, 'execution.hooks'),
      harnessOverlays,
    },
  };
}

export function loadAgentPackageManifest(packageDir: string): AgentPackageManifest {
  const manifestPath = path.join(packageDir, 'agent.yaml');
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf-8');
  } catch {
    throw new AgentPackageError(`agent.yaml not found in ${packageDir}`, 'invalid-manifest');
  }
  let doc: unknown;
  try {
    doc = yaml.parse(raw);
  } catch (err) {
    throw new AgentPackageError(`${manifestPath}: malformed YAML — ${(err as Error).message}`, 'invalid-manifest');
  }
  return parseAgentPackageManifest(doc, manifestPath);
}
