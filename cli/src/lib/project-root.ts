/** `agents run --project <slug>` root: `<root>/<repo>`, worktrees under
 * `<repo>/.agents/worktrees/<slug>`. Inferred from the launch repo, cached in `agents.yaml`, stored
 * home-relative (`~/...`) so it resolves on remote hosts (`remoteCdPrefix`). */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { readMeta, updateMeta } from './state.js';
import { getMainRepoRoot } from './git.js';
import { toPosix } from './platform/index.js';
import { loadProjectDef, projectDirsAbs, resolveDefinedProjectPath } from './projects.js';
import { shellQuote } from './ssh-exec.js';

const HOME = process.env.HOME ?? os.homedir();

/** Rewrite an absolute path under the local home to a `~/`-relative string; pass others through. */
export function toHomeRelative(abs: string): string {
  const rel = path.relative(HOME, abs);
  if (rel === '') return '~';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return `~/${toPosix(rel)}`;
  return abs;
}

/** Expand a leading `~`/`$HOME` against the LOCAL home. Other paths pass through unchanged. */
export function expandLocalHome(p: string): string {
  if (p === '~' || p === '$HOME') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  if (p.startsWith('$HOME/')) return path.join(HOME, p.slice(6));
  return p;
}

/** Make a `--cwd`/`--project` value portable to a remote host: an absolute path under the LOCAL home
 * becomes `~/...` so the remote shell re-roots it. Other paths pass through; `--remote-cwd` is a
 * literal remote path and skips this. */
export function toRemotePortable(p: string): string {
  if (p.startsWith('~') || p.startsWith('$HOME')) return p;
  if (path.isAbsolute(p)) return toHomeRelative(p);
  return p;
}

/** If `p` is anchored at home (`~` or `$HOME`) return the remainder, else null. The canonical
 * home-anchor stripper shared by `remoteCdPrefix`, `deriveMirroredCwd` and `devices/connect.ts`.
 * Local absolutes go through `toRemotePortable` first. */
export function homeRemainder(p: string): string | null {
  if (p === '~' || p === '$HOME') return '';
  if (p.startsWith('~/')) return p.slice(2);
  if (p.startsWith('$HOME/')) return p.slice(6);
  return null;
}

/** Derive the remote dir to mirror from the local cwd for a host run or `agents ssh` login with no
 * explicit cwd, else the agent lands in the remote $HOME. Only a cwd under the LOCAL home has a
 * remote analogue; paths outside it return undefined. */
export function deriveMirroredCwd(localCwd: string): string | undefined {
  const portable = toRemotePortable(localCwd);
  return homeRemainder(portable) === null ? undefined : portable;
}

/** Build a `cd <dir> && ` prefix for the REMOTE host: `~`/`$HOME` paths emit an unquoted `"$HOME"`
 * for the remote shell, the rest is shell-quoted. `mirror` marks a cwd derived from the local one,
 * so a missing dir falls back to remote home; explicit cwds never mirror. */
export function remoteCdPrefix(remoteCwd?: string, opts: { mirror?: boolean } = {}): string {
  if (!remoteCwd) return '';
  const rest = homeRemainder(remoteCwd);
  if (rest === '') return 'cd "$HOME" && ';
  if (rest !== null) {
    const dir = `"$HOME"/${shellQuote(rest)}`;
    return opts.mirror ? `{ cd ${dir} || cd "$HOME"; } && ` : `cd ${dir} && `;
  }
  return `cd ${shellQuote(remoteCwd)} && `;
}

/** The configured projects root (home-relative or absolute), or undefined when unset. */
export function getProjectRoot(): string | undefined {
  return readMeta().projectRoot;
}

/** Set (override) the cached projects root. Stored home-relative when under `$HOME`. */
export function setProjectRoot(rootPath: string): string {
  const stored = toHomeRelative(path.resolve(expandLocalHome(rootPath)));
  updateMeta({ projectRoot: stored });
  return stored;
}

/** Infer the projects root from `cwd`: the directory above the git repo root
 * (`~/src/github.com/user/repo` -> `~/src/github.com/user`), home-relative under $HOME; undefined
 * outside a repo. */
export async function inferProjectRoot(cwd: string): Promise<string | undefined> {
  try {
    const mainRoot = await getMainRepoRoot(cwd);
    return toHomeRelative(path.dirname(mainRoot));
  } catch {
    return undefined;
  }
}

/** Resolve the projects root, inferring and caching it on first use; throws an actionable error when
 * neither configured nor inferrable from `cwd`. */
async function ensureProjectRoot(cwd: string): Promise<string> {
  const existing = getProjectRoot();
  if (existing) return existing;
  const inferred = await inferProjectRoot(cwd);
  if (!inferred) {
    throw new Error(
      'Could not determine your projects root. Run once from inside a project ' +
        '(a git repo under your projects dir) so it can be inferred, or set it:\n' +
        '  agents config set project.root ~/src/github.com/<you>',
    );
  }
  updateMeta({ projectRoot: inferred });
  process.stderr.write(`[project] cached projects root: ${inferred}\n`);
  return inferred;
}

interface ProjectRef {
  slug: string;
  worktree?: string;
}

/** Parse a `--project` value of the form `<slug>[@<worktree>]`. */
export function parseProjectRef(ref: string): ProjectRef {
  const at = ref.indexOf('@');
  if (at === -1) return { slug: ref };
  return { slug: ref.slice(0, at), worktree: ref.slice(at + 1) || undefined };
}

/** Join a root + `--project` ref into a working directory. Pure (no I/O) so the layout is
 * unit-testable; `forRemote` keeps it home-relative (`~/...`) for the remote shell, else expands
 * against the local home. */
export function buildProjectPath(root: string, ref: string, forRemote: boolean): string {
  const { slug, worktree } = parseProjectRef(ref);
  if (!slug) throw new Error(`Invalid --project value: "${ref}"`);
  let rel = `${root}/${slug}`;
  if (worktree) rel += `/.agents/worktrees/${worktree}`;
  return forRemote ? rel : path.resolve(expandLocalHome(rel));
}

/** Resolve a `--project` ref to a working directory, inferring/caching the root. `forRemote: true`
 * returns `~/...` for the remote shell to expand; `false` returns an absolute local path and
 * verifies it exists, so a mistyped slug fails loudly. */
export async function resolveProjectRef(
  ref: string,
  opts: { forRemote: boolean; cwd?: string },
): Promise<string> {
  const { slug, worktree } = parseProjectRef(ref);
  if (!slug) throw new Error(`Invalid --project value: "${ref}"`);

  // Definition first: a named project in ~/.agents/projects/<slug>.yaml overrides
  // the <root>/<slug> convention. Absent (or root-less) → fall through unchanged.
  const def = loadProjectDef(slug);
  if (def) {
    const fromDef = resolveDefinedProjectPath(def, worktree, opts.forRemote);
    if (fromDef) {
      if (!opts.forRemote && !fs.existsSync(fromDef)) {
        throw new Error(`Project path not found: ${fromDef} (defined in ${slug}.yaml)`);
      }
      return fromDef;
    }
  }

  const cwd = opts.cwd ?? process.cwd();
  const root = await ensureProjectRoot(cwd);
  const resolved = buildProjectPath(root, ref, opts.forRemote);
  if (!opts.forRemote && !fs.existsSync(resolved)) {
    throw new Error(`Project path not found: ${resolved}`);
  }
  return resolved;
}

/** Resolve a `--project` ref to the cwd an agent lands in plus the other directories the project
 * binds, so a spawn can grant them. `cwd` is what `resolveProjectRef` returns; `extraDirs` is
 * every other `repos[].path` (empty for convention-resolved projects). */
export async function resolveProjectDirs(
  ref: string,
  opts: { forRemote: boolean; cwd?: string },
): Promise<{ cwd: string; extraDirs: string[] }> {
  const resolved = await resolveProjectRef(ref, opts);
  const { slug } = parseProjectRef(ref);
  const def = slug ? loadProjectDef(slug) : undefined;
  if (!def) return { cwd: resolved, extraDirs: [] };

  const all = projectDirsAbs(def, { forRemote: opts.forRemote, primary: resolved });
  return { cwd: resolved, extraDirs: all.filter((d) => d !== resolved) };
}
