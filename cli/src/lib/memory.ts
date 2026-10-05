// Memory resolves project → user → system; prune only recorded managed names, never user-native files.
// Claude project memory uses the version-independent canonical directory; migrate without clobbering and accept a concurrent same-target link.

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from './types.js';
import {
  getUserAgentsDir,
  getSystemAgentsDir,
  getProjectAgentsDir,
  ensureAgentsDir,
  getRuntimeStateDir,
} from './state.js';
import { agentConfigDirName } from './agents.js';
import { supports } from './capabilities.js';
import { claudeProjectDirName } from './project-key.js';

interface MemoryFact {
  name: string;
  path: string;
  layer: 'project' | 'user' | 'system';
  summary: string;
}

interface MemoryLayerDir {
  layer: 'project' | 'user' | 'system';
  dir: string;
}

export function getUserMemoryDir(): string {
  return path.join(getUserAgentsDir(), 'memory');
}

function getSystemMemoryDir(): string {
  return path.join(getSystemAgentsDir(), 'memory');
}

function getProjectMemoryDir(cwd: string = process.cwd()): string | null {
  const project = getProjectAgentsDir(cwd);
  return project ? path.join(project, 'memory') : null;
}

export function ensureUserMemoryDir(): string {
  ensureAgentsDir();
  const dir = getUserMemoryDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const index = path.join(dir, 'MEMORY.md');
  if (!fs.existsSync(index)) {
    fs.writeFileSync(
      index,
      [
        '# Memory index',
        '',
        'Always-read summary of accumulated agent memory. Individual facts live',
        'as sibling `*.md` files. Managed by `agents memory`.',
        '',
      ].join('\n'),
      'utf-8',
    );
  }
  return dir;
}

const RULE_FILE_NAMES = new Set(['memory.md', 'agents.md', 'claude.md', 'gemini.md', 'readme.md']);

function isFactFile(name: string): boolean {
  return name.endsWith('.md') && !RULE_FILE_NAMES.has(name.toLowerCase());
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'fact';
}

function summarize(content: string): string {
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    return t.length > 80 ? t.slice(0, 77) + '...' : t;
  }
  return '(empty)';
}

function getMemoryLayerDirs(cwd: string = process.cwd()): MemoryLayerDir[] {
  const out: MemoryLayerDir[] = [];
  const project = getProjectMemoryDir(cwd);
  if (project && fs.existsSync(project)) out.push({ layer: 'project', dir: project });
  const user = getUserMemoryDir();
  if (fs.existsSync(user)) out.push({ layer: 'user', dir: user });
  const system = getSystemMemoryDir();
  if (fs.existsSync(system)) out.push({ layer: 'system', dir: system });
  return out;
}

export function listMemoryFacts(cwd: string = process.cwd()): MemoryFact[] {
  const seen = new Set<string>();
  const results: MemoryFact[] = [];
  for (const { layer, dir } of getMemoryLayerDirs(cwd)) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!isFactFile(file)) continue;
      const name = file.replace(/\.md$/i, '');
      if (seen.has(name)) continue;
      seen.add(name);
      const filePath = path.join(dir, file);
      let content = '';
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }
      results.push({ name, path: filePath, layer, summary: summarize(content) });
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export function readMemoryFact(name: string, cwd: string = process.cwd()): MemoryFact | null {
  const slug = slugify(name);
  for (const { layer, dir } of getMemoryLayerDirs(cwd)) {
    const filePath = path.join(dir, `${slug}.md`);
    if (!fs.existsSync(filePath)) continue;
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    return { name: slug, path: filePath, layer, summary: summarize(content) };
  }
  return null;
}

export function addMemoryFact(name: string, body: string): string {
  const dir = ensureUserMemoryDir();
  const slug = slugify(name);
  const filePath = path.join(dir, `${slug}.md`);
  const content = body.trimStart().startsWith('#')
    ? body.endsWith('\n') ? body : body + '\n'
    : `# ${slug}\n\n${body.trim()}\n`;
  fs.writeFileSync(filePath, content, 'utf-8');
  rebuildMemoryIndex(dir);
  return filePath;
}

export function removeMemoryFact(name: string): boolean {
  const dir = getUserMemoryDir();
  const slug = slugify(name);
  const filePath = path.join(dir, `${slug}.md`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  if (fs.existsSync(dir)) rebuildMemoryIndex(dir);
  return true;
}

function rebuildMemoryIndex(dir: string): void {
  let facts: string[] = [];
  try {
    facts = fs.readdirSync(dir).filter(isFactFile).sort();
  } catch {
    return;
  }
  const lines = [
    '# Memory index',
    '',
    'Always-read summary of accumulated agent memory. Managed by `agents memory`.',
    '',
  ];
  if (facts.length === 0) {
    lines.push('_No facts yet. Add one with `agents memory add <name> --body "..."`._', '');
  } else {
    for (const file of facts) {
      const name = file.replace(/\.md$/i, '');
      let summary = '';
      try {
        summary = summarize(fs.readFileSync(path.join(dir, file), 'utf-8'));
      } catch {
        summary = '';
      }
      lines.push(`- **${name}** — ${summary}`);
    }
    lines.push('');
  }
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), lines.join('\n'), 'utf-8');
}

export function memoryTargetDir(agent: AgentId): string {
  switch (agent) {
    case 'claude':
      return path.join(agentConfigDirName(agent), 'memory');
    case 'codex':
      return path.join(agentConfigDirName(agent), 'memories');
    case 'openclaw':
    case 'grok':
      return 'memory';
    default:
      return path.join(agentConfigDirName(agent), 'memory');
  }
}

export function syncMemoryToVersionHome(
  agent: AgentId,
  versionHome: string,
  cwd: string = process.cwd(),
): string[] {
  if (!supports(agent, 'memory').ok) return [];
  const facts = listMemoryFacts(cwd);
  const targetRel = memoryTargetDir(agent);
  const targetDir = path.join(versionHome, targetRel);
  fs.mkdirSync(targetDir, { recursive: true });

  const managedManifestPath = path.join(targetDir, '.agents-cli-memory.json');
  let previouslyManaged: string[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(managedManifestPath, 'utf-8')) as { facts?: unknown };
    if (Array.isArray(raw.facts)) {
      previouslyManaged = raw.facts.filter((f): f is string => typeof f === 'string');
    }
  } catch {  }

  const desiredNames = new Set(facts.map((f) => f.name));
  const managedThisSync = new Set<string>(desiredNames);

  for (const name of previouslyManaged) {
    if (desiredNames.has(name)) continue;
    if (name === 'MEMORY') continue;
    try { fs.unlinkSync(path.join(targetDir, `${name}.md`)); } catch {  }
  }

  const written: string[] = [];
  for (const fact of facts) {
    const dest = path.join(targetDir, `${fact.name}.md`);
    try {
      fs.copyFileSync(fact.path, dest);
      written.push(fact.name);
    } catch {  }
  }

  const indexSrc = (() => {
    for (const { dir } of getMemoryLayerDirs(cwd)) {
      const p = path.join(dir, 'MEMORY.md');
      if (fs.existsSync(p)) return p;
    }
    return null;
  })();
  if (indexSrc) {
    try {
      fs.copyFileSync(indexSrc, path.join(targetDir, 'MEMORY.md'));
      managedThisSync.add('MEMORY');
    } catch {  }
  } else {
    rebuildMemoryIndex(targetDir);
    managedThisSync.add('MEMORY');
  }

  try {
    fs.writeFileSync(
      managedManifestPath,
      JSON.stringify({ facts: [...managedThisSync].sort() }, null, 2) + '\n',
      'utf-8',
    );
  } catch {  }

  return written;
}

export function getClaudeProjectMemoryDir(cwd: string): string {
  const projectKey = claudeProjectDirName(path.resolve(cwd));
  return path.join(getRuntimeStateDir(), 'claude-project-memory', projectKey);
}

export function syncClaudeProjectMemoryDir(versionHome: string, cwd: string = process.cwd()): void {
  const projectKey = claudeProjectDirName(path.resolve(cwd));
  const canonicalDir = path.join(getRuntimeStateDir(), 'claude-project-memory', projectKey);
  const projectDir = path.join(versionHome, agentConfigDirName('claude'), 'projects', projectKey);
  const nativeMemoryDir = path.join(projectDir, 'memory');

  fs.mkdirSync(canonicalDir, { recursive: true, mode: 0o700 });

  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(nativeMemoryDir);
  } catch {  }

  if (existing?.isSymbolicLink()) {
    let currentTarget: string | undefined;
    try { currentTarget = fs.readlinkSync(nativeMemoryDir); } catch {  }
    if (currentTarget === canonicalDir) return;
    fs.unlinkSync(nativeMemoryDir);
  } else if (existing?.isDirectory()) {
    fs.cpSync(nativeMemoryDir, canonicalDir, { recursive: true, force: false, errorOnExist: false });
    fs.rmSync(nativeMemoryDir, { recursive: true, force: true });
  } else if (existing) {
    return;
  }

  fs.mkdirSync(projectDir, { recursive: true });
  try {
    fs.symlinkSync(canonicalDir, nativeMemoryDir, process.platform === 'win32' ? 'junction' : undefined);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
    let racedTarget: string | undefined;
    try { racedTarget = fs.readlinkSync(nativeMemoryDir); } catch {  }
    if (racedTarget !== canonicalDir) throw err;
  }
}
