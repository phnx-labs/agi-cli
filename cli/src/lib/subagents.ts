
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

export function parseSubagentFrontmatter(filePath: string): SubagentFrontmatter | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // CRLF support is required for subagents checked out on Windows.
    const lines = content.split(/\r?\n/);

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

export function getSubagentBody(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return '';
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);

  if (lines[0] === '---') {
    const endIndex = lines.slice(1).findIndex((l) => l === '---');
    if (endIndex > 0) {
      return lines.slice(endIndex + 2).join('\n').trim();
    }
  }

  return content;
}

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
      continue;
    }

    const frontmatter = parseSubagentFrontmatter(agentMd);
    if (!frontmatter) {
      console.warn(`Warning: ${agentMd} has invalid frontmatter, skipping`);
      continue;
    }

    const files = fs.readdirSync(dirPath)
      .filter(f => f.endsWith('.md'))
      .sort();

    subagents.push({
      name: dir,
      path: dirPath,
      files,
      agentMd,
      frontmatter,
    });
  }

  return subagents;
}

export function listInstalledSubagents(): InstalledSubagent[] {
  const seen = new Set<string>();
  const subagents: InstalledSubagent[] = [];

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

export function getInstalledSubagent(name: string): InstalledSubagent | null {
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

export function installSubagentCentrally(
  sourcePath: string,
  name: string
): { success: boolean; error?: string } {
  const subagentsDir = getUserSubagentsDir();
  const targetDir = safeJoin(subagentsDir, name);

  try {
    if (!fs.existsSync(subagentsDir)) {
      fs.mkdirSync(subagentsDir, { recursive: true });
    }

    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true });
    }

    fs.cpSync(sourcePath, targetDir, { recursive: true });

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

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

export function transformSubagentForClaude(subagentDir: string): string {
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
    ...(frontmatter.color && { color: frontmatter.color }),
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

export function transformSubagentForCopilot(subagentDir: string): string {
  return transformSubagentForDroid(subagentDir);
}

export function transformSubagentForCursor(subagentDir: string): string {
  return transformSubagentForDroid(subagentDir);
}

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

export function transformSubagentForCodex(subagentDir: string): string {
  const agentMd = path.join(subagentDir, 'AGENT.md');
  const frontmatter = parseSubagentFrontmatter(agentMd);

  if (!frontmatter) {
    throw new Error(`Invalid AGENT.md in ${subagentDir}`);
  }

  const instructions = flattenSubagentInstructions(subagentDir);

  // Escape backslashes and TOML multiline delimiters without changing the instruction text.
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

export function removeSubagentFromAgent(
  subagentName: string,
  agent: AgentId,
  agentHome: string
): { success: boolean; error?: string } {
  return removeSubagentFromHome(agent, agentHome, subagentName);
}

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

export function diffVersionSubagents(agent: AgentId, version: string): VersionSubagentDiff {
  const versionHome = getVersionHomePath(agent, version);

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

  const orphans = listInstalledSubagentNames(agent, versionHome).filter((name) => !discovered.has(name));

  return { agent, version, orphans: orphans.sort() };
}

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

export function removeSubagentFromVersion(
  agent: AgentId,
  version: string,
  subagentName: string
): { success: boolean; error?: string } {
  const versionHome = getVersionHomePath(agent, version);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trashDir = path.join(getTrashSubagentsDir(), agent, version, subagentName);

  return trashSubagentFromHome(agent, versionHome, subagentName, trashDir, stamp);
}
