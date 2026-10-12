/**
 * Native-home materializer (PHNX-3838).
 *
 * `materializeAgentPackage` is the harness-adapter layer: it takes the ONE
 * canonical result `resolveAgentPackage` already decided and projects it into
 * a fresh, isolated native home for one harness (Claude Code, Codex, or
 * OpenCode). It reuses the codebase's existing native-projection primitives
 * instead of re-deriving per-harness format knowledge:
 *
 *   - `agentConfigDirName` / `AGENTS[..].capabilities.rules.file` (agent-spec/agents.ts)
 *     for instructions placement
 *   - `subagentTarget(...)` + its registered transforms (subagents-registry.ts)
 *     for subagent projection
 *   - `writeMcpConfig` (lib/mcp.ts) for per-harness MCP config format
 *   - `registerHooksToSettings` (lib/hooks/install.ts) for per-harness hook
 *     registration, including its stale-registration GC
 *
 * It writes a deterministic, unsigned `materialization-receipt.json` — every
 * `target` path it lists is a path THIS materializer owns, so a second run
 * whose resource set shrank can prune exactly those paths without touching
 * anything else in the output home.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId, ManifestHook } from '../types.js';
import { supports } from '../capabilities.js';
import { AGENTS, agentConfigDirName, getMcpConfigPathForHome } from './agents.js';
import { getHooksDirInHome } from '../hooks/install.js';
import { registerHooksToSettings } from '../hooks/install.js';
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
    /* already gone */
  }
}

/**
 * Fail closed: every effective resource's kind must be a supported capability
 * on this harness+version. MCP carries two finer-grained sub-capabilities the
 * coarse `mcp` flag does not cover — `mcpHttp` (remote transport at all) and
 * `mcpHeaders` (custom headers on a remote server) — mirroring the check
 * `registerMcp` already applies (agent-spec/agents.ts). Skipping these let a
 * harness with `mcpHttp: false` (e.g. opencode) or `mcpHeaders: false` (e.g.
 * codex) silently receive an http/sse server or a header it cannot express.
 */
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

/**
 * The load-bearing containment invariant: every path this materializer is about
 * to write to (or delete) must, once symlinks in its existing prefix are
 * resolved, stay inside `realOutputHome` (the realpath of the output home). The
 * writers form their targets by APPENDING the harness config dir + resource name
 * to `outputHome` — so a symlink planted at that join point (e.g. an
 * `outputHome/.claude` symlink → the live `~/.claude`) redirects the write
 * outside the output home. `resolveOutputHome`'s front-door guard can't see that
 * child; this check, in the materializer that every writer already funnels
 * through, is what protects a direct (Factory / Prix Cloud) caller too. Called
 * BEFORE any `mkdirSync`/`copyFileSync`/`rmSync`, since `mkdir -p` would happily
 * traverse the symlink first.
 */
function assertTargetContained(realOutputHome: string, target: string, label: string): void {
  const canonical = realpathExistingPrefix(target);
  if (canonical !== realOutputHome && !canonical.startsWith(realOutputHome + path.sep)) {
    throw new AgentPackageError(
      `${label}: refusing to write outside the output home — '${target}' resolves outside '${realOutputHome}'`,
      'path-escape',
    );
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
  // Guard the concrete leaf file(s) `target.write` will touch, immediately before
  // it writes — a preplanted symlink AT the leaf (dir real, leaf a symlink to
  // outside) would otherwise be followed by the writer.
  for (const occ of target.occupied(dir, resource.name)) {
    assertTargetContained(realOutputHome, occ.path, `${harness} subagent '${resource.name}'`);
  }
  target.write(dir, { name: resource.name, path: resource.sourcePath });
  const occupied = target.occupied(dir, resource.name)[0];
  return path.relative(outputHome, occupied.path);
}

/**
 * MCP servers write into one shared per-harness config file that may also
 * carry unrelated content the materializer does not own (an oauth account, a
 * project list — anything the real harness binary writes into that same file
 * once the pod actually runs it). `writeMcpConfig`'s `overwrite` mode already
 * preserves every other top-level key; `allowEmpty: true` is what lets THIS
 * call — which always knows the complete current mcp resource set, including
 * zero — converge the mcp section to exactly that set, rather than the
 * generic path-based pruner deleting the whole file when the package's last
 * mcp resource is removed (that would take the unrelated content with it).
 * Runs whenever the file already exists so a package with zero mcp resources
 * that never wrote one doesn't spuriously create an empty config.
 */
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
  try {
    writeMcpConfig(harness, configPath, servers, 'overwrite', { allowEmpty: true });
  } catch (err) {
    throw new AgentPackageError(`${harness}: cannot write mcp config — ${(err as Error).message}`, 'unsupported-capability');
  }
  const rel = path.relative(outputHome, configPath);
  return resources.map(() => rel);
}

/**
 * The registration file(s) `registerHooksToSettings` writes for a harness, which
 * sit BESIDE the hooks dir (not under it), so the hooks-dir guard doesn't cover
 * them. These MUST mirror the LITERAL paths the per-harness registrars in
 * `hooks/install.ts` use, not `agentConfigDirName` — those diverge (opencode
 * registers under the literal `.config/opencode`, while `agentConfigDirName`
 * ('opencode') is `.opencode`). Kept in lockstep with `registerHooksForCodex`
 * (`.codex/hooks.json` + `.codex/config.toml`) and `registerHooksForOpenCode`
 * (`.config/opencode/plugins/agents-cli-hooks.ts`); the default
 * (`<config>/settings.json`) matches the Claude-family registrar
 * (`registerHooksForClaude`, whose `configDirName` defaults to
 * `agentConfigDirName`). Pinned by a completeness test.
 */
function hookRegistrationLeaves(harness: AgentId, outputHome: string): string[] {
  if (harness === 'codex') {
    return [path.join(outputHome, '.codex', 'hooks.json'), path.join(outputHome, '.codex', 'config.toml')];
  }
  if (harness === 'opencode') {
    return [path.join(outputHome, '.config', 'opencode', 'plugins', 'agents-cli-hooks.ts')];
  }
  return [path.join(outputHome, agentConfigDirName(harness), 'settings.json')];
}

function materializeHooks(resources: ResolvedResource[], harness: AgentId, outputHome: string, realOutputHome: string): Map<string, string> {
  const targets = new Map<string, string>();
  if (resources.length === 0) return targets;
  const hooksDir = getHooksDirInHome(harness, outputHome);
  // Guarding the hooks dir also protects the harness settings.json that
  // registerHooksToSettings writes below — both live under the same
  // agent-config-dir ancestor, so a symlink there is caught before either write.
  assertTargetContained(realOutputHome, hooksDir, `${harness} hooks dir`);
  fs.mkdirSync(hooksDir, { recursive: true });
  const manifest: Record<string, ManifestHook> = {};
  for (const r of resources) {
    const { def, scriptPath } = r.hook!;
    // The hook name is attacker-controlled (it comes from the package's
    // hooks/*.yaml `name:`) and is used as a filename here — a name like
    // '../../../.config/foo' would copy + chmod +x OUTSIDE the output home.
    // Require a single safe path segment AND re-assert containment before the
    // write, failing loud rather than escaping.
    if (!isSafeSegmentName(r.name)) {
      throw new AgentPackageError(`${harness}: hook name '${r.name}' is not a safe single path segment`, 'invalid-resource');
    }
    const hooksDirResolved = path.resolve(hooksDir);
    const destScript = path.join(hooksDirResolved, `${r.name}${path.extname(scriptPath)}`);
    if (!destScript.startsWith(hooksDirResolved + path.sep)) {
      throw new AgentPackageError(`${harness}: hook '${r.name}' resolves outside the hooks directory`, 'invalid-resource');
    }
    // Realpath-guard the script LEAF immediately before the copy + chmod: a
    // preplanted symlink at destScript (hooksDir real, leaf a symlink to outside)
    // would otherwise have `copyFileSync`/`chmodSync` follow it.
    assertTargetContained(realOutputHome, destScript, `${harness} hook '${r.name}' script`);
    fs.copyFileSync(scriptPath, destScript);
    fs.chmodSync(destScript, 0o755);
    manifest[r.name] = { script: destScript, events: def.events, matcher: def.matcher, timeout: def.timeout };
    targets.set(r.name, path.relative(outputHome, destScript));
  }
  // Guard the file(s) registerHooksToSettings writes (settings.json / hooks.json /
  // config.toml / the opencode plugin) BEFORE it runs, so a preplanted symlink at
  // a registration leaf inside an otherwise-real config dir can't redirect it.
  for (const leaf of hookRegistrationLeaves(harness, outputHome)) {
    assertTargetContained(realOutputHome, leaf, `${harness} hook registration`);
  }
  const result = registerHooksToSettings(harness, outputHome, manifest);
  if (result.errors.length > 0) {
    throw new AgentPackageError(`${harness}: failed to register hook(s) — ${result.errors.join('; ')}`, 'invalid-resource');
  }
  return targets;
}

/** Deterministic package ref used in the receipt — `<slug>@<manifest-digest-prefix>`, since packages carry no separate semver here. */
function packageRef(resolved: ResolvedAgentPackage): string {
  return `${resolved.manifest.slug}@${resolved.digest.slice(0, 12)}`;
}

/**
 * True when `rel` is a target this pruner may safely delete: a non-empty,
 * `..`-free RELATIVE path whose CANONICAL form (symlinks in its existing prefix
 * resolved) stays strictly inside `realOutputHome`. The receipt is unsigned and
 * sits inside the output home, so a planted receipt could carry a `target` of
 * `../../victim`, `/etc/passwd`, OR an innocuous-looking `skills/keep.txt` sitting
 * one level under a symlinked ancestor (`outputHome/skills` → a victim dir) — a
 * purely textual containment check misses the last shape because `removePath`'s
 * `lstat` only refuses to follow the FINAL component, still traversing symlinked
 * ancestors. Realpath-verify before deleting; skip (never delete) anything that
 * escapes.
 */
function isSafeContainedTarget(realOutputHome: string, outputHome: string, rel: unknown): boolean {
  if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0')) return false;
  if (path.isAbsolute(rel)) return false;
  if (rel.split(/[\\/]/).includes('..')) return false;
  const canonical = realpathExistingPrefix(path.resolve(outputHome, rel));
  return canonical.startsWith(realOutputHome + path.sep);
}

/** Delete any path this materializer owned in a PRIOR run of this exact output home that is no longer part of the current resource set. */
function pruneStaleManagedPaths(realOutputHome: string, outputHome: string, previousTargets: Set<string>, currentTargets: Set<string>): void {
  for (const rel of previousTargets) {
    if (currentTargets.has(rel)) continue;
    // The prior receipt is unsigned; never delete a target that escapes the
    // output home — textually OR through a symlinked ancestor.
    if (!isSafeContainedTarget(realOutputHome, outputHome, rel)) continue;
    removePath(path.join(outputHome, rel));
  }
}

/** Structurally validate an untrusted, unsigned prior receipt before its targets are ever trusted for deletion. */
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(outputHome, RECEIPT_FILE), 'utf-8'));
  } catch {
    return null;
  }
  return isValidReceipt(parsed) ? parsed : null;
}

/**
 * Materialize `resolved` into a fresh native home for `options.harness`. Fails
 * closed (throws `AgentPackageError`, writes nothing new) when the harness is
 * not declared supported by the package, or when any effective resource needs
 * a capability the harness+version does not have. Idempotent and
 * deterministic: re-running against the same `outputHome` with the same
 * inputs produces a byte-identical receipt and prunes any managed path this
 * materializer previously wrote that the current resource set no longer needs.
 */
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
  // The output home now exists, so realpath it once: every write/delete target
  // is verified against THIS canonical root, so a symlink planted at the
  // harness-config-dir join point (or a symlinked ancestor named by a stale
  // receipt) can't redirect a write/delete outside the output home.
  const realOutputHome = fs.realpathSync(outputHome);
  const prior = readPriorReceipt(outputHome);
  // 'mcp' is excluded: it's a shared config file `materializeMcp` converges
  // (including to empty) by editing its own section, not a path this generic
  // delete-by-path pruner may ever remove wholesale — see materializeMcp's doc.
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
  // Guard the receipt leaf too: a preplanted symlink at materialization-receipt.json
  // would otherwise have this final write follow it outside the output home.
  assertTargetContained(realOutputHome, receiptPath, 'materialization receipt');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

/** Lowercase hex sha256 of arbitrary bytes — exposed for callers that want to verify the receipt file's own digest (Factory's observed-digest record). */
export function sha256OfReceiptFile(receiptPath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex');
}
