
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { AgentId } from './types.js';
import { supports } from './capabilities.js';
import { safeJoin } from './paths.js';

const COMMAND_SKILL_MARKER = 'agents_command';

function readCommandMetadata(sourcePath: string): { description: string; body: string } {
  const content = fs.readFileSync(sourcePath, 'utf-8');
  const lines = content.split('\n');

  if (lines[0] !== '---') {
    return { description: '', body: content };
  }

  const endIndex = lines.slice(1).findIndex((line) => line === '---');
  if (endIndex < 0) {
    return { description: '', body: content };
  }

  const frontmatterEnd = endIndex + 1;
  const frontmatter = lines.slice(1, frontmatterEnd).join('\n');
  const body = lines.slice(frontmatterEnd + 1).join('\n').trimStart();

  try {
    const parsed = yaml.parse(frontmatter) as { description?: unknown } | null;
    const description = typeof parsed?.description === 'string' ? parsed.description.trim() : '';
    return { description, body };
  } catch {
    return { description: '', body };
  }
}

function readSkillCommandMarker(skillMdPath: string): string | null {
  if (!fs.existsSync(skillMdPath)) return null;
  const content = fs.readFileSync(skillMdPath, 'utf-8');
  const lines = content.split('\n');
  if (lines[0] !== '---') return null;
  const endIndex = lines.slice(1).findIndex((line) => line === '---');
  if (endIndex < 0) return null;

  try {
    const frontmatter = lines.slice(1, endIndex + 1).join('\n');
    const parsed = yaml.parse(frontmatter) as Record<string, unknown> | null;
    return typeof parsed?.[COMMAND_SKILL_MARKER] === 'string' ? parsed[COMMAND_SKILL_MARKER] : null;
  } catch {
    return null;
  }
}

export function shouldInstallCommandAsSkill(agent: AgentId, version: string): boolean {
  return !supports(agent, 'commands', version).ok && supports(agent, 'skills', version).ok;
}

export const COMMAND_SKILL_DUAL_WRITE_TARGETS = {
  cursor: true,
} satisfies Partial<Record<AgentId, true>>;

export function shouldAlsoInstallCommandAsSkill(agent: AgentId, version: string): boolean {
  return COMMAND_SKILL_DUAL_WRITE_TARGETS[agent as keyof typeof COMMAND_SKILL_DUAL_WRITE_TARGETS] === true
    && supports(agent, 'commands', version).ok
    && supports(agent, 'skills', version).ok;
}

export function commandSkillName(commandName: string): string {
  return commandName;
}

export function buildCommandSkillContent(commandName: string, sourcePath: string): string {
  const { description, body } = readCommandMetadata(sourcePath);
  const skillDescription = description || `Slash command converted from /${commandName}`;
  return [
    '---',
    `name: ${JSON.stringify(commandSkillName(commandName))}`,
    `description: ${JSON.stringify(skillDescription)}`,
    `${COMMAND_SKILL_MARKER}: ${JSON.stringify(commandName)}`,
    '---',
    '',
    `# /${commandName}`,
    '',
    `This skill contains the behavior from the legacy \`/${commandName}\` slash command.`,
    'When invoked with `$' + commandSkillName(commandName) + '`, treat the text after the skill name as the original command arguments.',
    '',
    body.trimEnd(),
    '',
  ].join('\n');
}

function findSkillSourceDir(skillName: string, skillSourceDirs: Array<string | null | undefined>): string | null {
  for (const dir of skillSourceDirs) {
    if (!dir) continue;
    const candidate = path.join(dir, skillName);
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  return null;
}

export function skillSourceExists(skillName: string, skillSourceDirs: Array<string | null | undefined>): boolean {
  return findSkillSourceDir(skillName, skillSourceDirs) !== null;
}

export function readSkillSourceCommandMarker(skillName: string, skillSourceDirs: Array<string | null | undefined>): string | null {
  const sourceDir = findSkillSourceDir(skillName, skillSourceDirs);
  if (!sourceDir) return null;
  return readSkillCommandMarker(path.join(sourceDir, 'SKILL.md'));
}

export function installCommandSkillToVersion(
  agentDir: string,
  commandName: string,
  sourcePath: string,
  skillSourceDirs: Array<string | null | undefined> = []
): { success: boolean; skipped?: boolean; error?: string } {
  const skillName = commandSkillName(commandName);
  const existingSkillSource = findSkillSourceDir(skillName, skillSourceDirs);
  if (existingSkillSource) {
    const sourceMarker = readSkillCommandMarker(path.join(existingSkillSource, 'SKILL.md'));
    if (sourceMarker !== commandName) {
      return { success: true, skipped: true, error: `Skill '${skillName}' already exists` };
    }
  }

  const skillsDir = safeJoin(agentDir, 'skills');
  const skillDir = safeJoin(skillsDir, skillName);
  try {
    fs.rmSync(skillDir, { recursive: true, force: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(safeJoin(skillDir, 'SKILL.md'), buildCommandSkillContent(commandName, sourcePath), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export function listCommandSkillsInVersion(agentDir: string): string[] {
  const skillsDir = path.join(agentDir, 'skills');
  if (!fs.existsSync(skillsDir)) return [];
  const names: string[] = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const marker = readSkillCommandMarker(path.join(skillsDir, entry.name, 'SKILL.md'));
    if (marker) names.push(marker);
  }
  return names.sort();
}

export function commandSkillMatches(agentDir: string, commandName: string, sourcePath: string): boolean {
  const skillMdPath = path.join(agentDir, 'skills', commandSkillName(commandName), 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) return false;
  try {
    return fs.readFileSync(skillMdPath, 'utf-8') === buildCommandSkillContent(commandName, sourcePath);
  } catch {
    return false;
  }
}

export function removeCommandSkillFromVersion(agentDir: string, commandName: string): { success: boolean; error?: string } {
  const skillDir = path.join(agentDir, 'skills', commandSkillName(commandName));
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (readSkillCommandMarker(skillMdPath) !== commandName) {
    return { success: true };
  }

  try {
    fs.rmSync(skillDir, { recursive: true, force: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
