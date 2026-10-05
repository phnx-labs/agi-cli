import * as fs from 'fs';
import * as path from 'path';
import * as TOML from 'smol-toml';
import * as yaml from 'yaml';
import type { AgentId, InstalledSubagent, SubagentFrontmatter } from './types.js';
import { safeJoin } from './paths.js';
import { filesContentMatch, normalizeResourceContent } from './resource-content-diff.js';
import {
  parseSubagentFrontmatter,
  transformSubagentForClaude,
  transformSubagentForCodex,
  transformSubagentForCopilot,
  transformSubagentForCursor,
  transformSubagentForDroid,
  transformSubagentForGoose,
  transformSubagentForOpenCode,
  transformSubagentForAntigravity,
} from './subagents.js';

interface OccupiedEntry {
  path: string;
  kind: 'file' | 'dir';
}

interface SubagentMeta {
  frontmatter: SubagentFrontmatter;
  files: string[];
  path: string;
}

// Keep target adapters in parity with subagent capabilities and native layout contracts.
interface SubagentTarget {
  dir(home: string): string;
  write(dir: string, sub: { name: string; path: string }): void;
  names(dir: string): string[];
  occupied(dir: string, name: string): OccupiedEntry[];
  read(dir: string, name: string): SubagentMeta | null;
  matches(dir: string, sub: { name: string; path: string }): boolean;
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}


function metaFrontmatterSkip(filePath: string): SubagentFrontmatter | null {
  return parseSubagentFrontmatter(filePath);
}

function metaFrontmatterFallback(filePath: string, name: string): SubagentFrontmatter {
  return parseSubagentFrontmatter(filePath) ?? { name, description: '' };
}

function metaJson(filePath: string, name: string): SubagentFrontmatter | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
      name?: string;
      description?: string;
      model?: string;
    };
    return { name: cfg.name || name, description: cfg.description || '', model: cfg.model };
  } catch {
    return null;
  }
}

function metaGooseYaml(filePath: string, name: string): SubagentFrontmatter | null {
  try {
    const recipe = yaml.parse(fs.readFileSync(filePath, 'utf-8')) as {
      title?: string;
      description?: string;
    } | null;
    return { name: recipe?.title || name, description: recipe?.description || '' };
  } catch {
    return null;
  }
}

function metaToml(filePath: string, name: string): SubagentFrontmatter | null {
  try {
    const cfg = TOML.parse(fs.readFileSync(filePath, 'utf-8')) as {
      name?: unknown;
      description?: unknown;
      model?: unknown;
    };
    const tomlName = typeof cfg.name === 'string' ? cfg.name : '';
    const description = typeof cfg.description === 'string' ? cfg.description : '';
    const model = typeof cfg.model === 'string' ? cfg.model : undefined;
    return { name: tomlName || name, description, model };
  } catch {
    return null;
  }
}


export function copyDirWithRename(
  src: string,
  dest: string,
  rename?: Record<string, string>,
): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  for (const file of fs.readdirSync(src)) {
    const sourcePath = path.join(src, file);
    if (!fs.statSync(sourcePath).isFile()) continue;
    const targetName = rename?.[file] ?? file;
    fs.copyFileSync(sourcePath, path.join(dest, targetName));
  }
}


function flatFile(opts: {
  subdir: string[];
  ext: string;
  transform: (subagentDir: string) => string;
  readMeta?: (filePath: string, name: string) => SubagentFrontmatter | null;
}): SubagentTarget {
  const readMeta = opts.readMeta ?? metaFrontmatterSkip;
  return {
    dir: (home) => path.join(home, ...opts.subdir),
    write(dir, sub) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(safeJoin(dir, `${sub.name}${opts.ext}`), opts.transform(sub.path));
    },
    names(dir) {
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(opts.ext))
        .map((f) => f.slice(0, -opts.ext.length));
    },
    occupied(dir, name) {
      return [{ path: safeJoin(dir, `${name}${opts.ext}`), kind: 'file' }];
    },
    read(dir, name) {
      const filePath = path.join(dir, `${name}${opts.ext}`);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
      const frontmatter = readMeta(filePath, name);
      if (!frontmatter) return null;
      return { frontmatter, files: [`${name}${opts.ext}`], path: filePath };
    },
    matches(dir, sub) {
      const filePath = path.join(dir, `${sub.name}${opts.ext}`);
      const installed = readFileSafe(filePath);
      if (installed == null) return false;
      return normalizeResourceContent(installed) === normalizeResourceContent(opts.transform(sub.path));
    },
  };
}

function dirFile(opts: {
  subdir: string[];
  file: string;
  transform: (subagentDir: string) => string;
  readMeta?: (filePath: string, name: string) => SubagentFrontmatter | null;
}): SubagentTarget {
  const readMeta = opts.readMeta ?? ((p: string, name: string) => metaFrontmatterFallback(p, name));
  return {
    dir: (home) => path.join(home, ...opts.subdir),
    write(dir, sub) {
      const target = safeJoin(dir, sub.name);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(safeJoin(target, opts.file), opts.transform(sub.path));
    },
    names(dir) {
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, opts.file)))
        .map((e) => e.name);
    },
    occupied(dir, name) {
      return [{ path: safeJoin(dir, name), kind: 'dir' }];
    },
    read(dir, name) {
      const filePath = path.join(dir, name, opts.file);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
      const frontmatter = readMeta(filePath, name);
      if (!frontmatter) return null;
      return { frontmatter, files: [opts.file], path: filePath };
    },
    matches(dir, sub) {
      const filePath = path.join(dir, sub.name, opts.file);
      const installed = readFileSafe(filePath);
      if (installed == null) return false;
      return normalizeResourceContent(installed) === normalizeResourceContent(opts.transform(sub.path));
    },
  };
}

function dirCopy(opts: {
  subdir: string[];
  marker: string;
  rename?: Record<string, string>;
}): SubagentTarget {
  return {
    dir: (home) => path.join(home, ...opts.subdir),
    write(dir, sub) {
      copyDirWithRename(sub.path, safeJoin(dir, sub.name), opts.rename);
    },
    names(dir) {
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, opts.marker)))
        .map((d) => d.name);
    },
    occupied(dir, name) {
      return [{ path: safeJoin(dir, name), kind: 'dir' }];
    },
    read(dir, name) {
      const markerPath = path.join(dir, name, opts.marker);
      if (!fs.existsSync(markerPath)) return null;
      let frontmatter: SubagentFrontmatter = { name, description: '' };
      const parsed = parseSubagentFrontmatter(markerPath);
      if (parsed) {
        frontmatter = parsed;
      } else {
        const content = fs.readFileSync(markerPath, 'utf-8');
        const firstLine = content.split('\n').find((l) => l.trim() && !l.startsWith('#'));
        frontmatter.description = firstLine?.slice(0, 80) || `${name}`;
      }
      const subagentDir = path.join(dir, name);
      const files = fs
        .readdirSync(subagentDir)
        .filter((f) => f.endsWith('.md'))
        .sort();
      return { frontmatter, files, path: subagentDir };
    },
    matches(dir, sub) {
      // Compare the full directory so removed source files cannot remain installed unnoticed.
      const dest = path.join(dir, sub.name);
      let sourceFiles: string[];
      try {
        sourceFiles = fs.readdirSync(sub.path).filter((f) => {
          try { return fs.statSync(path.join(sub.path, f)).isFile(); } catch { return false; }
        });
      } catch {
        return false;
      }
      const expectedDestNames = new Set<string>();
      for (const file of sourceFiles) {
        const destName = opts.rename?.[file] ?? file;
        expectedDestNames.add(destName);
        if (!filesContentMatch(path.join(sub.path, file), path.join(dest, destName))) return false;
      }
      let destFiles: string[];
      try {
        destFiles = fs.readdirSync(dest).filter((f) => {
          try { return fs.statSync(path.join(dest, f)).isFile(); } catch { return false; }
        });
      } catch {
        return false;
      }
      return destFiles.every((f) => expectedDestNames.has(f));
    },
  };
}


// Current native layouts live here; one-time legacy layouts belong in migration code.
export const SUBAGENT_TARGETS: Partial<Record<AgentId, SubagentTarget>> = {
  claude: flatFile({ subdir: ['.claude', 'agents'], ext: '.md', transform: transformSubagentForClaude }),
  grok: flatFile({ subdir: ['.grok', 'agents'], ext: '.md', transform: transformSubagentForClaude }),
  droid: flatFile({ subdir: ['.factory', 'droids'], ext: '.md', transform: transformSubagentForDroid }),
  codex: flatFile({
    subdir: ['.codex', 'agents'],
    ext: '.toml',
    transform: transformSubagentForCodex,
    readMeta: metaToml,
  }),
  opencode: flatFile({
    subdir: ['.config', 'opencode', 'agents'],
    ext: '.md',
    transform: transformSubagentForOpenCode,
    readMeta: metaFrontmatterFallback,
  }),
  copilot: flatFile({
    subdir: ['.copilot', 'agents'],
    ext: '.agent.md',
    transform: transformSubagentForCopilot,
    readMeta: metaFrontmatterFallback,
  }),
  cursor: flatFile({
    subdir: ['.cursor', 'agents'],
    ext: '.md',
    transform: transformSubagentForCursor,
    readMeta: metaFrontmatterFallback,
  }),
  goose: flatFile({
    subdir: ['.config', 'goose', 'agents'],
    ext: '.yaml',
    transform: transformSubagentForGoose,
    readMeta: metaGooseYaml,
  }),
  antigravity: dirFile({
    subdir: ['.gemini', 'config', 'agents'],
    file: 'agent.md',
    transform: transformSubagentForAntigravity,
  }),
  openclaw: dirCopy({ subdir: ['.openclaw'], marker: 'AGENTS.md', rename: { 'AGENT.md': 'AGENTS.md' } }),
  kimi: flatFile({ subdir: ['.kimi-code', 'agents'], ext: '.md', transform: transformSubagentForClaude, readMeta: metaFrontmatterFallback }),
};

export function subagentTarget(agent: AgentId): SubagentTarget | undefined {
  return SUBAGENT_TARGETS[agent];
}


export function writeSubagentToHome(
  agent: AgentId,
  home: string,
  sub: { name: string; path: string },
): boolean {
  const target = SUBAGENT_TARGETS[agent];
  if (!target) return false;
  target.write(target.dir(home), sub);
  return true;
}

export function listInstalledSubagentNames(agent: AgentId, home: string): string[] {
  const target = SUBAGENT_TARGETS[agent];
  if (!target) return [];
  return target.names(target.dir(home));
}

export function subagentContentMatches(
  agent: AgentId,
  home: string,
  name: string,
  sourceDir: string,
): boolean {
  const target = SUBAGENT_TARGETS[agent];
  if (!target) return false;
  return target.matches(target.dir(home), { name, path: sourceDir });
}

export function listInstalledSubagentsRich(agent: AgentId, home: string): InstalledSubagent[] {
  const target = SUBAGENT_TARGETS[agent];
  if (!target) return [];
  const dir = target.dir(home);
  const out: InstalledSubagent[] = [];
  for (const name of target.names(dir)) {
    const meta = target.read(dir, name);
    if (!meta) continue;
    out.push({ name, path: meta.path, files: meta.files, frontmatter: meta.frontmatter });
  }
  return out;
}

export function removeSubagentFromHome(
  agent: AgentId,
  home: string,
  name: string,
): { success: boolean; error?: string } {
  const target = SUBAGENT_TARGETS[agent];
  if (!target) return { success: true };
  try {
    for (const entry of target.occupied(target.dir(home), name)) {
      if (!fs.existsSync(entry.path)) continue;
      if (entry.kind === 'dir') fs.rmSync(entry.path, { recursive: true, force: true });
      else fs.unlinkSync(entry.path);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export function trashSubagentFromHome(
  agent: AgentId,
  home: string,
  name: string,
  trashDir: string,
  stamp: string,
): { success: boolean; error?: string } {
  const target = SUBAGENT_TARGETS[agent];
  if (!target) return { success: true };
  try {
    const present = target.occupied(target.dir(home), name).filter((e) => fs.existsSync(e.path));
    if (present.length > 0) {
      fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
      for (const entry of present) {
        const dest =
          entry.kind === 'dir'
            ? path.join(trashDir, stamp)
            : path.join(trashDir, `${path.basename(entry.path)}.${stamp}`);
        fs.renameSync(entry.path, dest);
      }
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
