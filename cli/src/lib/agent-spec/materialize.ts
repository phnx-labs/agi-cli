/** Native-home materializer (PHNX-3838): `materializeAgentPackage` projects the canonical
 * `resolveAgentPackage` result into a fresh native home for Claude Code, Codex or OpenCode. A
 * deterministic `materialization-receipt.json` of owned paths lets a rerun prune only those. */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId, ManifestHook } from '../types.js';
import { supports } from '../capabilities.js';
import { AGENTS, agentConfigDirName, getMcpConfigPathForHome } from './agents.js';
import { getHooksDirInHome } from '../hooks/install.js';
import { registerHooksToSettings, hookRegistrationTargets } from '../hooks/install.js';
import { writeMcpConfig } from '../mcp.js';
import type { WritableMcpServer } from '../mcp.js';
import { subagentTarget } from '../subagents-registry.js';
import { isSafeSegmentName, realpathExistingPrefix } from '../paths.js';
import { AgentPackageError } from './package-types.js';
import type {
  MaterializationReceipt,
  MaterializationReceiptEntry,
  MaterializeOptions,
  PackageResourceKind,
  ResolvedAgentPackage,
  ResolvedResource,
} from './package-types.js';
import { effectiveResources } from './package-resolve.js';

const RECEIPT_FILE = 'materialization-receipt.json';

const KIND_TO_CAPABILITY: Record<PackageResourceKind, 'rules' | 'skills' | 'subagents' | 'mcp' | 'hooks'> = {
  instructions: 'rules',
  skills: 'skills',
  subagents: 'subagents',
  mcp: 'mcp',
  hooks: 'hooks',
};

const COPY_IGNORE = new Set(['.DS_Store', '.git', '.gitignore', 'node_modules']);

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || COPY_IGNORE.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function removePath(p: string): void {
  try {
    const stat = fs.lstatSync(p);
    if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
  } catch {
  }
}

/** Fail closed: every effective resource kind must be supported on this harness+version, including
 * MCP's finer `mcpHttp` and `mcpHeaders`, as `registerMcp` checks. Skipping them let opencode
 * (`mcpHttp: false`) or codex (`mcpHeaders: false`) silently receive config it cannot express. */
function assertCapabilitiesSupported(resources: ResolvedResource[], harness: AgentId, harnessVersion: string): void {
  const unsupported: string[] = [];
  for (const r of resources) {
    const cap = KIND_TO_CAPABILITY[r.kind];
    const result = supports(harness, cap, harnessVersion);
    if (!result.ok) {
      const need = 'need' in result && result.need ? ` (need ${result.need})` : '';
      unsupported.push(`${r.kind} '${r.name}' requires capability '${cap}' on ${harness}${need}`);
    }
    if (r.kind === 'mcp' && r.mcp) {
      const isRemote = r.mcp.transport === 'http' || r.mcp.transport === 'sse';
      if (isRemote && !supports(harness, 'mcpHttp', harnessVersion).ok) {
        unsupported.push(`mcp '${r.name}' declares transport '${r.mcp.transport}' but ${harness} does not support capability 'mcpHttp'`);
      }
      const hasHeaders = r.mcp.headers && Object.keys(r.mcp.headers).length > 0;
      if (isRemote && hasHeaders && !supports(harness, 'mcpHeaders', harnessVersion).ok) {
        unsupported.push(`mcp '${r.name}' declares headers but ${harness} does not support capability 'mcpHeaders'`);
      }
    }
  }
  if (unsupported.length > 0) {
    throw new AgentPackageError(
      `${harness}@${harnessVersion} cannot materialize this package: ${unsupported.length} unsupported capability request(s)`,
      'unsupported-capability',
      unsupported,
    );
  }
}

/** Containment invariant: every path to write or delete must stay inside `realOutputHome` once
 * symlinks in its prefix resolve. Writers append config dir + name to `outputHome`, so a planted
 * symlink (e.g. `outputHome/.claude` -> live `~/.claude`) escapes. Runs before any mkdir. */
function assertTargetContained(realOutputHome: string, target: string, label: string): void {
  const canonical = realpathExistingPrefix(target);
  if (canonical !== realOutputHome && !canonical.startsWith(realOutputHome + path.sep)) {
    throw new AgentPackageError(
      `${label}: refusing to write outside the output home — '${target}' resolves outside '${realOutputHome}'`,
      'path-escape',
    );
  }
}

/** The final-leaf guard, stricter than assertTargetContained: also refuses a symlink at the leaf. A
 * dangling leaf symlink reads as contained, then copyFileSync/writeFileSync/chmodSync follows it
 * and writes at its destination, so `lstat` the leaf and reject any symlink before each write. */
function assertLeafSafe(realOutputHome: string, leaf: string, label: string): void {
  assertTargetContained(realOutputHome, leaf, label);
  let lst: fs.Stats | undefined;
  try {
    lst = fs.lstatSync(leaf);
  } catch {
    return;
  }
  if (lst.isSymbolicLink()) {
    throw new AgentPackageError(`${label}: refusing to write through a symlink at '${leaf}'`, 'path-escape');
  }
}

function materializeInstructions(resource: ResolvedResource, harness: AgentId, outputHome: string, realOutputHome: string): string {
  const cap = AGENTS[harness].capabilities.rules;
  if (cap === false) {
    throw new AgentPackageError(`${harness} has no instructions target (rules capability is false)`, 'unsupported-capability');
  }
  const agentDir = path.join(outputHome, agentConfigDirName(harness));
  const destFile = path.join(agentDir, cap.file);
  assertTargetContained(realOutputHome, destFile, `${harness} instructions`);
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  assertLeafSafe(realOutputHome, destFile, `${harness} instructions`);
  fs.copyFileSync(resource.sourcePath, destFile);
  return path.relative(outputHome, destFile);
}

function materializeSkill(resource: ResolvedResource, harness: AgentId, outputHome: string, realOutputHome: string): string {
  const agentDir = path.join(outputHome, agentConfigDirName(harness));
  const destDir = path.join(agentDir, 'skills', resource.name);
  assertTargetContained(realOutputHome, destDir, `${harness} skill '${resource.name}'`);
  removePath(destDir);
  copyDir(resource.sourcePath, destDir);
  return path.relative(outputHome, destDir);
}

function materializeSubagent(resource: ResolvedResource, harness: AgentId, outputHome: string, realOutputHome: string): string {
  const target = subagentTarget(harness);
  if (!target) {
    throw new AgentPackageError(`${harness} has no subagent target registered`, 'unsupported-capability');
  }
  const dir = target.dir(outputHome);
  assertTargetContained(realOutputHome, dir, `${harness} subagent '${resource.name}'`);
  fs.mkdirSync(dir, { recursive: true });
  const occupied = target.occupied(dir, resource.name)[0];
  assertLeafSafe(realOutputHome, occupied.path, `${harness} subagent '${resource.name}'`);
  target.write(dir, { name: resource.name, path: resource.sourcePath });
  return path.relative(outputHome, occupied.path);
}

/** MCP servers write into one shared per-harness config that may hold content the materializer
 * doesn't own (an oauth account, a project list). `writeMcpConfig` `overwrite` preserves other
 * top-level keys; `allowEmpty` converges mcp to the exact set (even zero) instead of deleting it. */
function materializeMcp(resources: ResolvedResource[], harness: AgentId, outputHome: string, realOutputHome: string): string[] {
  const configPath = getMcpConfigPathForHome(harness, outputHome);
  if (resources.length === 0 && !fs.existsSync(configPath)) return [];
  assertTargetContained(realOutputHome, configPath, `${harness} mcp config`);
  const servers: WritableMcpServer[] = resources.map((r) => ({
    name: r.mcp!.name,
    transport: r.mcp!.transport,
    command: r.mcp!.command,
    args: r.mcp!.args,
    env: r.mcp!.env,
    url: r.mcp!.url,
    headers: r.mcp!.headers,
  }));
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  assertLeafSafe(realOutputHome, configPath, `${harness} mcp config`);
  try {
    writeMcpConfig(harness, configPath, servers, 'overwrite', { allowEmpty: true });
  } catch (err) {
    throw new AgentPackageError(`${harness}: cannot write mcp config — ${(err as Error).message}`, 'unsupported-capability');
  }
  const rel = path.relative(outputHome, configPath);
  return resources.map(() => rel);
}

function materializeHooks(resources: ResolvedResource[], harness: AgentId, outputHome: string, realOutputHome: string): Map<string, string> {
  const targets = new Map<string, string>();
  if (resources.length === 0) return targets;
  const hooksDir = getHooksDirInHome(harness, outputHome);
  assertTargetContained(realOutputHome, hooksDir, `${harness} hooks dir`);
  fs.mkdirSync(hooksDir, { recursive: true });
  // The hooks-dir guard catches a symlinked ancestor, but registerHooksToSettings writes a
  // settings/registrar leaf (settings.json, codex hooks.json/config.toml, the opencode plugin)
  // elsewhere. A symlink at one would redirect that write, so fail loud before any hook is copied.
  for (const settingsLeaf of hookRegistrationTargets(harness, outputHome)) {
    assertLeafSafe(realOutputHome, settingsLeaf, `${harness} hook settings`);
  }
  const manifest: Record<string, ManifestHook> = {};
  for (const r of resources) {
    const { def, scriptPath } = r.hook!;
    // The hook name is attacker-controlled (package hooks/*.yaml `name:`) and used as a filename:
    // a name like '../../../.config/foo' would copy and chmod +x outside the output home. Require
    // one safe segment and re-assert containment before the write.
    if (!isSafeSegmentName(r.name)) {
      throw new AgentPackageError(`${harness}: hook name '${r.name}' is not a safe single path segment`, 'invalid-resource');
    }
    const hooksDirResolved = path.resolve(hooksDir);
    const destScript = path.join(hooksDirResolved, `${r.name}${path.extname(scriptPath)}`);
    if (!destScript.startsWith(hooksDirResolved + path.sep)) {
      throw new AgentPackageError(`${harness}: hook '${r.name}' resolves outside the hooks directory`, 'invalid-resource');
    }
    assertLeafSafe(realOutputHome, destScript, `${harness} hook '${r.name}'`);
    fs.copyFileSync(scriptPath, destScript);
    fs.chmodSync(destScript, 0o755);
    manifest[r.name] = { script: destScript, events: def.events, matcher: def.matcher, timeout: def.timeout };
    targets.set(r.name, path.relative(outputHome, destScript));
  }
  // `skipGlobalShimSweep`: this manifest is the package's hooks only, so the default orphan-shim
  // sweep would delete the operator's real hooks from the process-global shims dir.
  // Materialization is isolated to `outputHome` and must never GC that directory (PHNX-3838).
  const result = registerHooksToSettings(harness, outputHome, manifest, undefined, { skipGlobalShimSweep: true });
  if (result.errors.length > 0) {
    throw new AgentPackageError(`${harness}: failed to register hook(s) — ${result.errors.join('; ')}`, 'invalid-resource');
  }
  return targets;
}

function packageRef(resolved: ResolvedAgentPackage): string {
  return `${resolved.manifest.slug}@${resolved.digest.slice(0, 12)}`;
}

/** True when `rel` is a safe prune target: a non-empty, `..`-free relative path whose canonical
 * form stays inside `realOutputHome`. The unsigned receipt could be planted with `../../victim` or
 * a symlinked ancestor, which a textual check misses. Realpath-verify; skip escapes. */
function isSafeContainedTarget(realOutputHome: string, outputHome: string, rel: unknown): boolean {
  if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0')) return false;
  if (path.isAbsolute(rel)) return false;
  if (rel.split(/[\\/]/).includes('..')) return false;
  const canonical = realpathExistingPrefix(path.resolve(outputHome, rel));
  return canonical.startsWith(realOutputHome + path.sep);
}

function pruneStaleManagedPaths(realOutputHome: string, outputHome: string, previousTargets: Set<string>, currentTargets: Set<string>): void {
  for (const rel of previousTargets) {
    if (currentTargets.has(rel)) continue;
    if (!isSafeContainedTarget(realOutputHome, outputHome, rel)) continue;
    removePath(path.join(outputHome, rel));
  }
}

function isValidReceipt(value: unknown): value is MaterializationReceipt {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1) return false;
  if (!Array.isArray(v.resources)) return false;
  return v.resources.every(
    (r) => r && typeof r === 'object' && typeof (r as Record<string, unknown>).kind === 'string' && typeof (r as Record<string, unknown>).target === 'string',
  );
}

function readPriorReceipt(outputHome: string): MaterializationReceipt | null {
  const receiptPath = path.join(outputHome, RECEIPT_FILE);
  try {
    if (fs.lstatSync(receiptPath).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(receiptPath, 'utf-8'));
  } catch {
    return null;
  }
  return isValidReceipt(parsed) ? parsed : null;
}

/** Materialize `resolved` into a fresh native home for `options.harness`. Fails closed (throws
 * `AgentPackageError`, writes nothing new) for an unsupported harness or missing capability.
 * Idempotent: same inputs give a byte-identical receipt and prune managed paths no longer needed. */
export function materializeAgentPackage(resolved: ResolvedAgentPackage, options: MaterializeOptions): MaterializationReceipt {
  const { harness, harnessVersion, outputHome } = options;
  if (!resolved.manifest.execution.harnesses.supported.includes(harness)) {
    throw new AgentPackageError(
      `package '${resolved.manifest.slug}' does not declare '${harness}' as a supported harness`,
      'unsupported-harness',
      resolved.manifest.execution.harnesses.supported,
    );
  }

  const resources = effectiveResources(resolved, harness);
  assertCapabilitiesSupported(resources, harness, harnessVersion);

  fs.mkdirSync(outputHome, { recursive: true });
  // The output home now exists, so realpath it once: every write/delete is verified against this
  // canonical root, so a planted symlink at the config-dir join or a symlinked ancestor named by a
  // stale receipt can't escape.
  const realOutputHome = fs.realpathSync(outputHome);
  const prior = readPriorReceipt(outputHome);
  const previousTargets = new Set((prior?.resources ?? []).filter((r) => r.kind !== 'mcp').map((r) => r.target));

  const entries: MaterializationReceiptEntry[] = [];
  const mcpResources = resources.filter((r) => r.kind === 'mcp');
  const hookResources = resources.filter((r) => r.kind === 'hooks');
  const mcpTargets = materializeMcp(mcpResources, harness, outputHome, realOutputHome);
  const hookTargets = materializeHooks(hookResources, harness, outputHome, realOutputHome);

  for (const r of resources) {
    let target: string;
    if (r.kind === 'instructions') target = materializeInstructions(r, harness, outputHome, realOutputHome);
    else if (r.kind === 'skills') target = materializeSkill(r, harness, outputHome, realOutputHome);
    else if (r.kind === 'subagents') target = materializeSubagent(r, harness, outputHome, realOutputHome);
    else if (r.kind === 'mcp') target = mcpTargets[mcpResources.indexOf(r)];
    else target = hookTargets.get(r.name)!;
    entries.push({ kind: r.kind, name: r.name, target, sha256: r.sha256, provenance: r.provenance });
  }

  const currentTargets = new Set(entries.map((e) => e.target));
  pruneStaleManagedPaths(realOutputHome, outputHome, previousTargets, currentTargets);

  const receipt: MaterializationReceipt = {
    schemaVersion: 1,
    agent: { ref: packageRef(resolved), digest: `sha256:${resolved.digest}` },
    harness: { id: harness, version: harnessVersion },
    resources: entries,
    warnings: [],
  };
  const receiptPath = path.join(outputHome, RECEIPT_FILE);
  assertLeafSafe(realOutputHome, receiptPath, 'materialization receipt');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

export function sha256OfReceiptFile(receiptPath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex');
}
