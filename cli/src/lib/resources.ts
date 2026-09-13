/**
 * Unified resource discovery for agents.
 * Scans filesystem (source of truth) to find all installed resources for an agent.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from './types.js';
import { AGENTS, listInstalledMcpsWithScope } from './agents.js';
import { listInstalledCommandsWithScope, parseCommandMetadata } from './commands.js';
import { listInstalledSkillsWithScope, parseSkillMetadata, type SkillParseError } from './plugins/skills.js';
import { listOnDiskHooks } from './resource-inventory.js';
import { listInstalledInstructionsWithScope } from './rules/rules.js';
import { getEffectiveHome } from './installations/versions.js';
import { listMcpServerConfigs } from './mcp.js';
import { WorkflowsHandler } from './resources/workflows.js';
import { isCapable } from './capabilities.js';
import {
  getProjectAgentsDir,
  getUserAgentsDir,
  getSystemAgentsDir,
  getEnabledExtraRepos,
} from './state.js';
import { isNameActiveInResourceProfile, type ProfiledResourceKind } from './resource-profiles.js';
import { resolveSnapshotSha } from './git.js';

// ─── Resource resolver ────────────────────────────────────────────────────────

/** Resource kind — matches the subdirectory name under each repo root. */
export type ResourceKind =
  | 'commands'
  | 'skills'
  | 'hooks'
  | 'rules'
  | 'mcp'
  | 'clis'
  | 'permissions'
  | 'subagents'
  | 'workflows'
  | 'profiles'
  | 'routers'
  | 'secrets';

/** A resource resolved with its origin. */
export interface ResolvedResource {
  name: string;
  /** Absolute path to the resource file or directory. */
  path: string;
  /**
   * Source layer: 'project' | 'user' | 'system' for built-in layers,
   * or the alias name (e.g. 'rush') for extra repos registered in agents.yaml.
   */
  source: string;
  /**
   * Absolute path to the DotAgents repo root this resource resolved from (the
   * project/user/system/extra-repo dir — one level above the `kind`
   * subdirectory). DotAgents repos are git-tracked (plugins.ts), so this pairs
   * with {@link snapshotSha} to answer "which commit of which repo".
   */
  repoRoot: string;
  /**
   * Short HEAD sha of `repoRoot`'s git checkout, lazily resolved (a getter,
   * not computed at construction) and memoized per repoRoot
   * (`git.ts` `resolveSnapshotSha`) — a caller that never inspects provenance
   * never pays for the git shell-out, and resolving many resources from the
   * same repo pays for exactly one. `undefined` when `repoRoot` isn't a git
   * repo (or has no commits).
   */
  readonly snapshotSha: string | undefined;
  /**
   * Alternate names this resource declares in its frontmatter `aliases:`, which
   * {@link resolveResource} matches in addition to the canonical name. Lazily
   * read from disk on first access and memoized, so listing resources never pays
   * for it unless a caller inspects an alias. `undefined` when the resource
   * declares none (or for a kind that doesn't support aliases — only `skills` and
   * `commands` do), mirroring {@link snapshotSha} so a strict `toEqual` on a
   * ResolvedResource ignores the absent field.
   */
  readonly aliases: string[] | undefined;
}

/**
 * The declared frontmatter `aliases:` of a single resource, or `[]` for a kind
 * that doesn't support aliases. Only `skills` (SKILL.md) and `commands` carry
 * them today. `resourcePath` is the skill directory or the command file.
 */
function resourceAliases(kind: ResourceKind, resourcePath: string): string[] {
  if (kind === 'skills') return parseSkillMetadata(resourcePath)?.aliases ?? [];
  if (kind === 'commands') return parseCommandMetadata(resourcePath)?.aliases ?? [];
  return [];
}

/** Build a ResolvedResource with lazy, memoized `snapshotSha` and `aliases` getters. */
function withProvenance(
  base: { name: string; path: string; source: string; repoRoot: string },
  kind: ResourceKind,
): ResolvedResource {
  let aliasesComputed = false;
  let aliasesCache: string[] | undefined;
  return {
    ...base,
    get snapshotSha() {
      return resolveSnapshotSha(base.repoRoot);
    },
    get aliases() {
      if (!aliasesComputed) {
        const found = resourceAliases(kind, base.path);
        // Undefined (not []) when none, so a strict toEqual on a ResolvedResource
        // ignores it — the same convention snapshotSha uses.
        aliasesCache = found.length > 0 ? found : undefined;
        aliasesComputed = true;
      }
      return aliasesCache;
    },
  };
}

function profiledKind(kind: ResourceKind): ProfiledResourceKind | null {
  switch (kind) {
    case 'commands':
    case 'skills':
    case 'hooks':
    case 'mcp':
    case 'permissions':
    case 'subagents':
    case 'secrets':
      return kind;
    case 'rules':
      return 'memory';
    default:
      return null;
  }
}

function resourceIsActive(kind: ResourceKind, name: string, source: string): boolean {
  const activeKind = profiledKind(kind);
  return activeKind ? isNameActiveInResourceProfile(activeKind, name, source) : true;
}

/**
 * Documentation filenames that live *beside* resources, describing the directory
 * rather than being a resource in it. A DotAgents repo keeps a `README.md` (for
 * humans) and an `AGENTS.md` (for agents) in each resource dir, with
 * `CLAUDE.md`/`GEMINI.md` symlinked to the latter. Without this filter every one
 * of them materializes as a resource — `commands/README.md` installs a bogus
 * `/README` slash command into every agent home.
 *
 * `rules` is exempt: there `AGENTS.md` IS the resource (the composed ruleset that
 * syncs as each agent's memory file), not documentation about the directory.
 */
const DOC_BASENAMES = new Set(['readme', 'agents', 'claude', 'gemini']);

/**
 * True when `rawName` (a filename with its extension already stripped) names a
 * directory doc rather than a resource of `kind`. Exported so every enumerator
 * shares one definition — `listCentralCommands` and `discoverCommands` in
 * `commands.ts` do their own `readdirSync` scans, and without this they would
 * list a `README` that `resolveResource` then refuses to open.
 */
export function isDirectoryDoc(kind: ResourceKind, rawName: string): boolean {
  if (kind === 'rules') return false;
  return DOC_BASENAMES.has(rawName.toLowerCase());
}

/**
 * Resolve a single resource by kind + name using project > user > system precedence.
 * For file-based resources the path ends in `.md`, `.yaml`, or `.yml` as appropriate.
 * Returns null when the resource does not exist in any scope.
 *
 * Extra repos are searched last (after system) to match syncResourcesToVersion order.
 */
export function resolveResource(
  kind: ResourceKind,
  name: string,
  cwd?: string,
): ResolvedResource | null {
  const projectDir = getProjectAgentsDir(cwd);
  const extraRepos = getEnabledExtraRepos();

  const candidates: Array<[string, string, string]> = [
    ...(projectDir ? [[path.join(projectDir, kind), 'project', projectDir] as [string, string, string]] : []),
    [path.join(getUserAgentsDir(), kind), 'user', getUserAgentsDir()],
    [path.join(getSystemAgentsDir(), kind), 'system', getSystemAgentsDir()],
    ...extraRepos.map((e): [string, string, string] => [path.join(e.dir, kind), e.alias, e.dir]),
  ];

  for (const [dir, source, repoRoot] of candidates) {
    if (!fs.existsSync(dir)) continue;

    // Try exact name (for directories like skills/subagents)
    const exactPath = path.join(dir, name);
    if (fs.existsSync(exactPath)) {
      if (resourceIsActive(kind, name, source)) {
        return withProvenance({ name, path: exactPath, source, repoRoot }, kind);
      }
      continue;
    }

    // Try with common file extensions. A directory doc (README/AGENTS/CLAUDE/
    // GEMINI) describes the directory and is never itself a resource.
    if (isDirectoryDoc(kind, name)) continue;
    for (const ext of ['.md', '.yaml', '.yml']) {
      const withExt = exactPath + ext;
      if (fs.existsSync(withExt)) {
        if (resourceIsActive(kind, name, source)) {
          return withProvenance({ name, path: withExt, source, repoRoot }, kind);
        }
        continue;
      }
    }
  }

  // Alias fallback (skills/commands only). A resource may declare `aliases:` in
  // its frontmatter; match `name` against those AFTER every layer's canonical
  // lookup above has missed, so a canonical resource named `name` always wins a
  // collision regardless of layer. Layer precedence still applies among aliases,
  // and entries are sorted so a same-layer alias collision resolves deterministically.
  if (kind === 'skills' || kind === 'commands') {
    for (const [dir, source, repoRoot] of candidates) {
      if (!fs.existsSync(dir)) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.')) continue;
        const rawName = entry.name.replace(/\.(md|yaml|yml)$/, '');
        if (isDirectoryDoc(kind, rawName)) continue;
        const resourcePath = path.join(dir, entry.name);
        if (!resourceAliases(kind, resourcePath).includes(name)) continue;
        if (!resourceIsActive(kind, rawName, source)) continue;
        // Resolve to the canonical resource (its real name), not the alias.
        return withProvenance({ name: rawName, path: resourcePath, source, repoRoot }, kind);
      }
    }
  }

  return null;
}

/**
 * List all resources of a given kind across project, user, and system scopes.
 * Returns a deduplicated union (project wins on name collision), each entry
 * annotated with its origin source.
 */
export function listResources(
  kind: ResourceKind,
  cwd?: string,
): ResolvedResource[] {
  const seen = new Set<string>();
  const results: ResolvedResource[] = [];
  const projectDir = getProjectAgentsDir(cwd);
  const extraRepos = getEnabledExtraRepos();

  const roots: Array<[string, string, string]> = [
    ...(projectDir ? [[path.join(projectDir, kind), 'project', projectDir] as [string, string, string]] : []),
    [path.join(getUserAgentsDir(), kind), 'user', getUserAgentsDir()],
    [path.join(getSystemAgentsDir(), kind), 'system', getSystemAgentsDir()],
    ...extraRepos.map((e): [string, string, string] => [path.join(e.dir, kind), e.alias, e.dir]),
  ];

  // Hooks use a one-level event-group layout (hooks/pre-tool-use/git-guard.sh).
  // A flat readdir treats `pre-tool-use` as the resource name, so `system:*`
  // pattern expansion never includes nested scripts — and `agents sync --force`
  // leaves stale flat copies in version homes forever. Mirror getAvailableResources:
  // expand group dirs that hold scripts (install name = basename with extension),
  // keep fixture-only dirs as bundles, and keep top-level scripts as resources.
  // Keep this logic self-contained (no hooks.ts import) so vi.mock of hooks.js
  // in versions tests does not break listResources.
  if (kind === 'hooks') {
    const HOOK_SCRIPT_EXTS = new Set([
      '.sh', '.bash', '.zsh', '.py', '.js', '.ts', '.mjs', '.cjs', '.rb', '.pl', '.ps1', '.cmd', '.bat',
    ]);
    const HOOK_NON_SCRIPT_EXTS = new Set([
      '.md', '.markdown', '.rst', '.txt', '.yaml', '.yml', '.json', '.toml', '.ini', '.conf',
    ]);
    const HOOK_GROUP_SKIP = new Set(['node_modules', '.git', '.cache']);
    const isHookScriptName = (fileName: string, mode: number): boolean => {
      const ext = path.extname(fileName).toLowerCase();
      if (HOOK_SCRIPT_EXTS.has(ext)) return true;
      return (mode & 0o111) !== 0 && !HOOK_NON_SCRIPT_EXTS.has(ext);
    };
    for (const [dir, source, repoRoot] of roots) {
      if (!fs.existsSync(dir)) continue;
      let top: string[];
      try {
        top = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of top) {
        if (name.startsWith('.')) continue;
        const full = path.join(dir, name);
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(full);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) continue;
        if (stat.isFile()) {
          if (!isHookScriptName(name, stat.mode)) continue;
          // Docs that live beside hooks (README/AGENTS) are not resources.
          const raw = name.replace(/\.(md|yaml|yml)$/, '');
          if (isDirectoryDoc(kind, raw)) continue;
          if (seen.has(name)) continue;
          if (!resourceIsActive(kind, name, source)) continue;
          seen.add(name);
          results.push(withProvenance({
            name,
            path: full,
            source,
            repoRoot,
          }, kind));
          continue;
        }
        if (!stat.isDirectory() || HOOK_GROUP_SKIP.has(name)) continue;
        let nested: string[];
        try {
          nested = fs.readdirSync(full);
        } catch {
          continue;
        }
        const scripts: string[] = [];
        for (const nestedName of nested) {
          if (nestedName.startsWith('.')) continue;
          const nfull = path.join(full, nestedName);
          let nstat: fs.Stats;
          try {
            nstat = fs.lstatSync(nfull);
          } catch {
            continue;
          }
          if (nstat.isSymbolicLink() || !nstat.isFile()) continue;
          if (isHookScriptName(nestedName, nstat.mode)) scripts.push(nestedName);
        }
        if (scripts.length > 0) {
          for (const script of scripts) {
            if (seen.has(script)) continue;
            if (!resourceIsActive(kind, script, source)) continue;
            seen.add(script);
            results.push(withProvenance({
              name: script,
              path: path.join(full, script),
              source,
              repoRoot,
            }, kind));
          }
        } else {
          // Fixture-only directory bundle (hooks/tests/fixtures/…).
          if (seen.has(name)) continue;
          if (!resourceIsActive(kind, name, source)) continue;
          seen.add(name);
          results.push(withProvenance({
            name,
            path: full,
            source,
            repoRoot,
          }, kind));
        }
      }
    }
    return results;
  }

  for (const [dir, source, repoRoot] of roots) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { continue; }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rawName = entry.name.replace(/\.(md|yaml|yml)$/, '');
      // Not isFile(): a Dirent for a symlink reports isFile() === false, and
      // CLAUDE.md/GEMINI.md are symlinks to AGENTS.md by convention. Anything
      // that is not a directory is a candidate doc; a resource directory that
      // happens to be named `agents/` is still a real resource.
      if (!entry.isDirectory() && isDirectoryDoc(kind, rawName)) continue;
      if (seen.has(rawName)) continue;
      if (!resourceIsActive(kind, rawName, source)) continue;
      seen.add(rawName);
      results.push(withProvenance({
        name: rawName,
        path: path.join(dir, entry.name),
        source,
        repoRoot,
      }, kind));
    }
  }

  return results;
}

/** A single installed resource (command, skill, memory file, or hook). */
export interface ResourceEntry {
  name: string;
  path: string;
  scope: 'user' | 'project';
  /** One-line description pulled from frontmatter; not all resource kinds have one. */
  description?: string;
}

/** A skill resource entry with optional rule count. */
export interface SkillResourceEntry extends ResourceEntry {
  ruleCount?: number;
}

/** An MCP server resource entry. */
interface McpResourceEntry {
  name: string;
  scope: 'user' | 'project';
  version?: string;
}

/** All resources installed for a specific agent. */
interface AgentResources {
  agentId: AgentId;
  commands: ResourceEntry[];
  skills: SkillResourceEntry[];
  skillErrors: SkillParseError[];
  mcp: McpResourceEntry[];
  memory: ResourceEntry[];
  hooks: ResourceEntry[];
  workflows: ResourceEntry[];
}

/** Options for resource discovery. */
interface GetAgentResourcesOptions {
  cwd?: string;
  scope?: 'user' | 'project' | 'all';
  /** For MCP scanning - whether the CLI is installed */
  cliInstalled?: boolean;
  /** Version home to scan for user-scoped resources */
  home?: string;
}

/**
 * Get all resources installed for a specific agent by scanning the filesystem.
 * This is the source of truth - not the tracking data in agents.yaml.
 */
export function getAgentResources(
  agentId: AgentId,
  options: GetAgentResourcesOptions = {}
): AgentResources {
  const { cwd = process.cwd(), scope = 'all', cliInstalled = true, home } = options;
  const agent = AGENTS[agentId];

  const shouldInclude = (resourceScope: 'user' | 'project'): boolean => {
    if (scope === 'all') return true;
    return resourceScope === scope;
  };

  // Commands
  const commands: ResourceEntry[] = [];
  for (const cmd of listInstalledCommandsWithScope(agentId, cwd, { home })) {
    if (shouldInclude(cmd.scope)) {
      commands.push({ name: cmd.name, path: cmd.path, scope: cmd.scope, description: cmd.description });
    }
  }

  // Skills
  const skills: SkillResourceEntry[] = [];
  const skillErrors: SkillParseError[] = [];
  for (const skill of listInstalledSkillsWithScope(agentId, cwd, { home, errors: skillErrors })) {
    if (shouldInclude(skill.scope)) {
      skills.push({
        name: skill.name,
        path: skill.path,
        scope: skill.scope,
        ruleCount: skill.ruleCount,
        description: skill.metadata.description || undefined,
      });
    }
  }

  // MCP
  const mcp: McpResourceEntry[] = [];
  const mcpByName = new Map<string, McpResourceEntry>();

  // Project/user-scoped MCP definitions from .agents/mcp
  for (const server of listMcpServerConfigs(cwd)) {
    const scope = server.scope || 'user';
    if (shouldInclude(scope) && !mcpByName.has(server.name)) {
      mcpByName.set(server.name, { name: server.name, scope });
    }
  }

  if (cliInstalled) {
    const effectiveHome = home || getEffectiveHome(agentId);
    for (const m of listInstalledMcpsWithScope(agentId, cwd, { home: effectiveHome })) {
      if (!shouldInclude(m.scope)) continue;
      if (!mcpByName.has(m.name)) {
        mcpByName.set(m.name, { name: m.name, scope: m.scope, version: m.version });
      }
    }
  }

  mcp.push(...mcpByName.values());

  // Memory/Instructions
  const memory: ResourceEntry[] = [];
  for (const instr of listInstalledInstructionsWithScope(agentId, cwd, { home })) {
    if (instr.exists && shouldInclude(instr.scope)) {
      memory.push({
        name: agent.instructionsFile,
        path: instr.path,
        scope: instr.scope,
      });
    }
  }

  // Hooks — routed through the resource-inventory chokepoint (RUSH-2238) so
  // inspect/doctor/view share one listing and one (absolute-hooksDir-safe)
  // path resolution.
  const hooks: ResourceEntry[] = [];
  for (const ref of listOnDiskHooks(agentId, { cwd, home })) {
    const hookScope = ref.source as 'user' | 'project';
    if (shouldInclude(hookScope)) {
      hooks.push({ name: ref.name, path: ref.path, scope: hookScope });
    }
  }

  // Workflows
  const workflows: ResourceEntry[] = [];
  if (isCapable(agentId, 'workflows')) {
    for (const w of WorkflowsHandler.listAll(agentId as Parameters<typeof WorkflowsHandler.listAll>[0], cwd)) {
      workflows.push({ name: w.name, path: w.path, scope: w.layer === 'project' ? 'project' : 'user' });
    }
  }

  return {
    agentId,
    commands,
    skills,
    skillErrors,
    mcp,
    memory,
    hooks,
    workflows,
  };
}
