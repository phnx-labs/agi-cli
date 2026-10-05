
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { getProjectsDir } from './state.js';
import { safeJoin } from './paths.js';
import { toHomeRelative, expandLocalHome } from './project-root.js';
import { resolveProjectKey } from './project-key.js';
import { atomicWriteFileSync } from './fs-atomic.js';

export interface ProjectRepo {
  slug: string;
  subpath?: string;
  path?: string;
}

export interface ProjectRepoTarget {
  path: string;
  expectedSlug?: string;
}

export interface ProjectContext {
  path: string;
  purpose: string;
}

export interface ProjectGoal {
  objective: string;
  measure?: string;
}

export interface ProjectIntegration {
  kind: string;
  url: string;
  label?: string;
}

export interface ProjectDef {
  name: string;
  description?: string;
  root?: string;
  defaultPath?: string;
  repo?: string;
  repos?: ProjectRepo[];
  contexts?: ProjectContext[];
  goals?: ProjectGoal[];
  integrations?: ProjectIntegration[];
  linear?: { projectId?: string; url?: string; name?: string };
  docs?: string[];
  dispatch?: {
    enabled?: boolean;
    maxAgents?: number;
    provider?: string;
    host?: string;
  };
}

export function isSafeProjectName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 64 &&
    /^[a-z0-9][a-z0-9._-]*$/i.test(name) &&
    name !== '.' &&
    name !== '..'
  );
}

export function projectDefPath(name: string): string {
  if (!isSafeProjectName(name)) {
    throw new Error(`Invalid project name: "${name}" (letters, digits, ., _, - only)`);
  }
  return safeJoin(getProjectsDir(), `${name}.yaml`);
}

export function validateProjectDef(raw: unknown, sourceName?: string): ProjectDef {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Project ${sourceName ?? ''} is not a YAML mapping`.trim());
  }
  const o = raw as Record<string, unknown>;
  const hasNameField = 'name' in o && o.name !== undefined && o.name !== null;
  let name: string | undefined;
  if (hasNameField) {
    if (typeof o.name !== 'string' || !isSafeProjectName(o.name)) {
      throw new Error(`Project ${sourceName ?? ''}: "name" must be a valid slug (got ${JSON.stringify(o.name)})`);
    }
    name = o.name;
  } else {
    name = sourceName;
  }
  if (!name || !isSafeProjectName(name)) {
    throw new Error('Project definition is missing a valid "name"');
  }
  if (hasNameField && sourceName && name !== sourceName) {
    throw new Error(`Project ${sourceName}: "name" (${JSON.stringify(name)}) must match the filename — the filename is the stable id`);
  }

  const def: ProjectDef = { name };
  if (typeof o.description === 'string') def.description = o.description;
  if (typeof o.root === 'string') def.root = o.root;
  if (typeof o.defaultPath === 'string') def.defaultPath = o.defaultPath;
  if (typeof o.repo === 'string') def.repo = o.repo;

  if (Array.isArray(o.repos)) {
    def.repos = o.repos.flatMap((r) => {
      if (r && typeof r === 'object' && typeof (r as Record<string, unknown>).slug === 'string') {
        const rr = r as Record<string, unknown>;
        if (rr.path !== undefined && typeof rr.path !== 'string') return [];
        const repo: ProjectRepo = { slug: rr.slug as string };
        if (typeof rr.subpath === 'string') repo.subpath = rr.subpath;
        if (typeof rr.path === 'string') repo.path = rr.path;
        return [repo];
      }
      return [];
    });
  }
  if (Array.isArray(o.contexts)) {
    def.contexts = o.contexts.flatMap((c) => {
      if (
        c &&
        typeof c === 'object' &&
        typeof (c as Record<string, unknown>).path === 'string' &&
        typeof (c as Record<string, unknown>).purpose === 'string'
      ) {
        const cc = c as Record<string, unknown>;
        return [{ path: cc.path as string, purpose: cc.purpose as string }];
      }
      return [];
    });
  }
  if (Array.isArray(o.goals)) {
    def.goals = o.goals.flatMap((g) => {
      if (g && typeof g === 'object' && typeof (g as Record<string, unknown>).objective === 'string') {
        const gg = g as Record<string, unknown>;
        const goal: ProjectGoal = { objective: gg.objective as string };
        if (typeof gg.measure === 'string') goal.measure = gg.measure;
        return [goal];
      }
      return [];
    });
  }
  if (Array.isArray(o.integrations)) {
    def.integrations = o.integrations.flatMap((i) => {
      if (
        i &&
        typeof i === 'object' &&
        typeof (i as Record<string, unknown>).kind === 'string' &&
        typeof (i as Record<string, unknown>).url === 'string'
      ) {
        const ii = i as Record<string, unknown>;
        const integ: ProjectIntegration = { kind: ii.kind as string, url: ii.url as string };
        if (typeof ii.label === 'string') integ.label = ii.label;
        return [integ];
      }
      return [];
    });
  }
  if (o.linear && typeof o.linear === 'object' && !Array.isArray(o.linear)) {
    const l = o.linear as Record<string, unknown>;
    def.linear = {};
    if (typeof l.projectId === 'string') def.linear.projectId = l.projectId;
    if (typeof l.url === 'string') def.linear.url = l.url;
    if (typeof l.name === 'string') def.linear.name = l.name;
  }
  if (Array.isArray(o.docs)) def.docs = o.docs.filter((d): d is string => typeof d === 'string');

  if (o.dispatch && typeof o.dispatch === 'object' && !Array.isArray(o.dispatch)) {
    const d = o.dispatch as Record<string, unknown>;
    def.dispatch = {};
    if (d.enabled === true || d.enabled === false) def.dispatch.enabled = d.enabled;
    if (typeof d.maxAgents === 'number' && Number.isFinite(d.maxAgents)) def.dispatch.maxAgents = d.maxAgents;
    if (typeof d.provider === 'string') def.dispatch.provider = d.provider;
    if (typeof d.host === 'string') def.dispatch.host = d.host;
  }

  return def;
}

export function loadProjectDef(name: string): ProjectDef | undefined {
  if (!isSafeProjectName(name)) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(projectDefPath(name), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  return validateProjectDef(yaml.parse(raw), name);
}

export function listProjectDefs(): ProjectDef[] {
  let files: string[];
  try {
    files = fs.readdirSync(getProjectsDir()).filter((f) => f.endsWith('.yaml'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const out: ProjectDef[] = [];
  for (const f of files) {
    const name = f.replace(/\.yaml$/, '');
    const def = loadProjectDef(name);
    if (def) out.push(def);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function writeProjectDef(def: ProjectDef): string {
  const validated = validateProjectDef(def, def.name);
  const normalized: ProjectDef = {
    ...validated,
    root: validated.root ? toHomeRelative(expandLocalHome(validated.root)) : undefined,
    defaultPath: validated.defaultPath
      ? toHomeRelative(expandLocalHome(validated.defaultPath))
      : undefined,
    repos: validated.repos?.map((r) => {
      const repo: ProjectRepo = { ...r };
      if (r.path) repo.path = toHomeRelative(expandLocalHome(r.path));
      return repo;
    }),
  };
  const clean = Object.fromEntries(
    Object.entries(normalized).filter(([, v]) => v !== undefined),
  );
  const target = projectDefPath(def.name);
  fs.mkdirSync(getProjectsDir(), { recursive: true });
  atomicWriteFileSync(target, yaml.stringify(clean), 'utf8');
  return target;
}

export function removeProjectDef(name: string): boolean {
  try {
    fs.unlinkSync(projectDefPath(name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function projectBasePath(def: ProjectDef, forRemote: boolean): string | undefined {
  const base = def.defaultPath ?? def.root;
  if (!base) return undefined;
  return forRemote ? base : expandLocalHome(base);
}

function projectDirList(
  def: ProjectDef,
  opts: {
    primary: string | undefined;
    forRemote: boolean;
    keepMissing: boolean;
    joinSubpath: boolean;
  },
): string[] {
  // Spawn paths may join declared subpaths; remote resolution keeps paths that
  // do not exist on this machine instead of filtering another host's checkout.
  const raw = [
    opts.primary,
    ...(def.repos ?? []).map((r) => {
      if (!r.path) return undefined;
      if (!opts.joinSubpath || !r.subpath) return r.path;
      return `${r.path.replace(/\/+$/, '')}/${r.subpath.replace(/^\/+/, '')}`;
    }),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of raw) {
    const abs = path.resolve(expandLocalHome(p));
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (!opts.keepMissing && !fs.existsSync(abs)) continue;
    out.push(opts.forRemote ? toHomeRelative(abs) : abs);
  }
  return out;
}

export function projectRepoTargetsForDef(def: ProjectDef): ProjectRepoTarget[] {
  // Repository probes anchor at repo roots, not narrowed spawn subpaths, and keep missing targets.
  const targets: ProjectRepoTarget[] = [];
  const seen = new Set<string>();

  const addTarget = (rawPath: string, expectedSlug?: string): void => {
    const abs = path.resolve(expandLocalHome(rawPath));
    if (seen.has(abs)) return;
    seen.add(abs);
    targets.push({ path: toHomeRelative(abs), expectedSlug });
  };

  if (def.root && def.root.length > 0) addTarget(def.root, def.repo);
  for (const r of def.repos ?? []) {
    if (r.path && r.path.length > 0) addTarget(r.path, r.slug);
  }
  return targets;
}

export function projectProbeTargets(def: ProjectDef): string[] {
  return projectRepoTargetsForDef(def).map((t) => t.path);
}

export function projectDirsAbs(
  def: ProjectDef,
  opts: { forRemote: boolean; primary?: string },
): string[] {
  return projectDirList(def, {
    primary: opts.primary ?? projectBasePath(def, opts.forRemote),
    forRemote: opts.forRemote,
    keepMissing: opts.forRemote,
    joinSubpath: true,
  });
}

interface ProjectRootAbs {
  name: string;
  abs: string;
  weak?: boolean;
}

function projectRootsAbs(defs: ProjectDef[]): ProjectRootAbs[] {
  // A narrowed defaultPath is the strong claim; its enclosing root is only fallback attribution.
  const out: ProjectRootAbs[] = [];
  const push = (name: string, raw: string | undefined) => {
    if (!raw) return;
    out.push({ name, abs: path.resolve(expandLocalHome(raw)) });
  };
  for (const def of defs) {
    const rootAbs = def.root ? path.resolve(expandLocalHome(def.root)) : undefined;
    const defaultAbs = def.defaultPath ? path.resolve(expandLocalHome(def.defaultPath)) : undefined;
    const narrowed = !!(rootAbs && defaultAbs && defaultAbs !== rootAbs && isUnder(defaultAbs, rootAbs));
    if (rootAbs) out.push({ name: def.name, abs: rootAbs, weak: narrowed });
    if (defaultAbs && defaultAbs !== rootAbs) out.push({ name: def.name, abs: defaultAbs });
    for (const r of def.repos ?? []) {
      push(def.name, r.path);
      if (r.path && r.subpath) push(def.name, path.join(expandLocalHome(r.path), r.subpath));
    }
  }
  return out;
}

export function repoPathClaims(def: ProjectDef): Array<{ slug: string; prefix: string }> {
  const out: Array<{ slug: string; prefix: string }> = [];
  const add = (slug: string, rel: string) => {
    const trimmed = rel.split(path.sep).join('/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (trimmed && trimmed !== '.') out.push({ slug, prefix: `${trimmed}/` });
  };
  if (def.repo && def.root && def.defaultPath) {
    const rootAbs = path.resolve(expandLocalHome(def.root));
    const defaultAbs = path.resolve(expandLocalHome(def.defaultPath));
    if (isUnder(defaultAbs, rootAbs)) add(def.repo, path.relative(rootAbs, defaultAbs));
  }
  for (const r of def.repos ?? []) {
    if (r.slug && r.subpath) add(r.slug, r.subpath);
  }
  return out;
}

function isUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}

export function projectNameForCwd(cwd: string | undefined, defs: ProjectDef[]): string | undefined {
  // Longest strong multi-repo/subpath ownership wins before any weak umbrella root.
  if (!cwd) return undefined;
  const abs = path.resolve(expandLocalHome(cwd));
  let best: string | undefined;
  let bestLen = -1;
  let weakBest: string | undefined;
  let weakLen = -1;
  for (const { name, abs: root, weak } of projectRootsAbs(defs)) {
    if (!isUnder(abs, root)) continue;
    if (weak) {
      if (root.length > weakLen) {
        weakBest = name;
        weakLen = root.length;
      }
    } else if (root.length > bestLen) {
      best = name;
      bestLen = root.length;
    }
  }
  return best ?? weakBest;
}

let projectDefsMemo: { stamp: string; defs: ProjectDef[] } | null = null;

function projectDefsStamp(): string | null {
  // This feeds a 2 Hz path: per-file mtime+size catches retargeting, while unreadable state is uncached.
  try {
    const dir = getProjectsDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort();
    return files
      .map((f) => {
        try {
          const st = fs.statSync(path.join(dir, f));
          return `${f}:${st.mtimeMs}:${st.size}`;
        } catch {
          return `${f}:gone`;
        }
      })
      .join('\n');
  } catch {
    return null;
  }
}

export function listProjectDefsCached(): ProjectDef[] {
  const stamp = projectDefsStamp();
  if (stamp === null) return [];
  if (projectDefsMemo && projectDefsMemo.stamp === stamp) return projectDefsMemo.defs;
  const defs = listProjectDefs();
  projectDefsMemo = { stamp, defs };
  return defs;
}

export function resetProjectDefsCache(): void {
  projectDefsMemo = null;
}

export function confirmedProjectForCwd(
  cwd: string | undefined | null,
  defs: ProjectDef[] = listProjectDefsCached(),
): string | undefined {
  // Confirmed means a registered definition; best-effort repository keys belong only to resolveProjectNameForCwd.
  if (!cwd) return undefined;
  return projectNameForCwd(cwd, defs);
}

export function resolveProjectNameForCwd(cwd: string | undefined | null, defs: ProjectDef[]): string | undefined {
  if (!cwd) return undefined;
  return projectNameForCwd(cwd, defs) ?? resolveProjectKey(cwd);
}

export function resolveDefinedProjectPath(
  def: ProjectDef,
  worktree: string | undefined,
  forRemote: boolean,
): string | undefined {
  if (worktree) {
    // @worktree paths live under the repo root, never a narrowed defaultPath.
    const rootRaw = def.root ?? def.defaultPath;
    if (!rootRaw) return undefined;
    const wt = `${rootRaw}/.agents/worktrees/${worktree}`;
    return forRemote ? wt : path.resolve(expandLocalHome(wt));
  }
  const base = projectBasePath(def, forRemote);
  if (!base) return undefined;
  return forRemote ? base : path.resolve(base);
}
