/** Named project definitions above the `--project <slug>` convention: one YAML per project in
 * `~/.agents/projects/<name>.yaml`, home-relative. SYNCABLE, not synced: they ride the user repo
 * only once committed (`agents repo push user`); until then a reconcile can delete them. */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { getProjectsDir } from './state.js';
import { safeJoin } from './paths.js';
import { toHomeRelative, expandLocalHome } from './project-root.js';
import { resolveProjectKey } from './project-key.js';
import { atomicWriteFileSync } from './fs-atomic.js';

/** A git repo bound to a project, with an optional monorepo subpath. */
export interface ProjectRepo {
  /** GitHub slug `owner/repo`. */
  slug: string;
  /** Optional path within the repo an agent working this project cares about. */
  subpath?: string;
  /** Optional home-relative local checkout of this repo. The def's `root` knows only the primary
   * repo; `path` opts an additional repo into workspace probing (`projects status`). */
  path?: string;
}

/** One checkout target for `projects pull`: a home-relative path plus the expected GitHub slug so
 * the pull verifies the remote first. `expectedSlug` is absent when a bound dir declares none (the
 * pull still fast-forwards, skipping the slug check). */
export interface ProjectRepoTarget {
  /** Home-relative path — re-roots on each fleet device. */
  path: string;
  /** Expected GitHub slug (`owner/repo`) for the remote; absent = unchecked. */
  expectedSlug?: string;
}

/** A described context anchor: a subdirectory plus its `purpose`, so agents know where to look; the
 * richer form of the single monorepo-focus dir. */
export interface ProjectContext {
  /** Path relative to the project root (e.g. `apps/web`). */
  path: string;
  /** One line on how this subtree relates to the project. */
  purpose: string;
}

/** A project goal, the OKR-shaped "why": a qualitative `objective` and an optional `measure` (the
 * key result, e.g. "p95 < 200ms"). Milestones (dated Linear checkpoints) and live work
 * (agents/PRs/artifacts) show how far along it is. */
export interface ProjectGoal {
  /** The outcome, in a line. */
  objective: string;
  /** Optional key result — how success is measured. */
  measure?: string;
}

/** An external context source hung off the project (surfaced in `projects show`). */
export interface ProjectIntegration {
  /** e.g. `gdrive`, `notion`, `figma`, `url`. */
  kind: string;
  url: string;
  label?: string;
}

/** The parsed `~/.agents/projects/<name>.yaml`. */
export interface ProjectDef {
  /** Stable id; matches the filename; what `--project` takes. */
  name: string;
  description?: string;
  /** Repo / monorepo root, home-relative for portability. */
  root?: string;
  /** Where an agent's cwd lands. Defaults to `root` when unset. */
  defaultPath?: string;
  /** Primary GitHub slug (`owner/repo`) — for PR / CI / status roll-up. */
  repo?: string;
  /** All bound repos, each with an optional monorepo subpath. */
  repos?: ProjectRepo[];
  /** Described starting points inside the project. */
  contexts?: ProjectContext[];
  /** The outcomes this project serves (OKR-shaped); a project may have several. */
  goals?: ProjectGoal[];
  /** External context sources (Drive, docs, …). */
  integrations?: ProjectIntegration[];
  /** Linear project link — reuses the existing GraphQL path. */
  linear?: { projectId?: string; url?: string; name?: string };
  /** Free-form doc links surfaced in `projects show`. */
  docs?: string[];
  /** Auto-dispatch settings: when `enabled` and `maxAgents > 0` and the project has a
   * `linear.projectId`, the daemon polls Linear for delegated-Todo tickets and dispatches up to the
   * concurrency cap. */
  dispatch?: {
    /** Opt-in: enable auto-dispatch for this project (default: off). */
    enabled?: boolean;
    /** Per-project concurrency cap for auto-dispatched agents. */
    maxAgents?: number;
    /** Optional provider pin: 'rush' | 'codex' | 'factory' | 'host' | … */
    provider?: string;
    /** For provider='host': which machine to dispatch onto (name/device/cap tag). */
    host?: string;
  };
}

/** A project name safe to use as a filename: no separators, `..`, or leading dot. */
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

/** Absolute path to a project's YAML definition. Throws on an unsafe name. */
export function projectDefPath(name: string): string {
  if (!isSafeProjectName(name)) {
    throw new Error(`Invalid project name: "${name}" (letters, digits, ., _, - only)`);
  }
  return safeJoin(getProjectsDir(), `${name}.yaml`);
}

/** Validate a raw object into a `ProjectDef`, throwing on the first problem. A malformed document or
 * identity (bad/mismatched name) throws; malformed entries in the optional lists
 * (`repos`/`contexts`/`integrations`) are dropped so one bad row can't sink a good def. */
export function validateProjectDef(raw: unknown, sourceName?: string): ProjectDef {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Project ${sourceName ?? ''} is not a YAML mapping`.trim());
  }
  const o = raw as Record<string, unknown>;
  // The filename is the identity; a `name:` field is optional but, when present,
  // must be a valid slug — a malformed one is a loud error, not a silent fallback.
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
  // The filename IS the stable id — a def whose `name:` disagrees with its
  // filename would resolve under one name and list under another.
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
        // A malformed `path` sinks the whole entry, like any other malformed
        // list row — a half-valid repo must not probe a surprising location.
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

/** Load one project definition. Undefined when the file is absent (not a defined project; fall back
 * to convention); throws when a file EXISTS and is malformed. */
export function loadProjectDef(name: string): ProjectDef | undefined {
  if (!isSafeProjectName(name)) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(projectDefPath(name), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined; // absent — not a defined project
    }
    throw error;
  }
  return validateProjectDef(yaml.parse(raw), name);
}

/** List every defined project sorted by name. A missing projects dir is the empty state; malformed
 * defs and filesystem failures stay loud so CLI callers (including Factory) show the real error. */
export function listProjectDefs(): ProjectDef[] {
  let files: string[];
  try {
    // Definitions are `<name>.yaml` (what projectDefPath/loadProjectDef read). We
    // deliberately do NOT list `.yml` here — accepting it would then ENOENT in the
    // loader and silently drop the project. One extension, one code path.
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

/** Persist a project definition, normalizing `root`/`defaultPath` to home-relative for portability.
 * Creates the dir on first write; writes via temp+rename so readers never see a partial file. */
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
  // Drop undefined keys so the YAML stays clean.
  const clean = Object.fromEntries(
    Object.entries(normalized).filter(([, v]) => v !== undefined),
  );
  const target = projectDefPath(def.name);
  fs.mkdirSync(getProjectsDir(), { recursive: true });
  atomicWriteFileSync(target, yaml.stringify(clean), 'utf8');
  return target;
}

/** Delete a project definition. Returns true if a file was removed. Never touches the repo. */
export function removeProjectDef(name: string): boolean {
  try {
    fs.unlinkSync(projectDefPath(name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** The cwd an agent lands in for a defined project: `defaultPath` else `root`; home-relative when
 * `forRemote` (remote shell expands `~`), else expanded locally. Undefined when neither is set. */
export function projectBasePath(def: ProjectDef, forRemote: boolean): string | undefined {
  const base = def.defaultPath ?? def.root;
  if (!base) return undefined;
  return forRemote ? base : expandLocalHome(base);
}

/** Every directory a project binds: `primary` first, then each `repos[]` path, deduped. Callers
 * differ on three parameters: primary (spawn `defaultPath ?? root`, probe `root`), keepMissing
 * (probe keeps absent dirs), joinSubpath (spawn grants the subdir). */
function projectDirList(
  def: ProjectDef,
  opts: {
    primary: string | undefined;
    forRemote: boolean;
    keepMissing: boolean;
    joinSubpath: boolean;
  },
): string[] {
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
    // Dedupe on the absolute local path so `~/src/x` and an already-expanded
    // `/home/me/src/x` in a hand-edited def collapse to one entry.
    const abs = path.resolve(expandLocalHome(p));
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (!opts.keepMissing && !fs.existsSync(abs)) continue;
    out.push(opts.forRemote ? toHomeRelative(abs) : abs);
  }
  return out;
}

/** All checkout targets for a def with their expected GitHub slug, home-relative and including
 * missing checkouts so a peer can answer `missing`. The single expansion behind both `projects
 * status` and `projects pull`, so they act on the same directories. */
export function projectRepoTargetsForDef(def: ProjectDef): ProjectRepoTarget[] {
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

/** The directories `projects status` probes across the fleet: the repo root plus every bound
 * checkout, home-relative, including ones absent here so a peer can answer `✗ missing`. */
export function projectProbeTargets(def: ProjectDef): string[] {
  return projectRepoTargetsForDef(def).map((t) => t.path);
}

/** Directories an agent spawned on this project should reach: the cwd first, then every other bound
 * repo. `forRemote` keeps `~/...`; locally they are absolute and filtered to what exists. Callers
 * pass the resolved primary so `slug@worktree` grants sibling repos too. */
export function projectDirsAbs(
  def: ProjectDef,
  opts: { forRemote: boolean; primary?: string },
): string[] {
  return projectDirList(def, {
    primary: opts.primary ?? projectBasePath(def, opts.forRemote),
    forRemote: opts.forRemote,
    // A remote spawn must not be filtered by THIS box's filesystem: the target
    // host has its own checkouts, and a dir missing here may well be there.
    keepMissing: opts.forRemote,
    joinSubpath: true,
  });
}

/** A project plus its repo root as an absolute local path, for cwd matching. */
interface ProjectRootAbs {
  name: string;
  /** One absolute, normalized path this project claims. A project contributes several (root,
   * monorepo subdir, each bound repo's checkout and subpath) so the most specific claim can win. */
  abs: string;
  /** A fallback claim used only when no ordinary claim matches. A narrowed project's root is weak:
   * it loses the shared monorepo root to an umbrella project but still covers its own repo when
   * nobody else claims it. */
  weak?: boolean;
}

function projectRootsAbs(defs: ProjectDef[]): ProjectRootAbs[] {
  const out: ProjectRootAbs[] = [];
  const push = (name: string, raw: string | undefined) => {
    if (!raw) return;
    out.push({ name, abs: path.resolve(expandLocalHome(raw)) });
  };
  for (const def of defs) {
    // `root` is where the CHECKOUT is; `defaultPath` is which work is this project's, so for a
    // monorepo subproject only the narrower one is a membership claim. `root ?? defaultPath`
    // collapsed it onto the umbrella's root and sessions went to whichever def came first.
    const rootAbs = def.root ? path.resolve(expandLocalHome(def.root)) : undefined;
    const defaultAbs = def.defaultPath ? path.resolve(expandLocalHome(def.defaultPath)) : undefined;
    const narrowed = !!(rootAbs && defaultAbs && defaultAbs !== rootAbs && isUnder(defaultAbs, rootAbs));
    // A narrowed project's root is a WEAK claim: it covers the rest of the checkout when nobody
    // else wants it but yields to outright claims. Dropping it regressed the single-project case,
    // since `--path` is where agents START, not which work counts.
    if (rootAbs) out.push({ name: def.name, abs: rootAbs, weak: narrowed });
    if (defaultAbs && defaultAbs !== rootAbs) out.push({ name: def.name, abs: defaultAbs });
    for (const r of def.repos ?? []) {
      push(def.name, r.path);
      // A repo pinned to a monorepo subpath anchors at that subpath too.
      if (r.path && r.subpath) push(def.name, path.join(expandLocalHome(r.path), r.subpath));
    }
  }
  return out;
}

/** Repository paths a project claims as `{ slug, prefix }`, the repo-side form of {@link
 * projectRootsAbs}: a narrowed `defaultPath` or a `repos[]` `subpath`. No narrowed claim means the
 * whole repo and no row; `defaultPath` outside `root` and weak roots have no repo form. */
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

/** True when `child` is `parent` or nested under it (path-segment aware). */
function isUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}

/** Which defined project a session belongs to, from its cwd: the LONGEST matching root wins, so a
 * nested project beats its parent; undefined if none. Compared against the LOCAL home, so sessions
 * from different-home machines won't match until the fleet-wide variant lands. */
export function projectNameForCwd(cwd: string | undefined, defs: ProjectDef[]): string | undefined {
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

/** Definition list memoized against a stamp over the definition FILES, for per-tick readers
 * (PHNX-3999) like `feed watch`. The stamp is name+mtime+size per file, not the directory's mtime,
 * which doesn't move when a def is edited in place. Unreadable dir: not cached. */
let projectDefsMemo: { stamp: string; defs: ProjectDef[] } | null = null;

function projectDefsStamp(): string | null {
  try {
    const dir = getProjectsDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort();
    return files
      .map((f) => {
        try {
          const st = fs.statSync(path.join(dir, f));
          return `${f}:${st.mtimeMs}:${st.size}`;
        } catch {
          // Removed between readdir and stat — its absence is part of the stamp.
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
  // No projects dir (or unreadable): nothing is confirmed, and nothing to cache.
  if (stamp === null) return [];
  if (projectDefsMemo && projectDefsMemo.stamp === stamp) return projectDefsMemo.defs;
  const defs = listProjectDefs();
  projectDefsMemo = { stamp, defs };
  return defs;
}

/** Drop the {@link listProjectDefsCached} memo — for tests that rewrite the dir within one mtime tick. */
export function resetProjectDefsCache(): void {
  projectDefsMemo = null;
}

/** The CONFIRMED project for a cwd, or undefined (PHNX-3999 F08/F09): exactly a registered def whose
 * root contains the path. Being in some git repo or a directory basename is NOT an association;
 * those invented project names. Consumers show undefined as Uncategorized, still reachable. */
export function confirmedProjectForCwd(
  cwd: string | undefined | null,
  defs: ProjectDef[] = listProjectDefsCached(),
): string | undefined {
  if (!cwd) return undefined;
  return projectNameForCwd(cwd, defs);
}

/** The canonical project label for a cwd, for every surface bucketing work by project: the DEFINED
 * project whose root contains it (longest wins), else the repository key from {@link
 * resolveProjectKey}. With no defs (fail-open {@link listProjectDefs}) this is today's behavior. */
export function resolveProjectNameForCwd(cwd: string | undefined | null, defs: ProjectDef[]): string | undefined {
  if (!cwd) return undefined;
  return projectNameForCwd(cwd, defs) ?? resolveProjectKey(cwd);
}

/** Resolve a defined project's ref to a working directory, mirroring `buildProjectPath`'s
 * `forRemote` contract. A `@worktree` lands under the repo ROOT's `.agents/worktrees/`, not the
 * `defaultPath` subdir. Undefined without `root`/`defaultPath`. */
export function resolveDefinedProjectPath(
  def: ProjectDef,
  worktree: string | undefined,
  forRemote: boolean,
): string | undefined {
  if (worktree) {
    const rootRaw = def.root ?? def.defaultPath;
    if (!rootRaw) return undefined;
    const wt = `${rootRaw}/.agents/worktrees/${worktree}`;
    return forRemote ? wt : path.resolve(expandLocalHome(wt));
  }
  const base = projectBasePath(def, forRemote);
  if (!base) return undefined;
  return forRemote ? base : path.resolve(base);
}
