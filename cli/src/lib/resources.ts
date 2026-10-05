
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

export interface ResolvedResource {
  name: string;
  path: string;
  source: string;
  repoRoot: string;
  readonly snapshotSha: string | undefined;
  readonly aliases: string[] | undefined;
}

function resourceAliases(kind: ResourceKind, resourcePath: string): string[] {
  if (kind === 'skills') return parseSkillMetadata(resourcePath)?.aliases ?? [];
  if (kind === 'commands') return parseCommandMetadata(resourcePath)?.aliases ?? [];
  return [];
}

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

const DOC_BASENAMES = new Set(['readme', 'agents', 'claude', 'gemini']);

export function isDirectoryDoc(kind: ResourceKind, rawName: string): boolean {
  // Directory docs are never resources; rules/AGENTS.md is the deliberate exception.
  if (kind === 'rules') return false;
  return DOC_BASENAMES.has(rawName.toLowerCase());
}

export function resolveResource(
  kind: ResourceKind,
  name: string,
  cwd?: string,
): ResolvedResource | null {
  // Resolve canonical names across every layer before alias fallback. Normal
  // layer precedence wins, and sorted entries make alias collisions deterministic.
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

    const exactPath = path.join(dir, name);
    if (fs.existsSync(exactPath)) {
      if (resourceIsActive(kind, name, source)) {
        return withProvenance({ name, path: exactPath, source, repoRoot }, kind);
      }
      continue;
    }

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
        return withProvenance({ name: rawName, path: resourcePath, source, repoRoot }, kind);
      }
    }
  }

  return null;
}

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

  if (kind === 'hooks') {
    // Hooks use one event-group level: script children are resources, while a
    // fixture-only directory remains a bundle so cleanup sees the same shape as sync.
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

export interface ResourceEntry {
  name: string;
  path: string;
  scope: 'user' | 'project';
  description?: string;
}

export interface SkillResourceEntry extends ResourceEntry {
  ruleCount?: number;
}

interface McpResourceEntry {
  name: string;
  scope: 'user' | 'project';
  version?: string;
}

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

interface GetAgentResourcesOptions {
  cwd?: string;
  scope?: 'user' | 'project' | 'all';
  cliInstalled?: boolean;
  home?: string;
}

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

  const commands: ResourceEntry[] = [];
  for (const cmd of listInstalledCommandsWithScope(agentId, cwd, { home })) {
    if (shouldInclude(cmd.scope)) {
      commands.push({ name: cmd.name, path: cmd.path, scope: cmd.scope, description: cmd.description });
    }
  }

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

  const mcp: McpResourceEntry[] = [];
  const mcpByName = new Map<string, McpResourceEntry>();

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

  const hooks: ResourceEntry[] = [];
  for (const ref of listOnDiskHooks(agentId, { cwd, home })) {
    const hookScope = ref.source as 'user' | 'project';
    if (shouldInclude(hookScope)) {
      hooks.push({ name: ref.name, path: ref.path, scope: hookScope });
    }
  }

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
