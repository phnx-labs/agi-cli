/**
 * Subagent management -- discovery, installation, and format conversion.
 *
 * Subagents are named agent definitions in ~/.agents/subagents/, each a directory
 * with an agent.md file (frontmatter + instructions). This module discovers them,
 * transforms them into agent-native formats (Claude .mdc, OpenClaw YAML),
 * and syncs them into version homes.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { capableAgents } from './capabilities.js';
import { getSubagentsDir, getUserSubagentsDir, getTrashSubagentsDir } from './state.js';
import { listInstalledVersions, getVersionHomePath } from './installations/versions.js';
import { safeJoin } from './paths.js';
import {
  subagentTarget,
  writeSubagentToHome,
  listInstalledSubagentNames,
  listInstalledSubagentsRich,
  removeSubagentFromHome,
  trashSubagentFromHome,
  copyDirWithRename,
} from './subagents-registry.js';
import type { AgentId, DiscoveredSubagent, InstalledSubagent, SubagentFrontmatter } from './types.js';

/**
 * Parse AGENT.md frontmatter to extract subagent metadata
 */
export function parseSubagentFrontmatter(filePath: string): SubagentFrontmatter | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // Split on CRLF or LF: git checks text files out with CRLF on Windows
    // (core.autocrlf), so a plain split('\n') leaves a trailing '\r' on every
    // line and the frontmatter fence `'---\r' !== '---'` never matches —
    // silently dropping the subagent from discovery so it can never be
    // installed or reconciled (PHNX-3187).
    const lines = content.split(/\r?\n/);

    // Check for YAML frontmatter
    if (lines[0] === '---') {
      const endIndex = lines.slice(1).findIndex((l) => l === '---');
      if (endIndex > 0) {
        const frontmatter = lines.slice(1, endIndex + 1).join('\n');
        const parsed = yaml.parse(frontmatter);
        return {
          name: parsed.name || '',
          description: parsed.description || '',
          model: parsed.model,
          color: parsed.color,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get the body content of AGENT.md (everything after frontmatter)
 */
export function getSubagentBody(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return '';
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  // CRLF-robust for the same reason as parseSubagentFrontmatter (PHNX-3187).
  const lines = content.split(/\r?\n/);

  // Skip YAML frontmatter
  if (lines[0] === '---') {
    const endIndex = lines.slice(1).findIndex((l) => l === '---');
    if (endIndex > 0) {
      return lines.slice(endIndex + 2).join('\n').trim();
    }
  }

  return content;
}

/**
 * Discover subagents from a repository
 * Looks for subagents/{name}/AGENT.md
 */
export function discoverSubagentsFromRepo(repoPath: string): DiscoveredSubagent[] {
  const subagents: DiscoveredSubagent[] = [];
  const subagentsDir = path.join(repoPath, 'subagents');

  if (!fs.existsSync(subagentsDir)) {
    return subagents;
  }

  for (const dir of fs.readdirSync(subagentsDir)) {
    const dirPath = path.join(subagentsDir, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const agentMd = path.join(dirPath, 'AGENT.md');
    if (!fs.existsSync(agentMd)) {
      // Skip directories without AGENT.md
      continue;
    }

    const frontmatter = parseSubagentFrontmatter(agentMd);
    if (!frontmatter) {
      console.warn(`Warning: ${agentMd} has invalid frontmatter, skipping`);
      continue;
    }

    // Collect all .md files in the directory
    const files = fs.readdirSync(dirPath)
      .filter(f => f.endsWith('.md'))
      .sort();

    subagents.push({
      name: dir, // Use directory name as canonical name
      path: dirPath,
      files,
      agentMd,
      frontmatter,
    });
  }

  return subagents;
}

/**
 * List installed subagents from ~/.agents/subagents/
 */
export function listInstalledSubagents(): InstalledSubagent[] {
  const seen = new Set<string>();
  const subagents: InstalledSubagent[] = [];

  // User dir first (wins on name collision), then system
  for (const subagentsDir of [getUserSubagentsDir(), getSubagentsDir()]) {
    if (!fs.existsSync(subagentsDir)) continue;

  for (const dir of fs.readdirSync(subagentsDir)) {
    const dirPath = path.join(subagentsDir, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const agentMd = path.join(dirPath, 'AGENT.md');
    if (!fs.existsSync(agentMd)) continue;

    const frontmatter = parseSubagentFrontmatter(agentMd);
    if (!frontmatter) continue;

    if (seen.has(dir)) continue;
    seen.add(dir);

    const files = fs.readdirSync(dirPath)
      .filter(f => f.endsWith('.md'))
      .sort();

    subagents.push({
      name: dir,
      path: dirPath,
      files,
      frontmatter,
    });
  }
  }

  return subagents;
}

/**
 * Get a specific installed subagent
 */
export function getInstalledSubagent(name: string): InstalledSubagent | null {
  // Check user dir first, then system
  for (const subagentsDir of [getUserSubagentsDir(), getSubagentsDir()]) {
    const dirPath = path.join(subagentsDir, name);
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) continue;
    const agentMd = path.join(dirPath, 'AGENT.md');
    if (!fs.existsSync(agentMd)) continue;
    const frontmatter = parseSubagentFrontmatter(agentMd);
    if (!frontmatter) continue;
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md')).sort();
    return { name, path: dirPath, files, frontmatter };
  }
  return null;
}

/**
 * Install a subagent centrally to ~/.agents/subagents/{name}/
 */
export function installSubagentCentrally(
  sourcePath: string,
  name: string
): { success: boolean; error?: string } {
  const subagentsDir = getUserSubagentsDir();
  const targetDir = safeJoin(subagentsDir, name);

  try {
    // Ensure subagents directory exists
    if (!fs.existsSync(subagentsDir)) {
      fs.mkdirSync(subagentsDir, { recursive: true });
    }

    // Remove existing if present
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true });
    }

    // Copy entire directory
    fs.cpSync(sourcePath, targetDir, { recursive: true });

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Remove an installed subagent
 */
export function removeSubagent(name: string): { success: boolean; error?: string } {
  for (const subagentsDir of [getUserSubagentsDir(), getSubagentsDir()]) {
    const candidate = safeJoin(subagentsDir, name);
    if (fs.existsSync(candidate)) {
      try {
        fs.rmSync(candidate, { recursive: true });
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
  }
  return { success: false, error: `Subagent '${name}' not found` };
}

/**
 * Transform a subagent directory into a single .md file for Claude
 * Combines AGENT.md frontmatter + body with other files as sections
 */
export function transformSubagentForClaude(subagentDir: string): string {
  const agentMd = path.join(subagentDir, 'AGENT.md');
  const frontmatter = parseSubagentFrontmatter(agentMd);
  const body = getSubagentBody(agentMd);

  if (!frontmatter) {
    throw new Error(`Invalid AGENT.md in ${subagentDir}`);
  }

  // Build the frontmatter section
  const frontmatterYaml = yaml.stringify({
    name: frontmatter.name,
    description: frontmatter.description,
    ...(frontmatter.model && { model: frontmatter.model }),
    ...(frontmatter.color && { color: frontmatter.color }),
  }).trim();

  let result = `---\n${frontmatterYaml}\n---\n\n${body}`;

  // Append other .md files as sections
  const files = fs.readdirSync(subagentDir)
    .filter(f => f.endsWith('.md') && f !== 'AGENT.md')
    .sort();

  for (const file of files) {
    const filePath = path.join(subagentDir, file);
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    const sectionName = file.replace('.md', '');
    // Convert filename to title case (SOUL.md -> Soul)
    const title = sectionName.charAt(0).toUpperCase() + sectionName.slice(1).toLowerCase();
    result += `\n\n## ${title}\n\n${content}`;
  }

  return result;
}

/**
 * Transform a subagent into a Factory AI Droid "custom droid" .md file.
 *
 * Mirrors transformSubagentForClaude (flatten frontmatter + body + appended
 * .md sections), but emits only frontmatter keys Factory recognizes
 * (name, description, model). Factory has no `color` field, so it is dropped.
 * See https://docs.factory.ai/cli/configuration/custom-droids.
 */
export function transformSubagentForDroid(subagentDir: string): string {
  const agentMd = path.join(subagentDir, 'AGENT.md');
  const frontmatter = parseSubagentFrontmatter(agentMd);
  const body = getSubagentBody(agentMd);

  if (!frontmatter) {
    throw new Error(`Invalid AGENT.md in ${subagentDir}`);
  }

  const frontmatterYaml = yaml.stringify({
    name: frontmatter.name,
    description: frontmatter.description,
    ...(frontmatter.model && { model: frontmatter.model }),
  }).trim();

  let result = `---\n${frontmatterYaml}\n---\n\n${body}`;

  const files = fs.readdirSync(subagentDir)
    .filter(f => f.endsWith('.md') && f !== 'AGENT.md')
    .sort();

  for (const file of files) {
    const filePath = path.join(subagentDir, file);
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    const sectionName = file.replace('.md', '');
    const title = sectionName.charAt(0).toUpperCase() + sectionName.slice(1).toLowerCase();
    result += `\n\n## ${title}\n\n${content}`;
  }

  return result;
}

/**
 * Transform a subagent into a GitHub Copilot CLI custom agent `.agent.md` file.
 *
 * Copilot custom agents are Markdown profiles with YAML frontmatter stored in
 * `~/.copilot/agents/` (user) or `.github/agents/` (project). The file name
 * ends in `.agent.md` and the frontmatter carries `name`, `description`, and
 * optionally `model` and `tools`. The emitted body is identical to Factory
 * Droid's custom-droid format (flatten frontmatter + body + appended .md
 * sections, `color` dropped), so this is an alias of transformSubagentForDroid.
 * See GitHub docs for custom agents.
 */
export function transformSubagentForCopilot(subagentDir: string): string {
  return transformSubagentForDroid(subagentDir);
}

/**
 * Transform a subagent into a Cursor CLI custom subagent `.md` file.
 *
 * Cursor loads subagents from `.cursor/agents/*.md` (project) or
 * `~/.cursor/agents/*.md` (user) — Markdown with YAML frontmatter
 * (name, description, model; also readonly/is_background, which our
 * frontmatter schema doesn't carry). Cursor has no `color` field, so this is
 * an alias of transformSubagentForDroid, same as Copilot.
 * See https://cursor.com/docs/subagents.
 */
export function transformSubagentForCursor(subagentDir: string): string {
  return transformSubagentForDroid(subagentDir);
}

/**
 * Transform a subagent into Antigravity's custom-agent markdown shape.
 *
 * Antigravity exposes custom agents as Markdown files with YAML frontmatter,
 * close to Gemini CLI subagents. Keep portable frontmatter fields and flatten
 * sibling markdown files into the prompt body like the other markdown-backed
 * agents.
 */
export function transformSubagentForAntigravity(subagentDir: string): string {
  const agentMd = path.join(subagentDir, 'AGENT.md');
  const frontmatter = parseSubagentFrontmatter(agentMd);
  const body = getSubagentBody(agentMd);

  if (!frontmatter) {
    throw new Error(`Invalid AGENT.md in ${subagentDir}`);
  }

  const frontmatterYaml = yaml.stringify({
    name: frontmatter.name,
    description: frontmatter.description,
    kind: 'local',
    ...(frontmatter.model && { model: frontmatter.model }),
  }).trim();

  let result = `---\n${frontmatterYaml}\n---\n\n${body}`;
  const files = fs.readdirSync(subagentDir)
    .filter(f => f.endsWith('.md') && f !== 'AGENT.md')
    .sort();

  for (const file of files) {
    const content = fs.readFileSync(path.join(subagentDir, file), 'utf-8').trim();
    const sectionName = file.replace('.md', '');
    const title = sectionName.charAt(0).toUpperCase() + sectionName.slice(1).toLowerCase();
    result += `\n\n## ${title}\n\n${content}`;
  }

  return `${result.trim()}\n`;
}

/**
 * Transform a subagent into an OpenCode agent markdown file.
 *
 * OpenCode loads agents from ~/.config/opencode/agents/*.md (global) with
 * YAML frontmatter (description required; mode: subagent for invocable
 * subagents) and a prompt body. File stem becomes the agent name.
 * https://opencode.ai/docs/agents/
 */
export function transformSubagentForOpenCode(subagentDir: string): string {
  const agentMd = path.join(subagentDir, 'AGENT.md');
  const frontmatter = parseSubagentFrontmatter(agentMd);
  const body = getSubagentBody(agentMd);

  if (!frontmatter) {
    throw new Error(`Invalid AGENT.md in ${subagentDir}`);
  }

  const fm: Record<string, unknown> = {
    description: frontmatter.description,
    mode: 'subagent',
  };
  if (frontmatter.model) fm.model = frontmatter.model;

  let systemPrompt = body.trim();
  const files = fs.readdirSync(subagentDir)
    .filter(f => f.endsWith('.md') && f !== 'AGENT.md')
    .sort();
  for (const file of files) {
    const content = fs.readFileSync(path.join(subagentDir, file), 'utf-8').trim();
    const sectionName = file.replace('.md', '');
    const title = sectionName.charAt(0).toUpperCase() + sectionName.slice(1).toLowerCase();
    systemPrompt += `\n\n## ${title}\n\n${content}`;
  }

  return `---\n${yaml.stringify(fm).trim()}\n---\n\n${systemPrompt}\n`;
}

/**
 * Transform a subagent into a Codex custom-agent TOML file.
 *
 * Codex loads standalone TOML under ~/.codex/agents/*.toml. Required fields:
 * name, description, developer_instructions. Optional model maps from our
 * frontmatter when present.
 * https://developers.openai.com/codex/subagents (custom agents section)
 */
export function transformSubagentForCodex(subagentDir: string): string {
  const agentMd = path.join(subagentDir, 'AGENT.md');
  const frontmatter = parseSubagentFrontmatter(agentMd);

  if (!frontmatter) {
    throw new Error(`Invalid AGENT.md in ${subagentDir}`);
  }

  const instructions = flattenSubagentInstructions(subagentDir);

  // TOML multi-line basic strings still process backslash escapes, so a literal
  // backslash (a Windows path, a regex) must be doubled before """ is escaped.
  const safeInstructions = instructions.replace(/\\/g, '\\\\').replace(/"""/g, '\\"""');
  const safeName = frontmatter.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const safeDesc = frontmatter.description.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  let toml = `name = "${safeName}"\n`;
  toml += `description = "${safeDesc}"\n`;
  if (frontmatter.model) {
    const safeModel = String(frontmatter.model).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    toml += `model = "${safeModel}"\n`;
  }
  toml += `developer_instructions = """\n${safeInstructions}\n"""\n`;
  return toml;
}

function flattenSubagentInstructions(subagentDir: string): string {
  let instructions = getSubagentBody(path.join(subagentDir, 'AGENT.md')).trim();
  const files = fs.readdirSync(subagentDir)
    .filter(f => f.endsWith('.md') && f !== 'AGENT.md')
    .sort();
  for (const file of files) {
    const content = fs.readFileSync(path.join(subagentDir, file), 'utf-8').trim();
    const sectionName = file.replace('.md', '');
    const title = sectionName.charAt(0).toUpperCase() + sectionName.slice(1).toLowerCase();
    instructions += `\n\n## ${title}\n\n${content}`;
  }

  return instructions;
}

/**
 * Transform a subagent into a Goose recipe YAML file.
 *
 * Goose has no dedicated subagent file format — a named subagent IS a recipe.
 * Goose resolves named agents from `~/.config/goose/agents/<name>.yaml` (global)
 * and delegates to them by name in autonomous mode. The recipe schema mirrors the
 * one agents-cli already emits for Goose workflow recipes (`writeGooseSubrecipe`):
 * `version`, `title`, `description`, `instructions`, `prompt`, plus an optional
 * `settings.goose_model`. See goose-docs.ai context-engineering/subagents.
 */
export function transformSubagentForGoose(subagentDir: string): string {
  const agentMd = path.join(subagentDir, 'AGENT.md');
  const frontmatter = parseSubagentFrontmatter(agentMd);
  const body = getSubagentBody(agentMd);

  if (!frontmatter) {
    throw new Error(`Invalid AGENT.md in ${subagentDir}`);
  }

  const files = fs.readdirSync(subagentDir)
    .filter(f => f.endsWith('.md') && f !== 'AGENT.md')
    .sort();

  let prompt = body || frontmatter.description || frontmatter.name;
  for (const file of files) {
    const content = fs.readFileSync(path.join(subagentDir, file), 'utf-8').trim();
    const sectionName = file.replace('.md', '');
    const title = sectionName.charAt(0).toUpperCase() + sectionName.slice(1).toLowerCase();
    prompt += `\n\n## ${title}\n\n${content}`;
  }

  const recipe: Record<string, unknown> = {
    version: '1.0.0',
    title: frontmatter.name || path.basename(subagentDir),
    description: frontmatter.description || frontmatter.name || path.basename(subagentDir),
    instructions: prompt,
    prompt,
  };
  if (frontmatter.model) {
    recipe.settings = { goose_model: frontmatter.model };
  }

  return yaml.stringify(recipe);
}

/**
 * Sync a subagent to an OpenClaw workspace
 * Copies full directory, renames AGENT.md to AGENTS.md
 */
export function syncSubagentToOpenclaw(
  subagentDir: string,
  targetDir: string
): { success: boolean; error?: string } {
  try {
    copyDirWithRename(subagentDir, targetDir, { 'AGENT.md': 'AGENTS.md' });
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Install a subagent to a specific agent's home
 */
export function installSubagentToAgent(
  subagentDir: string,
  subagentName: string,
  agent: AgentId,
  agentHome: string
): { success: boolean; error?: string } {
  if (!subagentTarget(agent)) {
    return { success: false, error: `Agent '${agent}' does not support subagents` };
  }
  try {
    writeSubagentToHome(agent, agentHome, { name: subagentName, path: subagentDir });
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Remove a subagent from a specific agent's home
 */
export function removeSubagentFromAgent(
  subagentName: string,
  agent: AgentId,
  agentHome: string
): { success: boolean; error?: string } {
  // No-op success for agents without a registry entry, matching prior behavior.
  return removeSubagentFromHome(agent, agentHome, subagentName);
}

/**
 * Check if subagent content matches between source and installed
 */
export function subagentContentMatches(installedDir: string, sourceDir: string): boolean {
  if (!fs.existsSync(installedDir) || !fs.existsSync(sourceDir)) {
    return false;
  }

  const installedFiles = fs.readdirSync(installedDir).filter(f => f.endsWith('.md')).sort();
  const sourceFiles = fs.readdirSync(sourceDir).filter(f => f.endsWith('.md')).sort();

  if (installedFiles.length !== sourceFiles.length) {
    return false;
  }

  for (let i = 0; i < installedFiles.length; i++) {
    if (installedFiles[i] !== sourceFiles[i]) {
      return false;
    }

    const installedContent = fs.readFileSync(path.join(installedDir, installedFiles[i]), 'utf-8');
    const sourceContent = fs.readFileSync(path.join(sourceDir, sourceFiles[i]), 'utf-8');

    if (installedContent !== sourceContent) {
      return false;
    }
  }

  return true;
}

// SUBAGENT_CAPABLE_AGENTS removed — use `capableAgents('subagents')` from
// lib/capabilities.ts. The capability matrix on AgentConfig is the single
// source of truth.

/**
 * List subagents installed to a specific agent's home.
 *
 * Layout (target dir, file/dir shape, metadata reader) is declared once per
 * agent in the subagent registry; this is a thin wrapper over the generic
 * enumerator so a new agent needs no arm here -- just a registry entry.
 */
export function listSubagentsForAgent(
  agentId: AgentId,
  home: string
): InstalledSubagent[] {
  return listInstalledSubagentsRich(agentId, home);
}

interface VersionSubagentDiff {
  agent: AgentId;
  version: string;
  orphans: string[];
}

/**
 * Compare a version home's subagents against discovered subagents.
 * Returns orphan subagent names.
 */
export function diffVersionSubagents(agent: AgentId, version: string): VersionSubagentDiff {
  const versionHome = getVersionHomePath(agent, version);

  // Get all discovered subagent names
  const discovered = new Set<string>();
  for (const dir of [getSubagentsDir(), getUserSubagentsDir()]) {
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          discovered.add(entry.name);
        }
      }
    }
  }

  // Anything installed in the version home that isn't a discovered subagent is
  // an orphan. Installed enumeration is registry-driven (per-agent layout).
  const orphans = listInstalledSubagentNames(agent, versionHome).filter((name) => !discovered.has(name));

  return { agent, version, orphans: orphans.sort() };
}

/**
 * Iterate all (agent, version) pairs that support subagents and are installed.
 */
export function iterSubagentsCapableVersions(filter?: { agent?: AgentId; version?: string }): Array<{ agent: AgentId; version: string }> {
  const pairs: Array<{ agent: AgentId; version: string }> = [];
  const agents = filter?.agent ? [filter.agent] : capableAgents('subagents');
  for (const agent of agents) {
    if (!capableAgents('subagents').includes(agent)) continue;
    const versions = listInstalledVersions(agent);
    for (const version of versions) {
      if (filter?.version && filter.version !== version) continue;
      pairs.push({ agent, version });
    }
  }
  return pairs;
}

/**
 * Remove a single subagent from a specific version home.
 * Soft-deletes to ~/.agents/.trash/subagents/.
 */
export function removeSubagentFromVersion(
  agent: AgentId,
  version: string,
  subagentName: string
): { success: boolean; error?: string } {
  const versionHome = getVersionHomePath(agent, version);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trashDir = path.join(getTrashSubagentsDir(), agent, version, subagentName);

  // Registry-driven soft-delete: files land as `<basename>.<stamp>`, dirs as
  // `<stamp>/`, matching the prior per-agent behavior for every layout.
  return trashSubagentFromHome(agent, versionHome, subagentName, trashDir, stamp);
}
