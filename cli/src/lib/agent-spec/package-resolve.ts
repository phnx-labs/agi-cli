import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { AgentId } from '../types.js';
import { assertWithin, isSafeSegmentName } from '../paths.js';
import { loadAgentPackageManifest } from './package-schema.js';
import { AgentPackageError } from './package-types.js';
import type {
  AgentPackageManifest,
  PackageHarnessOverlay,
  PackageHook,
  PackageMcpServer,
  ResolvedAgentPackage,
  ResolvedResource,
  ResourceProvenance,
} from './package-types.js';

// Textual containment is insufficient: lstat/realpath reject package-source symlink escapes.
function assertRealSourceWithin(abs: string, packageReal: string, label: string): void {
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(abs);
  } catch {
    return;
  }
  if (lst.isSymbolicLink()) {
    throw new AgentPackageError(`${label}: '${abs}' is a symlink; symlinked package sources are not allowed`, 'path-escape');
  }
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return;
  }
  if (real !== packageReal && !real.startsWith(packageReal + path.sep)) {
    throw new AgentPackageError(`${label}: '${abs}' resolves outside the package directory`, 'path-escape');
  }
}

function resolveWithin(containRoot: string, relPath: string, label: string, packageReal: string): string {
  const abs = path.resolve(containRoot, relPath);
  try {
    assertWithin(containRoot, abs);
  } catch {
    throw new AgentPackageError(`${label}: '${relPath}' escapes the package directory`, 'path-escape');
  }
  assertRealSourceWithin(abs, packageReal, label);
  return abs;
}

function sha256OfBytes(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function sha256OfDir(dir: string): string {
  const files: string[] = [];
  const walk = (base: string) => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(base, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(dir);
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    hash.update(rel).update('\0').update(fs.readFileSync(file)).update('\n');
  }
  return hash.digest('hex');
}

function requireFile(absPath: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    throw new AgentPackageError(`${label}: no such file '${absPath}'`, 'invalid-resource');
  }
  if (!stat.isFile()) {
    throw new AgentPackageError(`${label}: '${absPath}' is not a file`, 'invalid-resource');
  }
}

function requireDir(absPath: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    throw new AgentPackageError(`${label}: no such directory '${absPath}'`, 'invalid-resource');
  }
  if (!stat.isDirectory()) {
    throw new AgentPackageError(`${label}: '${absPath}' is not a directory`, 'invalid-resource');
  }
}

function parseYamlFile<T>(absPath: string, label: string): T {
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, 'utf-8');
  } catch (err) {
    throw new AgentPackageError(`${label}: cannot read '${absPath}' — ${(err as Error).message}`, 'invalid-resource');
  }
  try {
    return yaml.parse(raw) as T;
  } catch (err) {
    throw new AgentPackageError(`${label}: malformed YAML in '${absPath}' — ${(err as Error).message}`, 'invalid-resource');
  }
}

function resolveInstructions(
  packageDir: string,
  relPath: string,
  provenance: ResourceProvenance,
  label: string,
  packageReal: string,
): ResolvedResource {
  const abs = resolveWithin(packageDir, relPath, label, packageReal);
  requireFile(abs, label);
  return { kind: 'instructions', name: 'instructions', sourcePath: abs, sha256: sha256OfBytes(fs.readFileSync(abs)), provenance };
}

function resolveDirResource(
  packageDir: string,
  relPath: string,
  kind: 'skills' | 'subagents',
  markerFile: string,
  provenance: ResourceProvenance,
  label: string,
  packageReal: string,
): ResolvedResource {
  const abs = resolveWithin(packageDir, relPath, label, packageReal);
  requireDir(abs, label);
  requireFile(path.join(abs, markerFile), `${label} (missing ${markerFile})`);
  return { kind, name: path.basename(abs), sourcePath: abs, sha256: sha256OfDir(abs), provenance };
}

function resolveMcpResource(
  packageDir: string,
  relPath: string,
  provenance: ResourceProvenance,
  label: string,
  packageReal: string,
): ResolvedResource {
  const abs = resolveWithin(packageDir, relPath, label, packageReal);
  requireFile(abs, label);
  const server = parseYamlFile<Partial<PackageMcpServer>>(abs, label);
  if (!server || typeof server.name !== 'string' || server.name.length === 0) {
    throw new AgentPackageError(`${label}: '${relPath}' must declare a 'name'`, 'invalid-resource');
  }
  if (server.transport !== 'stdio' && server.transport !== 'http' && server.transport !== 'sse') {
    throw new AgentPackageError(`${label}: '${relPath}' has an invalid transport (${JSON.stringify(server.transport)})`, 'invalid-resource');
  }
  if (server.transport === 'stdio' && !server.command) {
    throw new AgentPackageError(`${label}: '${relPath}' declares transport 'stdio' but no 'command'`, 'invalid-resource');
  }
  if ((server.transport === 'http' || server.transport === 'sse') && !server.url) {
    throw new AgentPackageError(`${label}: '${relPath}' declares transport '${server.transport}' but no 'url'`, 'invalid-resource');
  }
  return {
    kind: 'mcp',
    name: server.name,
    sourcePath: abs,
    sha256: sha256OfBytes(fs.readFileSync(abs)),
    provenance,
    mcp: server as PackageMcpServer,
  };
}

function resolveHookResource(
  packageDir: string,
  relPath: string,
  provenance: ResourceProvenance,
  label: string,
  packageReal: string,
): ResolvedResource {
  const abs = resolveWithin(packageDir, relPath, label, packageReal);
  requireFile(abs, label);
  const hook = parseYamlFile<Partial<PackageHook>>(abs, label);
  if (!hook || typeof hook.name !== 'string' || hook.name.length === 0) {
    throw new AgentPackageError(`${label}: '${relPath}' must declare a 'name'`, 'invalid-resource');
  }
  if (!isSafeSegmentName(hook.name)) {
    throw new AgentPackageError(`${label}: hook name '${hook.name}' is not a safe single path segment`, 'invalid-resource');
  }
  if (typeof hook.script !== 'string' || hook.script.length === 0) {
    throw new AgentPackageError(`${label}: '${relPath}' must declare a 'script'`, 'invalid-resource');
  }
  if (!Array.isArray(hook.events) || hook.events.length === 0 || hook.events.some((e) => typeof e !== 'string')) {
    throw new AgentPackageError(`${label}: '${relPath}' must declare a non-empty 'events' list of strings`, 'invalid-resource');
  }
  const scriptPath = resolveWithin(path.dirname(abs), hook.script, label, packageReal);
  requireFile(scriptPath, `${label} (hook script)`);
  return {
    kind: 'hooks',
    name: hook.name,
    sourcePath: abs,
    sha256: sha256OfBytes(Buffer.concat([fs.readFileSync(abs), Buffer.from('\0'), fs.readFileSync(scriptPath)])),
    provenance,
    hook: { def: hook as PackageHook, scriptPath },
  };
}

function assertNoDuplicates(resources: ResolvedResource[], scopeLabel: string): void {
  const seen = new Map<string, ResolvedResource>();
  for (const r of resources) {
    const key = `${r.kind}:${r.name}`;
    const prior = seen.get(key);
    if (prior) {
      throw new AgentPackageError(
        `${scopeLabel}: duplicate ${r.kind} '${r.name}' declared by both '${prior.sourcePath}' and '${r.sourcePath}'`,
        'duplicate-resource',
      );
    }
    seen.set(key, r);
  }
}

function resolveScope(
  packageDir: string,
  paths: { instructions?: string; skills: string[]; subagents: string[]; mcp: string[]; hooks: string[] },
  provenance: ResourceProvenance,
  scopeLabel: string,
  packageReal: string,
): ResolvedResource[] {
  const resources: ResolvedResource[] = [];
  if (paths.instructions) resources.push(resolveInstructions(packageDir, paths.instructions, provenance, scopeLabel, packageReal));
  for (const p of paths.skills) resources.push(resolveDirResource(packageDir, p, 'skills', 'SKILL.md', provenance, scopeLabel, packageReal));
  for (const p of paths.subagents) resources.push(resolveDirResource(packageDir, p, 'subagents', 'AGENT.md', provenance, scopeLabel, packageReal));
  for (const p of paths.mcp) resources.push(resolveMcpResource(packageDir, p, provenance, scopeLabel, packageReal));
  for (const p of paths.hooks) resources.push(resolveHookResource(packageDir, p, provenance, scopeLabel, packageReal));
  resources.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)));
  assertNoDuplicates(resources, scopeLabel);
  return resources;
}

function computeDigest(portable: ResolvedResource[], overlays: Partial<Record<AgentId, ResolvedResource[]>>): string {
  const hash = crypto.createHash('sha256');
  const record = (label: string, resources: ResolvedResource[]) => {
    for (const r of resources) hash.update(`${label}\0${r.kind}\0${r.name}\0${r.sha256}\n`);
  };
  record('portable', portable);
  for (const agent of Object.keys(overlays).sort()) record(`overlay:${agent}`, overlays[agent as AgentId] ?? []);
  return hash.digest('hex');
}

export function resolveAgentPackage(packageDir: string): ResolvedAgentPackage {
  const manifest: AgentPackageManifest = loadAgentPackageManifest(packageDir);
  const ex = manifest.execution;

  const packageReal = fs.realpathSync(path.resolve(packageDir));

  const portable = resolveScope(
    packageDir,
    { instructions: ex.instructions, skills: ex.skills, subagents: ex.subagents, mcp: ex.mcp, hooks: ex.hooks },
    'portable',
    'execution',
    packageReal,
  );

  const overlays: Partial<Record<AgentId, ResolvedResource[]>> = {};
  for (const [agent, overlay] of Object.entries(ex.harnessOverlays) as [AgentId, PackageHarnessOverlay][]) {
    overlays[agent] = resolveScope(
      packageDir,
      { instructions: overlay.instructions, skills: overlay.skills ?? [], subagents: overlay.subagents ?? [], mcp: overlay.mcp ?? [], hooks: overlay.hooks ?? [] },
      'overlay',
      `execution.harness_overlays.${agent}`,
      packageReal,
    );
  }

  return {
    manifest,
    packageDir: path.resolve(packageDir),
    digest: computeDigest(portable, overlays),
    portable,
    overlays,
  };
}

export function effectiveResources(resolved: ResolvedAgentPackage, harness: AgentId): ResolvedResource[] {
  const overlay = resolved.overlays[harness] ?? [];
  const overlayKeys = new Set(overlay.map((r) => `${r.kind}:${r.name}`));
  const merged = [
    ...resolved.portable.filter((r) => !overlayKeys.has(`${r.kind}:${r.name}`)),
    ...overlay,
  ];
  merged.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)));
  return merged;
}
