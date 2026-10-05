
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import type { AgentId, SkillMetadata, InstalledSkill } from '../types.js';
import { normalizeAliases } from '../resource-aliases.js';
import { AGENTS, ensureSkillsDir, agentConfigDirName } from '../agents.js';
import { capableAgents, isCapable } from '../capabilities.js';
import { getAgentsDir, getUserSkillsDir, getSkillsDir as getSystemSkillsDir, getProjectAgentsDir, getEnabledExtraRepos, getTrashSkillsDir } from '../state.js';
import { getEffectiveHome, getVersionHomePath, listInstalledVersions } from '../installations/store.js';
import { listCommandSkillsInVersion } from '../command-skills.js';
import { pluginSkillDirs, listPluginSkillNames } from '../staleness/writers/sources.js';
import { emit } from '../feed/events.js';

const HOME = os.homedir();

export function getSkillsDir(): string {
  return getUserSkillsDir();
}

export function ensureCentralSkillsDir(): void {
  const dir = getUserSkillsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getAgentSkillsDir(agentId: AgentId): string {
  const home = getEffectiveHome(agentId);
  return path.join(home, agentConfigDirName(agentId), 'skills');
}

export function getProjectSkillsDir(agentId: AgentId, cwd: string = process.cwd()): string {
  const dirs: string[] = [];
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (projectAgentsDir) {
    dirs.push(path.join(projectAgentsDir, 'skills'));
  }
  dirs.push(path.join(cwd, `.${agentId}`, 'skills'));
  for (const dir of dirs) {
    if (fs.existsSync(dir)) return dir;
  }
  return dirs[0];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateSkillMetadata(metadata: SkillMetadata | null, skillName: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!metadata) {
    errors.push('SKILL.md not found or has no valid frontmatter');
    return { valid: false, errors, warnings };
  }

  if (!metadata.name || metadata.name.trim() === '') {
    errors.push('Missing required field: name');
  } else {
    if (metadata.name.length > 64) {
      errors.push(`name exceeds 64 characters (${metadata.name.length})`);
    }
    if (!/^[a-z0-9-]+$/.test(metadata.name)) {
      warnings.push('name should be lowercase with hyphens (e.g., my-skill-name)');
    }
  }

  if (!metadata.description || metadata.description.trim() === '') {
    errors.push('Missing required field: description');
  } else if (metadata.description.length > 1024) {
    warnings.push(`description exceeds 1024 characters (${metadata.description.length})`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

export interface SkillParseError {
  name: string;
  path: string;
  error: string;
  scope: 'user' | 'project';
}

export interface SkillParseResult {
  metadata: SkillMetadata | null;
  error?: string;
}

export function tryParseSkillMetadata(skillDir: string): SkillParseResult {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    return { metadata: null, error: 'SKILL.md not found' };
  }

  try {
    const content = fs.readFileSync(skillMdPath, 'utf-8');
    const lines = content.split('\n');

    if (lines[0] === '---') {
      const endIndex = lines.slice(1).findIndex((l) => l === '---');
      if (endIndex > 0) {
        const frontmatter = lines.slice(1, endIndex + 1).join('\n');
        const parsed = yaml.parse(frontmatter);
        return {
          metadata: {
            name: parsed.name || '',
            description: parsed.description || '',
            author: parsed.author,
            version: parsed.version,
            license: parsed.license,
            keywords: parsed.keywords,
            aliases: normalizeAliases(parsed.aliases),
          },
        };
      }
    }

    return { metadata: null, error: 'No valid YAML frontmatter found' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown parse error';
    return { metadata: null, error: `Invalid YAML: ${msg}` };
  }
}

export function parseSkillMetadata(skillDir: string): SkillMetadata | null {
  return tryParseSkillMetadata(skillDir).metadata;
}

export function countSkillRules(skillDir: string): number {
  const rulesDir = path.join(skillDir, 'rules');
  if (!fs.existsSync(rulesDir)) {
    return 0;
  }

  try {
    const files = fs.readdirSync(rulesDir);
    return files.filter((f) => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

export function countSkillFiles(skillDir: string): number {
  if (!fs.existsSync(skillDir)) return 0;
  let count = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        if (dir === skillDir && entry.name === 'SKILL.md') continue;
        count++;
      }
    }
  };
  walk(skillDir);
  return count;
}

export interface DiscoveredSkill {
  name: string;
  path: string;
  metadata: SkillMetadata;
  ruleCount: number;
  validation: ValidationResult;
  parseError?: string;
  source?: string;
}

export function discoverSkillsFromRepo(repoPath: string): DiscoveredSkill[] {
  const skills: DiscoveredSkill[] = [];

  const searchPaths = [
    path.join(repoPath, 'skills'),
    path.join(repoPath, 'agent-skills'),
    repoPath,
  ];

  for (const searchPath of searchPaths) {
    if (!fs.existsSync(searchPath)) continue;

    try {
      const entries = fs.readdirSync(searchPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;

        const skillDir = path.join(searchPath, entry.name);
        const skillMdPath = path.join(skillDir, 'SKILL.md');

        if (fs.existsSync(skillMdPath)) {
          const parseResult = tryParseSkillMetadata(skillDir);
          const validation = validateSkillMetadata(parseResult.metadata, entry.name);
          skills.push({
            name: entry.name,
            path: skillDir,
            metadata: parseResult.metadata || { name: entry.name, description: '' },
            ruleCount: countSkillRules(skillDir),
            validation,
            parseError: parseResult.error,
          });
        }
      }
    } catch {
    }
  }

  return skills;
}

export function installSkill(
  sourcePath: string,
  skillName: string,
  agents: AgentId[],
  method: 'symlink' | 'copy' = 'symlink'
): { success: boolean; error?: string; warnings?: string[] } {
  const metadata = parseSkillMetadata(sourcePath);
  const validation = validateSkillMetadata(metadata, skillName);

  if (!validation.valid) {
    return {
      success: false,
      error: `Invalid skill: ${validation.errors.join(', ')}`,
      warnings: validation.warnings,
    };
  }

  ensureCentralSkillsDir();

  const centralPath = path.join(getSkillsDir(), skillName);

  if (!fs.existsSync(centralPath)) {
    try {
      fs.cpSync(sourcePath, centralPath, { recursive: true });
    } catch (err) {
      return { success: false, error: `Failed to copy skill: ${(err as Error).message}` };
    }
  }

  for (const agentId of agents) {
    if (!isCapable(agentId, 'skills')) {
      continue;
    }

    ensureSkillsDir(agentId);
    const agentSkillPath = path.join(getAgentSkillsDir(agentId), skillName);

    if (fs.existsSync(agentSkillPath)) {
      try {
        fs.rmSync(agentSkillPath, { recursive: true, force: true });
      } catch {
      }
    }

    try {
      if (method === 'symlink') {
        fs.symlinkSync(centralPath, agentSkillPath, 'dir');
      } else {
        fs.cpSync(centralPath, agentSkillPath, { recursive: true });
      }
    } catch (err) {
      return {
        success: false,
        error: `Failed to ${method} skill to ${agentId}: ${(err as Error).message}`,
      };
    }
  }

  emit('skill.install', { skill: skillName, agents });
  return { success: true };
}

export function skillExists(agentId: AgentId, skillName: string): boolean {
  const agentSkillPath = path.join(getAgentSkillsDir(agentId), skillName);
  return fs.existsSync(agentSkillPath);
}

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

function directoriesMatch(dir1: string, dir2: string): boolean {
  if (!fs.existsSync(dir1) || !fs.existsSync(dir2)) {
    return fs.existsSync(dir1) === fs.existsSync(dir2);
  }

  try {
    const files1 = fs.readdirSync(dir1).filter(f => f.endsWith('.md')).sort();
    const files2 = fs.readdirSync(dir2).filter(f => f.endsWith('.md')).sort();

    if (files1.length !== files2.length) return false;
    if (files1.join(',') !== files2.join(',')) return false;

    for (const file of files1) {
      const content1 = fs.readFileSync(path.join(dir1, file), 'utf-8');
      const content2 = fs.readFileSync(path.join(dir2, file), 'utf-8');
      if (normalizeContent(content1) !== normalizeContent(content2)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

export function skillContentMatches(
  agentId: AgentId,
  skillName: string,
  sourcePath: string
): boolean {
  const installedPath = path.join(getAgentSkillsDir(agentId), skillName);

  if (!fs.existsSync(installedPath) || !fs.existsSync(sourcePath)) {
    return false;
  }

  try {
    const installedSkillMd = path.join(installedPath, 'SKILL.md');
    const sourceSkillMd = path.join(sourcePath, 'SKILL.md');

    if (!fs.existsSync(installedSkillMd) || !fs.existsSync(sourceSkillMd)) {
      return false;
    }

    const installedContent = fs.readFileSync(installedSkillMd, 'utf-8');
    const sourceContent = fs.readFileSync(sourceSkillMd, 'utf-8');

    if (normalizeContent(installedContent) !== normalizeContent(sourceContent)) {
      return false;
    }

    const installedRulesDir = path.join(installedPath, 'rules');
    const sourceRulesDir = path.join(sourcePath, 'rules');

    return directoriesMatch(installedRulesDir, sourceRulesDir);
  } catch {
    return false;
  }
}

export function listCentralSkills(): string[] {
  const seen = new Set<string>();
  for (const dir of [getUserSkillsDir(), getSystemSkillsDir()]) {
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (!fs.existsSync(path.join(dir, e.name, 'SKILL.md'))) continue;
      seen.add(e.name);
    }
  }
  return Array.from(seen).sort();
}

export function resolveSkillSourcePath(skillName: string): string | null {
  for (const dir of [getUserSkillsDir(), getSystemSkillsDir()]) {
    const candidate = path.join(dir, skillName);
    if (fs.existsSync(path.join(candidate, 'SKILL.md'))) return candidate;
  }
  for (const extra of getEnabledExtraRepos()) {
    const candidate = path.join(extra.dir, 'skills', skillName);
    if (fs.existsSync(path.join(candidate, 'SKILL.md'))) return candidate;
  }
  for (const skillsDir of pluginSkillDirs()) {
    const candidate = path.join(skillsDir, skillName);
    if (fs.existsSync(path.join(candidate, 'SKILL.md'))) return candidate;
  }
  return null;
}

export function listAllSkills(): string[] {
  const seen = new Set<string>(listCentralSkills());
  for (const extra of getEnabledExtraRepos()) {
    const dir = path.join(extra.dir, 'skills');
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (!fs.existsSync(path.join(dir, e.name, 'SKILL.md'))) continue;
      seen.add(e.name);
    }
  }
  return Array.from(seen).sort();
}

export function getVersionSkillsDir(agent: AgentId, version: string): string {
  const home = getVersionHomePath(agent, version);
  return path.join(home, agentConfigDirName(agent), 'skills');
}

export function listSkillsInVersionHome(agent: AgentId, version: string): string[] {
  const dir = getVersionSkillsDir(agent, version);
  if (!fs.existsSync(dir)) return [];
  const commandWrappers = new Set(
    listCommandSkillsInVersion(path.join(getVersionHomePath(agent, version), agentConfigDirName(agent))),
  );
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .filter((e) => fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .filter((name) => !commandWrappers.has(name))
    .sort();
}

function versionSkillMatches(agent: AgentId, version: string, skillName: string): boolean {
  const installedPath = path.join(getVersionSkillsDir(agent, version), skillName);
  const sourcePath = resolveSkillSourcePath(skillName);
  if (!fs.existsSync(installedPath) || !sourcePath) return false;

  const installedSkillMd = path.join(installedPath, 'SKILL.md');
  const sourceSkillMd = path.join(sourcePath, 'SKILL.md');
  if (!fs.existsSync(installedSkillMd) || !fs.existsSync(sourceSkillMd)) return false;

  try {
    if (normalizeContent(fs.readFileSync(installedSkillMd, 'utf-8')) !==
        normalizeContent(fs.readFileSync(sourceSkillMd, 'utf-8'))) {
      return false;
    }
  } catch {
    return false;
  }

  return directoriesMatch(path.join(installedPath, 'rules'), path.join(sourcePath, 'rules'));
}

export interface VersionSkillDiff {
  agent: AgentId;
  version: string;
  toAdd: string[];
  toUpdate: string[];
  matched: string[];
  orphans: string[];
}

export function diffVersionSkills(agent: AgentId, version: string): VersionSkillDiff {
  const available = new Set([...listAllSkills(), ...listPluginSkillNames({ agent })]);

  if (AGENTS[agent].nativeAgentsSkillsDir) {
    return {
      agent,
      version,
      toAdd: [],
      toUpdate: [],
      matched: Array.from(available).sort(),
      orphans: [],
    };
  }

  const installed = new Set(listSkillsInVersionHome(agent, version));

  const toAdd: string[] = [];
  const toUpdate: string[] = [];
  const matched: string[] = [];
  const orphans: string[] = [];

  for (const name of available) {
    if (!installed.has(name)) {
      toAdd.push(name);
    } else if (!versionSkillMatches(agent, version, name)) {
      toUpdate.push(name);
    } else {
      matched.push(name);
    }
  }

  for (const name of installed) {
    if (!available.has(name)) orphans.push(name);
  }

  return { agent, version, toAdd: toAdd.sort(), toUpdate: toUpdate.sort(), matched, orphans: orphans.sort() };
}

function walkRelativeFiles(base: string): Set<string> {
  const out = new Set<string>();
  if (!fs.existsSync(base)) return out;
  const stack: string[] = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = path.join(base, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        stack.push(childRel);
      } else if (entry.isFile()) {
        out.add(childRel);
      }
    }
  }
  return out;
}

export function installSkillToVersion(
  agent: AgentId,
  version: string,
  skillName: string,
  method: 'symlink' | 'copy' = 'copy'
): { success: boolean; error?: string } {
  const sourcePath = resolveSkillSourcePath(skillName);
  if (!sourcePath) {
    return { success: false, error: `Skill '${skillName}' not found in central or any extra repo` };
  }

  const skillsDir = getVersionSkillsDir(agent, version);
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  const target = path.join(skillsDir, skillName);

  const preserved: Array<{ rel: string; buf: Buffer; mode: number }> = [];
  if (method === 'copy' && fs.existsSync(target) && !fs.lstatSync(target).isSymbolicLink()) {
    const sourceFiles = walkRelativeFiles(sourcePath);
    const installedFiles = walkRelativeFiles(target);
    for (const rel of installedFiles) {
      if (sourceFiles.has(rel)) continue;
      try {
        const abs = path.join(target, rel);
        preserved.push({
          rel,
          buf: fs.readFileSync(abs),
          mode: fs.statSync(abs).mode,
        });
      } catch {
      }
    }
  }

  if (fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false })) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (err) {
      return { success: false, error: `Failed to remove existing: ${(err as Error).message}` };
    }
  }

  try {
    if (method === 'symlink') {
      fs.symlinkSync(sourcePath, target, 'dir');
    } else {
      fs.cpSync(sourcePath, target, { recursive: true });
    }
  } catch (err) {
    return { success: false, error: `Failed to ${method}: ${(err as Error).message}` };
  }

  for (const { rel, buf, mode } of preserved) {
    try {
      const dest = path.join(target, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      fs.chmodSync(dest, mode);
    } catch {
    }
  }

  emit('skill.install', { skill: skillName, agent, version });
  return { success: true };
}

export function removeSkillFromVersion(
  agent: AgentId,
  version: string,
  skillName: string
): { success: boolean; error?: string } {
  const target = path.join(getVersionSkillsDir(agent, version), skillName);
  if (!fs.existsSync(target) && !fs.lstatSync(target, { throwIfNoEntry: false })) {
    return { success: true };
  }
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const trashDir = path.join(getTrashSkillsDir(), agent, version, skillName);
    const trashDest = path.join(trashDir, stamp);
    fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
    fs.renameSync(target, trashDest);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
  return { success: true };
}

export function iterSkillsCapableVersions(filter?: { agent?: AgentId; version?: string }): Array<{ agent: AgentId; version: string }> {
  const pairs: Array<{ agent: AgentId; version: string }> = [];
  const agents = filter?.agent ? [filter.agent] : capableAgents('skills');
  for (const agent of agents) {
    if (!capableAgents('skills').includes(agent)) continue;
    const versions = listInstalledVersions(agent);
    for (const version of versions) {
      if (filter?.version && filter.version !== version) continue;
      pairs.push({ agent, version });
    }
  }
  return pairs;
}

export function uninstallSkill(skillName: string): { success: boolean; error?: string } {
  const centralPath = path.join(getSkillsDir(), skillName);
  if (!fs.existsSync(centralPath)) {
    return { success: false, error: `Skill '${skillName}' not found` };
  }

  for (const agentId of capableAgents('skills')) {
    const agentSkillPath = path.join(getAgentSkillsDir(agentId), skillName);
    if (fs.existsSync(agentSkillPath)) {
      try {
        fs.rmSync(agentSkillPath, { recursive: true, force: true });
      } catch {
      }
    }
  }

  try {
    fs.rmSync(centralPath, { recursive: true, force: true });
  } catch {
  }

  emit('skill.remove', { skill: skillName });
  return { success: true };
}

export function listInstalledSkills(): Map<string, DiscoveredSkill> {
  const skills = new Map<string, DiscoveredSkill>();
  const scan = (dir: string, source?: string) => {
    if (!fs.existsSync(dir)) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        if (skills.has(entry.name)) continue;

        const skillDir = path.join(dir, entry.name);
        const metadata = parseSkillMetadata(skillDir);
        const validation = validateSkillMetadata(metadata, entry.name);
        if (metadata) {
          skills.set(entry.name, {
            name: entry.name,
            path: skillDir,
            metadata,
            ruleCount: countSkillRules(skillDir),
            validation,
            source,
          });
        }
      }
    } catch {
    }
  };

  scan(getSkillsDir());
  for (const extra of getEnabledExtraRepos()) {
    scan(path.join(extra.dir, 'skills'), extra.alias);
  }

  return skills;
}

export function listInstalledSkillsWithScope(
  agentId: AgentId,
  cwd: string = process.cwd(),
  options?: { home?: string; errors?: SkillParseError[] }
): InstalledSkill[] {
  const results: InstalledSkill[] = [];
  const seen = new Set<string>();

  const projectCandidates: string[] = [];
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (projectAgentsDir) {
    projectCandidates.push(path.join(projectAgentsDir, 'skills'));
  }
  projectCandidates.push(path.join(cwd, `.${agentId}`, 'skills'));

  for (const projectSkillsDir of projectCandidates) {
    if (!fs.existsSync(projectSkillsDir)) continue;
    try {
      const entries = fs.readdirSync(projectSkillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;

        const skillDir = path.join(projectSkillsDir, entry.name);

        let isDir = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try {
            const stat = fs.statSync(skillDir);
            isDir = stat.isDirectory();
          } catch {
            continue;
          }
        }
        if (!isDir) continue;

        const result = tryParseSkillMetadata(skillDir);

        if (result.metadata && !seen.has(entry.name)) {
          results.push({
            name: entry.name,
            path: skillDir,
            metadata: result.metadata,
            ruleCount: countSkillRules(skillDir),
            scope: 'project',
            agent: agentId,
          });
          seen.add(entry.name);
        } else if (result.error && options?.errors && !seen.has(entry.name)) {
          options.errors.push({
            name: entry.name,
            path: skillDir,
            error: result.error,
            scope: 'project',
          });
          seen.add(entry.name);
        }
      }
    } catch {
    }
  }

  const userSkillsDir = options?.home
    ? path.join(options.home, agentConfigDirName(agentId), 'skills')
    : getAgentSkillsDir(agentId);
  if (fs.existsSync(userSkillsDir)) {
    try {
      const entries = fs.readdirSync(userSkillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;

        const skillDir = path.join(userSkillsDir, entry.name);

        let isDir = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try {
            const stat = fs.statSync(skillDir);
            isDir = stat.isDirectory();
          } catch {
            continue;
          }
        }
        if (!isDir) continue;

        const result = tryParseSkillMetadata(skillDir);

        if (result.metadata && !seen.has(entry.name)) {
          results.push({
            name: entry.name,
            path: skillDir,
            metadata: result.metadata,
            ruleCount: countSkillRules(skillDir),
            scope: 'user',
            agent: agentId,
          });
          seen.add(entry.name);
        } else if (result.error && options?.errors && !seen.has(entry.name)) {
          options.errors.push({
            name: entry.name,
            path: skillDir,
            error: result.error,
            scope: 'user',
          });
          seen.add(entry.name);
        }
      }
    } catch {
    }
  }

  return results;
}

export function getSkillInfo(skillName: string): DiscoveredSkill | null {
  const sourcePath = resolveSkillSourcePath(skillName);
  if (!sourcePath) {
    return null;
  }

  const metadata = parseSkillMetadata(sourcePath);
  const validation = validateSkillMetadata(metadata, skillName);
  if (!metadata) {
    return null;
  }

  return {
    name: skillName,
    path: sourcePath,
    metadata,
    ruleCount: countSkillRules(sourcePath),
    validation,
  };
}

export function getSkillRules(skillName: string): string[] {
  const sourcePath = resolveSkillSourcePath(skillName);
  if (!sourcePath) {
    return [];
  }
  const rulesDir = path.join(sourcePath, 'rules');

  if (!fs.existsSync(rulesDir)) {
    return [];
  }

  try {
    const files = fs.readdirSync(rulesDir);
    return files.filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}

export function installSkillCentrally(
  sourcePath: string,
  skillName: string
): { success: boolean; error?: string; warnings?: string[] } {
  const metadata = parseSkillMetadata(sourcePath);
  const validation = validateSkillMetadata(metadata, skillName);
  const allWarnings = [...validation.warnings];

  if (!validation.valid) {
    allWarnings.push(...validation.errors.map(e => `Validation: ${e}`));
  }

  ensureCentralSkillsDir();
  const centralPath = path.join(getSkillsDir(), skillName);

  const resolvedSource = path.resolve(sourcePath);
  const resolvedCentral = path.resolve(centralPath);

  if (resolvedSource === resolvedCentral) {
    return { success: true, warnings: allWarnings.length > 0 ? allWarnings : undefined };
  }

  if (fs.existsSync(centralPath)) {
    try {
      fs.rmSync(centralPath, { recursive: true, force: true });
    } catch {
    }
  }

  try {
    fs.cpSync(sourcePath, centralPath, { recursive: true });
    return { success: true, warnings: allWarnings.length > 0 ? allWarnings : undefined };
  } catch (err) {
    return { success: false, error: `Failed to copy skill: ${(err as Error).message}` };
  }
}
