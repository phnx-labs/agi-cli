/**
 * Slash command management -- discovery, installation, and syncing.
 *
 * Commands are markdown files in ~/.agents/commands/ exposed as `/command-name`
 * shortcuts by agents. This module discovers them, converts between formats
 * (markdown for Claude/Codex, TOML for Gemini), and installs them into
 * agent version homes.
 */

import * as fs from 'fs';
import { compareVersions } from './agent-spec/primitives.js';
import { installedReleaseFor } from './installations/store.js';
import * as path from 'path';
import * as yaml from 'yaml';
import { AGENTS, ensureCommandsDir, agentConfigDirName, resolveAgentName } from './agents.js';
import { capableAgents, isCapable, supports } from './capabilities.js';
import { isDirectoryDoc } from './resources.js';
import { normalizeAliases } from './resource-aliases.js';
import { markdownToToml } from './convert.js';
import { getCommandsDir, getUserCommandsDir, getEnabledExtraRepos, getProjectAgentsDir, getSkillsDir, getTrashCommandsDir } from './state.js';
import { getEffectiveHome, getVersionHomePath, listInstalledVersions, resolveVersion } from './installations/versions.js';
import { discoverPlugins } from './plugins/plugins.js';
import type { AgentId, CommandInstallation } from './types.js';
import {
  commandSkillMatches,
  installCommandSkillToVersion,
  listCommandSkillsInVersion,
  removeCommandSkillFromVersion,
  shouldAlsoInstallCommandAsSkill,
  shouldInstallCommandAsSkill,
} from './command-skills.js';
import {
  installGooseCommandToVersion,
  listGooseCommandsInVersion,
  gooseCommandMatches,
  removeGooseCommandFromVersion,
} from './goose-commands.js';

/** Scope of a command: user-global or project-local. */
type CommandScope = 'user' | 'project';

/** Parsed metadata from a command file's YAML frontmatter. */
interface CommandMetadata {
  name: string;
  description: string;
  /** When set, sync only to these agents (aliases resolved at parse time). */
  agents?: AgentId[];
  /** Minimum agent CLI version (inclusive) for this command. */
  since?: string;
  /** Exclusive upper bound on agent CLI version for this command. */
  until?: string;
  /** Alternate names this command also resolves under (frontmatter `aliases:`). */
  aliases?: string[];
}

type CommandApplyFailReason = 'unsupported' | 'agent_excluded' | 'too_old' | 'too_new';

type CommandApplyResult =
  | { ok: true }
  | { ok: false; reason: CommandApplyFailReason; need?: string };

function parseAgentsField(raw: unknown): AgentId[] | undefined {
  if (raw == null) return undefined;
  const tokens = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,\s]+/)
      : [];
  const out: AgentId[] = [];
  for (const token of tokens) {
    const id = resolveAgentName(String(token).trim());
    if (id && !out.includes(id)) out.push(id);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Whether a slash command should sync to the given agent@version. Checks
 * frontmatter `agents` / `since` / `until` after the agent-level commands
 * (or commands-as-skills) capability gate.
 */
export function commandAppliesTo(
  agent: AgentId,
  version: string,
  metadata: Pick<CommandMetadata, 'agents' | 'since' | 'until'> | null | undefined
): CommandApplyResult {
  if (!supports(agent, 'commands', version).ok && !shouldInstallCommandAsSkill(agent, version)) {
    return { ok: false, reason: 'unsupported' };
  }

  if (metadata?.agents?.length && !metadata.agents.includes(agent)) {
    return { ok: false, reason: 'agent_excluded' };
  }

  version = installedReleaseFor(agent, version);

  if (metadata?.since && compareVersions(version, metadata.since) < 0) {
    return { ok: false, reason: 'too_old', need: `>= ${metadata.since}` };
  }

  if (metadata?.until && compareVersions(version, metadata.until) >= 0) {
    return { ok: false, reason: 'too_new', need: `< ${metadata.until}` };
  }

  return { ok: true };
}

function explainCommandSkip(
  agent: AgentId,
  version: string,
  commandName: string,
  result: CommandApplyResult
): string {
  if (result.ok) return '';
  const tag = `${agent}@${version}`;
  switch (result.reason) {
    case 'unsupported':
      return `${tag}: /${commandName} not supported for this agent version`;
    case 'agent_excluded':
      return `${tag}: /${commandName} excluded by command frontmatter agents list`;
    case 'too_old':
      return `${tag}: /${commandName} requires ${result.need}`;
    case 'too_new':
      return `${tag}: /${commandName} requires ${result.need}`;
    default:
      return `${tag}: /${commandName} skipped`;
  }
}

/** Result of validating command metadata. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** A command discovered in a repository's commands/ directory. */
interface DiscoveredCommand {
  name: string;
  description: string;
  sourcePath: string;
  isShared: boolean;
  validation: ValidationResult;
}

/** A command installed in an agent's config directory. */
interface InstalledCommand {
  name: string;
  scope: CommandScope;
  path: string;
  description?: string;
}

/** Parse command metadata (name, description, targeting) from YAML frontmatter or TOML headers. */
export function parseCommandMetadata(filePath: string): CommandMetadata | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Check for YAML frontmatter
    if (lines[0] === '---') {
      const endIndex = lines.slice(1).findIndex((l) => l === '---');
      if (endIndex > 0) {
        const frontmatter = lines.slice(1, endIndex + 1).join('\n');
        const parsed = yaml.parse(frontmatter);
        return {
          name: parsed.name || '',
          description: parsed.description || '',
          agents: parseAgentsField(parsed.agents),
          since: typeof parsed.since === 'string' ? parsed.since : undefined,
          until: typeof parsed.until === 'string' ? parsed.until : undefined,
          aliases: normalizeAliases(parsed.aliases),
        };
      }
    }

    // Check for TOML format
    const tomlNameMatch = content.match(/name\s*=\s*"([^"]+)"/);
    const tomlDescMatch = content.match(/description\s*=\s*"([^"]+)"/);
    if (tomlNameMatch || tomlDescMatch) {
      return {
        name: tomlNameMatch?.[1] || '',
        description: tomlDescMatch?.[1] || '',
      };
    }

    // No valid frontmatter found
    return null;
  } catch {
    return null;
  }
}

/** Validate command metadata, returning errors and warnings. */
function validateCommandMetadata(
  metadata: CommandMetadata | null,
  commandName: string
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!metadata) {
    errors.push('Missing YAML frontmatter with name and description');
    return { valid: false, errors, warnings };
  }

  // name is optional - if not provided, will use filename (commandName)
  // Only validate length if name is explicitly provided
  if (metadata.name && metadata.name.length > 64) {
    warnings.push(`name exceeds 64 characters (${metadata.name.length})`);
  }

  // description is required
  if (!metadata.description || metadata.description.trim() === '') {
    errors.push('Missing required field: description');
  } else if (metadata.description.length > 1024) {
    warnings.push(`description exceeds 1024 characters (${metadata.description.length})`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Discover all command markdown files in a repository's commands/ directory. */
export function discoverCommands(repoPath: string): DiscoveredCommand[] {
  const commands: DiscoveredCommand[] = [];

  const commandsDir = path.join(repoPath, 'commands');
  if (fs.existsSync(commandsDir)) {
    for (const file of fs.readdirSync(commandsDir)) {
      if (file.endsWith('.md')) {
        const name = file.replace('.md', '');
        if (isDirectoryDoc('commands', name)) continue;
        const sourcePath = path.join(commandsDir, file);
        const metadata = parseCommandMetadata(sourcePath);
        const validation = validateCommandMetadata(metadata, name);
        commands.push({
          name,
          description: metadata?.description || extractDescription(fs.readFileSync(sourcePath, 'utf-8')),
          sourcePath,
          isShared: true,
          validation,
        });
      }
    }
  }

  return commands;
}

function extractDescription(content: string): string {
  const match = content.match(/description:\s*(.+)/i);
  if (match) return match[1].trim();

  const tomlMatch = content.match(/description\s*=\s*"([^"]+)"/);
  if (tomlMatch) return tomlMatch[1];

  const firstLine = content.split('\n').find((l) => l.trim() && !l.startsWith('---'));
  return firstLine?.slice(0, 80) || '';
}

/** Find the source path for a command in a repository. */
export function resolveCommandSource(
  repoPath: string,
  commandName: string
): string | null {
  const commandPath = path.join(repoPath, 'commands', `${commandName}.md`);
  if (fs.existsSync(commandPath)) {
    return commandPath;
  }

  return null;
}

/** Install a command into an agent's config directory, with optional format conversion. */
export function installCommand(
  sourcePath: string,
  agentId: AgentId,
  commandName: string,
  method: 'symlink' | 'copy' = 'symlink'
): CommandInstallation & { error?: string; warnings?: string[] } {
  // Validate command metadata before installation
  const metadata = parseCommandMetadata(sourcePath);
  const validation = validateCommandMetadata(metadata, commandName);

  if (!validation.valid) {
    return {
      path: '',
      method: 'copy',
      error: `Invalid command: ${validation.errors.join(', ')}`,
      warnings: validation.warnings,
    };
  }

  const pinnedVersion = resolveVersion(agentId, process.cwd());
  if (pinnedVersion) {
    const gate = commandAppliesTo(agentId, pinnedVersion, metadata);
    if (!gate.ok) {
      return {
        path: '',
        method: 'copy',
        error: explainCommandSkip(agentId, pinnedVersion, commandName, gate),
        warnings: validation.warnings,
      };
    }
  }

  const agent = AGENTS[agentId];
  ensureCommandsDir(agentId);

  const home = getEffectiveHome(agentId);
  const installVersion = pinnedVersion ?? listInstalledVersions(agentId)[0] ?? '';
  const alsoInstallAsSkill = shouldAlsoInstallCommandAsSkill(agentId, installVersion);

  if (alsoInstallAsSkill) {
    const installed = installCommandSkillToVersion(
      path.join(home, agentConfigDirName(agentId)),
      commandName,
      sourcePath,
      [getSkillsDir(), ...getEnabledExtraRepos().map((repo) => path.join(repo.dir, 'skills'))],
    );
    if (!installed.success) {
      return { path: '', method: 'copy', error: installed.error, warnings: validation.warnings };
    }
  }

  // Goose: a slash command is a recipe YAML registered in config.yaml, not a
  // native command file under commandsSubdir.
  if (agentId === 'goose') {
    const result = installGooseCommandToVersion(home, commandName, sourcePath);
    if (!result.success) {
      return { path: '', method: 'copy', error: result.error, warnings: validation.warnings };
    }
    return {
      path: path.join(home, '.config', 'goose', 'commands', `${commandName}.yaml`),
      method: 'copy',
      warnings: validation.warnings,
    };
  }

  const commandsDir = path.join(home, agentConfigDirName(agentId), agent.commandsSubdir);
  fs.mkdirSync(commandsDir, { recursive: true });

  const ext = agent.format === 'toml' ? '.toml' : '.md';
  const targetPath = path.join(commandsDir, `${commandName}${ext}`);

  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
  }

  const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
  const sourceIsMarkdown = sourcePath.endsWith('.md');
  const needsConversion = agent.format === 'toml' && sourceIsMarkdown;

  if (needsConversion) {
    const tomlContent = markdownToToml(commandName, sourceContent);
    fs.writeFileSync(targetPath, tomlContent, 'utf-8');
    return { path: targetPath, method: 'copy', warnings: validation.warnings };
  }

  if (method === 'symlink') {
    fs.symlinkSync(sourcePath, targetPath);
    return { path: targetPath, method: 'symlink', warnings: validation.warnings };
  }

  fs.copyFileSync(sourcePath, targetPath);
  return { path: targetPath, method: 'copy', warnings: validation.warnings };
}

/**
 * Path to the commands dir of a specific version home (not the active one).
 * Respects per-agent commandsSubdir (e.g. 'prompts' for codex).
 */
export function getVersionCommandsDir(agent: AgentId, version: string): string {
  const home = getVersionHomePath(agent, version);
  return path.join(home, agentConfigDirName(agent), AGENTS[agent].commandsSubdir);
}

/**
 * List command names (without extension) installed in a specific version home.
 */
export function listCommandsInVersionHome(agent: AgentId, version: string): string[] {
  const versionHome = getVersionHomePath(agent, version);
  const agentDir = path.join(versionHome, agentConfigDirName(agent));
  if (shouldInstallCommandAsSkill(agent, version)) {
    return listCommandSkillsInVersion(agentDir);
  }
  if (agent === 'goose') {
    return listGooseCommandsInVersion(versionHome);
  }

  const dir = getVersionCommandsDir(agent, version);
  if (!fs.existsSync(dir)) return [];
  const ext = AGENTS[agent].format === 'toml' ? '.toml' : '.md';
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => f.slice(0, -ext.length))
    .sort();
}

/**
 * Check if a command installed in a specific version matches the central source.
 * Handles markdown-to-TOML conversion for Gemini.
 */
function versionCommandMatches(agent: AgentId, version: string, commandName: string): boolean {
  const sourcePath = path.join(getCommandsDir(), `${commandName}.md`);
  if (!fs.existsSync(sourcePath)) return false;

  const versionHome = getVersionHomePath(agent, version);
  const agentDir = path.join(versionHome, agentConfigDirName(agent));
  if (shouldInstallCommandAsSkill(agent, version)) {
    return commandSkillMatches(agentDir, commandName, sourcePath);
  }
  if (agent === 'goose') {
    return gooseCommandMatches(versionHome, commandName, sourcePath);
  }

  const agentConfig = AGENTS[agent];
  const ext = agentConfig.format === 'toml' ? '.toml' : '.md';
  const installedPath = path.join(getVersionCommandsDir(agent, version), `${commandName}${ext}`);
  if (!fs.existsSync(installedPath)) return false;

  try {
    const installedContent = fs.readFileSync(installedPath, 'utf-8');
    const sourceContent = fs.readFileSync(sourcePath, 'utf-8');

    if (agentConfig.format === 'toml') {
      const convertedSource = markdownToToml(commandName, sourceContent);
      return normalizeContent(installedContent) === normalizeContent(convertedSource);
    }
    return normalizeContent(installedContent) === normalizeContent(sourceContent);
  } catch {
    return false;
  }
}

export interface VersionCommandDiff {
  agent: AgentId;
  version: string;
  toAdd: string[];
  toUpdate: string[];
  matched: string[];
  /** Installed but excluded by frontmatter agents/since/until — safe to remove. */
  toRemove: string[];
  orphans: string[];
}

/**
 * Compare a version home's commands against central. Returns the reconciliation diff.
 */
/**
 * Flattened names of plugin-bundled commands (`<plugin>-<command>`), matching
 * exactly how `syncPluginToVersion` installs a plugin's `commands/<cmd>.md` as a
 * command-skill (plugins.ts → `installCommandSkillToVersion(agentDir,
 * `${plugin.name}-${cmd}`, …)`). These are source-managed by their plugin, so
 * the orphan detector must NOT flag them — else `prune cleanup` proposes
 * deleting live plugin commands (swarm-plan, code-review, …). Scans user +
 * system + extra marketplaces (no project layer), matching the trusted sources.
 */
export function listPluginCommandNames(): Set<string> {
  const names = new Set<string>();
  for (const plugin of discoverPlugins()) {
    for (const cmd of plugin.commands) names.add(`${plugin.name}-${cmd}`);
  }
  return names;
}

export function diffVersionCommands(agent: AgentId, version: string): VersionCommandDiff {
  const central = new Set(listCentralCommands());
  const pluginCommands = listPluginCommandNames();
  const installed = new Set(listCommandsInVersionHome(agent, version));

  const toAdd: string[] = [];
  const toUpdate: string[] = [];
  const matched: string[] = [];
  const toRemove: string[] = [];
  const orphans: string[] = [];

  for (const name of central) {
    const sourcePath = path.join(getCommandsDir(), `${name}.md`);
    const metadata = parseCommandMetadata(sourcePath);
    if (!commandAppliesTo(agent, version, metadata).ok) continue;

    if (!installed.has(name)) {
      toAdd.push(name);
    } else if (!versionCommandMatches(agent, version, name)) {
      toUpdate.push(name);
    } else {
      matched.push(name);
    }
  }

  for (const name of installed) {
    if (central.has(name)) {
      const sourcePath = path.join(getCommandsDir(), `${name}.md`);
      const metadata = parseCommandMetadata(sourcePath);
      if (!commandAppliesTo(agent, version, metadata).ok) {
        toRemove.push(name);
      }
      continue;
    }
    // A plugin-bundled command (installed as `<plugin>-<cmd>`) is source-managed
    // by its plugin — not an orphan. Only a name with no central AND no plugin
    // source is genuinely unmanaged.
    if (pluginCommands.has(name)) continue;
    orphans.push(name);
  }

  return {
    agent,
    version,
    toAdd: toAdd.sort(),
    toUpdate: toUpdate.sort(),
    matched,
    toRemove: toRemove.sort(),
    orphans: orphans.sort(),
  };
}

/**
 * Install a single command from central into a specific version home.
 * Handles markdown-to-TOML conversion when the agent requires it.
 */
export function installCommandToVersion(
  agent: AgentId,
  version: string,
  commandName: string,
  method: 'symlink' | 'copy' = 'copy'
): { success: boolean; error?: string; skipped?: boolean; skipReason?: string } {
  const sourcePath = path.join(getCommandsDir(), `${commandName}.md`);
  if (!fs.existsSync(sourcePath)) {
    return { success: false, error: `Command '${commandName}' not found in central` };
  }

  const metadata = parseCommandMetadata(sourcePath);
  const gate = commandAppliesTo(agent, version, metadata);
  if (!gate.ok) {
    return { success: true, skipped: true, skipReason: explainCommandSkip(agent, version, commandName, gate) };
  }

  const versionHome = getVersionHomePath(agent, version);
  const agentDir = path.join(versionHome, agentConfigDirName(agent));
  if (shouldInstallCommandAsSkill(agent, version)) {
    return installCommandSkillToVersion(
      agentDir,
      commandName,
      sourcePath,
      [
        getSkillsDir(),
        ...getEnabledExtraRepos().map((repo) => path.join(repo.dir, 'skills')),
      ]
    );
  }

  if (shouldAlsoInstallCommandAsSkill(agent, version)) {
    const installed = installCommandSkillToVersion(
      agentDir,
      commandName,
      sourcePath,
      [getSkillsDir(), ...getEnabledExtraRepos().map((repo) => path.join(repo.dir, 'skills'))],
    );
    if (!installed.success) return installed;
  }

  // Goose: a slash command is a recipe YAML registered in config.yaml, not a
  // native command file. Write the recipe + slash_commands entry.
  if (agent === 'goose') {
    return installGooseCommandToVersion(versionHome, commandName, sourcePath);
  }

  const agentConfig = AGENTS[agent];
  const commandsDir = getVersionCommandsDir(agent, version);
  fs.mkdirSync(commandsDir, { recursive: true });

  const ext = agentConfig.format === 'toml' ? '.toml' : '.md';
  const targetPath = path.join(commandsDir, `${commandName}${ext}`);

  try {
    if (fs.existsSync(targetPath) || fs.lstatSync(targetPath, { throwIfNoEntry: false })) {
      fs.unlinkSync(targetPath);
    }

    if (agentConfig.format === 'toml') {
      const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
      fs.writeFileSync(targetPath, markdownToToml(commandName, sourceContent), 'utf-8');
    } else if (method === 'symlink') {
      fs.symlinkSync(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
  return { success: true };
}

/**
 * Remove a single command from a specific version home.
 * Soft-deletes to ~/.agents/.trash/commands/.
 */
export function removeCommandFromVersion(
  agent: AgentId,
  version: string,
  commandName: string
): { success: boolean; error?: string } {
  const versionHome = getVersionHomePath(agent, version);
  const agentDir = path.join(versionHome, agentConfigDirName(agent));
  if (shouldInstallCommandAsSkill(agent, version)) {
    return removeCommandSkillFromVersion(agentDir, commandName);
  }
  if (shouldAlsoInstallCommandAsSkill(agent, version)) {
    const removed = removeCommandSkillFromVersion(agentDir, commandName);
    if (!removed.success) return removed;
  }
  if (agent === 'goose') {
    const trashDir = path.join(getTrashCommandsDir(), agent, version, commandName);
    return removeGooseCommandFromVersion(versionHome, commandName, trashDir);
  }

  const ext = AGENTS[agent].format === 'toml' ? '.toml' : '.md';
  const targetPath = path.join(getVersionCommandsDir(agent, version), `${commandName}${ext}`);
  if (!fs.existsSync(targetPath) && !fs.lstatSync(targetPath, { throwIfNoEntry: false })) {
    return { success: true };
  }
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const trashDir = path.join(getTrashCommandsDir(), agent, version, commandName);
    fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
    fs.renameSync(targetPath, path.join(trashDir, `${commandName}${ext}.${stamp}`));
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
  return { success: true };
}

/**
 * Iterate all (agent, version) pairs that support commands and are installed,
 * optionally scoped to a single agent/version.
 */
export function iterCommandsCapableVersions(filter?: { agent?: AgentId; version?: string }): Array<{ agent: AgentId; version: string }> {
  const pairs: Array<{ agent: AgentId; version: string }> = [];
  const agents = filter?.agent ? [filter.agent] : capableAgents('commands');
  for (const agent of agents) {
    if (!isCapable(agent, 'commands')) continue;
    const versions = listInstalledVersions(agent);
    for (const version of versions) {
      if (filter?.version && filter.version !== version) continue;
      pairs.push({ agent, version });
    }
  }
  return pairs;
}

/** Remove a command from an agent's config directory. */
export function uninstallCommand(agentId: AgentId, commandName: string): boolean {
  const agent = AGENTS[agentId];
  const home = getEffectiveHome(agentId);
  const commandsDir = path.join(home, agentConfigDirName(agentId), agent.commandsSubdir);
  const ext = agent.format === 'toml' ? '.toml' : '.md';
  const targetPath = path.join(commandsDir, `${commandName}${ext}`);

  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
    return true;
  }
  return false;
}

/** List command names installed for an agent in the active version home. */
function listInstalledCommands(agentId: AgentId): string[] {
  const agent = AGENTS[agentId];
  const home = getEffectiveHome(agentId);
  const commandsDir = path.join(home, agentConfigDirName(agentId), agent.commandsSubdir);
  if (!fs.existsSync(commandsDir)) {
    return [];
  }

  const ext = agent.format === 'toml' ? '.toml' : '.md';
  return fs
    .readdirSync(commandsDir)
    .filter((f) => f.endsWith(ext))
    .map((f) => f.replace(ext, ''));
}

/**
 * Check if a command exists for an agent.
 */
function commandExists(agentId: AgentId, commandName: string): boolean {
  const agent = AGENTS[agentId];
  const home = getEffectiveHome(agentId);
  const commandsDir = path.join(home, agentConfigDirName(agentId), agent.commandsSubdir);
  const ext = agent.format === 'toml' ? '.toml' : '.md';
  const targetPath = path.join(commandsDir, `${commandName}${ext}`);
  return fs.existsSync(targetPath);
}

/**
 * Normalize content for comparison (trim, normalize line endings).
 */
function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

/**
 * Check if installed command content matches source content.
 * Handles format conversion (markdown to TOML for Gemini).
 */
function commandContentMatches(
  agentId: AgentId,
  commandName: string,
  sourcePath: string
): boolean {
  const agent = AGENTS[agentId];
  const home = getEffectiveHome(agentId);
  const commandsDir = path.join(home, agentConfigDirName(agentId), agent.commandsSubdir);
  const ext = agent.format === 'toml' ? '.toml' : '.md';
  const installedPath = path.join(commandsDir, `${commandName}${ext}`);

  if (!fs.existsSync(installedPath) || !fs.existsSync(sourcePath)) {
    return false;
  }

  try {
    const installedContent = fs.readFileSync(installedPath, 'utf-8');
    const sourceContent = fs.readFileSync(sourcePath, 'utf-8');

    const sourceIsMarkdown = sourcePath.endsWith('.md');
    const needsConversion = agent.format === 'toml' && sourceIsMarkdown;

    if (needsConversion) {
      const convertedSource = markdownToToml(commandName, sourceContent);
      return normalizeContent(installedContent) === normalizeContent(convertedSource);
    }

    return normalizeContent(installedContent) === normalizeContent(sourceContent);
  } catch {
    return false;
  }
}

/**
 * Get the project-scoped commands directory for an agent.
 * Claude: .claude/commands/
 * Codex: .codex/prompts/
 * Cursor: .cursor/commands/
 */
function getProjectCommandsDirs(agentId: AgentId, cwd: string = process.cwd()): string[] {
  const agent = AGENTS[agentId];
  const dirs: string[] = [];

  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (projectAgentsDir) {
    dirs.push(path.join(projectAgentsDir, 'commands'));
  }

  dirs.push(path.join(cwd, `.${agentId}`, agent.commandsSubdir));
  return dirs;
}

/**
 * List commands from a specific directory.
 */
function listCommandsFromDir(dir: string, exts: string[]): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((f) => exts.some(ext => f.endsWith(ext)))
    .map((f) => f.replace(/\.(md|toml)$/, ''));
}

/**
 * List installed commands with scope information.
 * Pass options.home to read from a version-managed agent's home directory.
 */
export function listInstalledCommandsWithScope(
  agentId: AgentId,
  cwd: string = process.cwd(),
  options?: { home?: string }
): InstalledCommand[] {
  const agent = AGENTS[agentId];
  const ext = agent.format === 'toml' ? '.toml' : '.md';
  const results: InstalledCommand[] = [];
  const seen = new Set<string>();

  const addCommand = (name: string, scope: CommandScope, dir: string, extensions: string[]) => {
    if (seen.has(name)) return;
    const extForPath = extensions.find(e => fs.existsSync(path.join(dir, `${name}${e}`))) || extensions[0];
    const commandPath = path.join(dir, `${name}${extForPath}`);
    results.push({
      name,
      scope,
      path: commandPath,
      description: getCommandDescription(commandPath),
    });
    seen.add(name);
  };

  // Project-scoped commands (new .agents/commands takes precedence over agent-specific project dirs)
  const projectDirs = getProjectCommandsDirs(agentId, cwd);
  for (const projectDir of projectDirs) {
    const projectExts = ['.md', '.toml'];
    const projectCommands = listCommandsFromDir(projectDir, projectExts);
    for (const name of projectCommands) {
      addCommand(name, 'project', projectDir, projectExts);
    }
  }

  // User-scoped commands (version-aware when home is provided)
  const home = options?.home || getEffectiveHome(agentId);
  const userCommandsDir = path.join(home, agentConfigDirName(agentId), agent.commandsSubdir);
  const userExts = [ext];
  const userCommands = listCommandsFromDir(userCommandsDir, userExts);
  for (const name of userCommands) {
    addCommand(name, 'user', userCommandsDir, userExts);
  }

  return results;
}

/**
 * Get command description from file.
 */
function getCommandDescription(filePath: string): string | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return extractDescription(content) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Install a command to central ~/.agents/commands/ directory.
 * Shims will symlink this to per-agent directories for synced agents.
 */
export function installCommandCentrally(
  sourcePath: string,
  commandName: string
): { success: boolean; path: string; error?: string; warnings?: string[] } {
  // Validate command metadata before installation
  const metadata = parseCommandMetadata(sourcePath);
  const validation = validateCommandMetadata(metadata, commandName);

  if (!validation.valid) {
    return {
      success: false,
      path: '',
      error: `Invalid command: ${validation.errors.join(', ')}`,
      warnings: validation.warnings,
    };
  }

  const centralDir = getUserCommandsDir();
  if (!fs.existsSync(centralDir)) {
    fs.mkdirSync(centralDir, { recursive: true });
  }

  // Always use markdown for central storage
  const targetPath = path.join(centralDir, `${commandName}.md`);

  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
  }

  try {
    fs.copyFileSync(sourcePath, targetPath);
    return { success: true, path: targetPath, warnings: validation.warnings };
  } catch (err) {
    return { success: false, path: '', error: (err as Error).message };
  }
}

/**
 * List commands from user (~/.agents/commands/) and system (~/.agents/.system/commands/) dirs.
 * User dir takes priority; deduplication preserves first occurrence.
 */
export function listCentralCommands(): string[] {
  const seen = new Set<string>();
  for (const dir of [getUserCommandsDir(), getCommandsDir()]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const name = f.replace('.md', '');
      // A directory's README/AGENTS/CLAUDE/GEMINI documents the dir, it is not a
      // command. Without this the picker offers a name resolveResource refuses.
      if (isDirectoryDoc('commands', name)) continue;
      seen.add(name);
    }
  }
  return Array.from(seen);
}

/**
 * Get detailed info about a command from central storage.
 */
export function getCommandInfo(name: string): {
  name: string;
  description: string;
  path: string;
  content: string;
} | null {
  const centralDir = getCommandsDir();
  const cmdPath = path.join(centralDir, `${name}.md`);

  if (!fs.existsSync(cmdPath)) {
    return null;
  }

  const content = fs.readFileSync(cmdPath, 'utf-8');
  const metadata = parseCommandMetadata(cmdPath);

  return {
    name,
    description: metadata?.description || '',
    path: cmdPath,
    content,
  };
}
