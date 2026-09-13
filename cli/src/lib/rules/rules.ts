/**
 * Rules file management -- reading, writing, and syncing agent instructions.
 *
 * The canonical rules file (AGENTS.md) gets synced
 * into each agent's config directory under their native name (CLAUDE.md,
 * GEMINI.md, etc.). This module handles reading, managing includes, and
 * refreshing rules files across version homes.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AGENTS, ALL_AGENT_IDS, agentConfigDirName } from '../agents.js';
import { getResolvedRulesDir, getUserRulesDir, getProjectAgentsDir } from '../state.js';
import { getEffectiveHome } from '../installations/store.js';
import type { AgentId } from '../types.js';

type InstructionsScope = 'user' | 'project';

interface InstalledInstructions {
  agentId: AgentId;
  scope: InstructionsScope;
  path: string;
  exists: boolean;
}

interface DiscoveredInstructions {
  agentId: AgentId;
  sourcePath: string;
  filename: string;
}

/**
 * Central rules filename constant.
 * All agents map to this file in ~/.agents/rules/, renamed per-agent when synced.
 */
const CENTRAL_RULES_FILENAME = 'AGENTS.md';
const RULES_DOC_FILENAME = 'README.md';

function isSyncableRuleMarkdown(filename: string): boolean {
  return filename.endsWith('.md') && filename !== RULES_DOC_FILENAME;
}

const RULES_SUBDIRS = ['default', 'presets'] as const;

function listRuleMarkdownFiles(rulesDir: string): string[] {
  const files: string[] = [];

  const readDir = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && isSyncableRuleMarkdown(entry.name)) {
        files.push(prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
  };

  readDir(rulesDir, '');
  for (const sub of RULES_SUBDIRS) {
    readDir(path.join(rulesDir, sub), sub);
  }

  return files.sort();
}

/**
 * Get the canonical central rules filename for an agent's instructionsFile.
 * Central storage uses AGENTS.md, which gets renamed per-agent when syncing:
 *   - Claude: AGENTS.md → CLAUDE.md
 *   - Gemini: AGENTS.md → GEMINI.md
 *   - Cursor: AGENTS.md → .cursorrules
 *   - Codex/OpenCode: AGENTS.md → AGENTS.md (no rename)
 */
export function getCentralRulesFileName(agentId: AgentId): string {
  const agent = AGENTS[agentId];
  const instrFile = agent.instructionsFile;

  // If it contains a path separator, extract just the filename
  const filename = instrFile.includes('/') ? path.basename(instrFile) : instrFile;

  // If the agent's instructionsFile isn't AGENTS.md, it was renamed FROM AGENTS.md
  if (filename !== CENTRAL_RULES_FILENAME) {
    return CENTRAL_RULES_FILENAME;
  }
  return filename;
}

/**
 * Get the user-scope config dir for an agent (version-aware).
 */
function getUserConfigDir(agentId: AgentId): string {
  const home = getEffectiveHome(agentId);
  return path.join(home, agentConfigDirName(agentId));
}

export function getInstructionsPath(agentId: AgentId, scope: InstructionsScope, cwd: string = process.cwd()): string {
  const agent = AGENTS[agentId];
  if (scope === 'user') {
    return path.join(getUserConfigDir(agentId), agent.instructionsFile);
  }
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (projectAgentsDir) {
    const projectRulesDir = path.join(projectAgentsDir, 'rules');
    const centralName = getCentralRulesFileName(agentId);
    const candidates = [
      path.join(projectRulesDir, centralName),
      path.join(projectRulesDir, agent.instructionsFile),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  const rootPath = path.join(cwd, agent.instructionsFile);
  if (fs.existsSync(rootPath)) {
    return rootPath;
  }
  return path.join(cwd, `.${agentId}`, agent.instructionsFile);
}

export function instructionsExists(agentId: AgentId, scope: InstructionsScope = 'user', cwd: string = process.cwd()): boolean {
  const instructionsPath = getInstructionsPath(agentId, scope, cwd);
  return fs.existsSync(instructionsPath);
}

export function discoverInstructionsFromRepo(repoPath: string): DiscoveredInstructions[] {
  const instructions: DiscoveredInstructions[] = [];

  const rulesDir = path.join(repoPath, 'rules');
  if (!fs.existsSync(rulesDir)) {
    return instructions;
  }

  for (const agentId of ALL_AGENT_IDS) {
    const agent = AGENTS[agentId];
    // AGENTS.md is the canonical central rules file - don't claim it per-agent.
    // It gets installed centrally to ~/.agents/rules/ and synced per-agent.
    const possibleNames = [
      `${agentId}.md`,
      agent.instructionsFile,
    ].filter(name => name !== 'AGENTS.md');

    for (const filename of possibleNames) {
      const sourcePath = path.join(rulesDir, filename);
      if (fs.existsSync(sourcePath)) {
        instructions.push({
          agentId,
          sourcePath,
          filename,
        });
        break;
      }
    }
  }

  return instructions;
}

export function discoverRuleFilesFromRepo(repoPath: string): string[] {
  const rulesDir = path.join(repoPath, 'rules');
  if (!fs.existsSync(rulesDir)) {
    return [];
  }

  try {
    return listRuleMarkdownFiles(rulesDir);
  } catch {
    return [];
  }
}

export function uninstallInstructions(agentId: AgentId): boolean {
  const agent = AGENTS[agentId];
  const configDir = getUserConfigDir(agentId);
  const targetPath = path.join(configDir, agent.instructionsFile);

  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
    return true;
  }
  return false;
}

export function listInstalledInstructionsWithScope(
  agentId: AgentId,
  cwd: string = process.cwd(),
  options?: { home?: string }
): InstalledInstructions[] {
  const results: InstalledInstructions[] = [];
  const agent = AGENTS[agentId];

  // User-scoped instructions (version-aware when home is provided)
  const home = options?.home || getEffectiveHome(agentId);
  const userConfigDir = path.join(home, agentConfigDirName(agentId));
  const userPath = path.join(userConfigDir, agent.instructionsFile);
  results.push({
    agentId,
    scope: 'user',
    path: userPath,
    exists: fs.existsSync(userPath),
  });

  const projectPath = getInstructionsPath(agentId, 'project', cwd);
  results.push({
    agentId,
    scope: 'project',
    path: projectPath,
    exists: fs.existsSync(projectPath),
  });

  return results;
}

export function getInstructionsContent(agentId: AgentId, scope: InstructionsScope = 'user', cwd: string = process.cwd()): string | null {
  const instructionsPath = getInstructionsPath(agentId, scope, cwd);
  if (!fs.existsSync(instructionsPath)) {
    return null;
  }
  try {
    return fs.readFileSync(instructionsPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Install rules files from repo rules/ to central ~/.agents/rules/ directory.
 * Nested presets/ and rules/ fragments are preserved so @imports keep working.
 */
export function installInstructionsCentrally(
  repoPath: string,
  filesToInstall?: string[]
): { installed: string[]; errors: string[] } {
  const installed: string[] = [];
  const errors: string[] = [];

  const centralDir = getUserRulesDir();
  if (!fs.existsSync(centralDir)) {
    fs.mkdirSync(centralDir, { recursive: true });
  }

  const rulesDir = path.join(repoPath, 'rules');
  if (!fs.existsSync(rulesDir)) {
    return { installed, errors };
  }

  try {
    const files = filesToInstall ?? listRuleMarkdownFiles(rulesDir);
    for (const file of files) {
      if (!isSyncableRuleMarkdown(path.basename(file))) continue;

      const sourcePath = path.join(rulesDir, file);
      const stat = fs.statSync(sourcePath);
      if (!stat.isFile()) continue;

      const targetPath = path.join(centralDir, file);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });

      try {
        fs.copyFileSync(sourcePath, targetPath);
        installed.push(file);
      } catch (err) {
        errors.push(`${file}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    errors.push(`Failed to read rules directory: ${(err as Error).message}`);
  }

  return { installed, errors };
}

/**
 * List top-level rules files from user and system dirs (user wins on collision).
 */
export function listCentralRules(): string[] {
  const seen = new Set<string>();
  for (const dir of [getUserRulesDir(), getResolvedRulesDir()]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((f) => isSyncableRuleMarkdown(f))) {
      seen.add(f);
    }
  }
  return Array.from(seen);
}
