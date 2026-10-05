
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { readMeta, updateMeta } from './state.js';
import { getMainRepoRoot } from './git.js';
import { toPosix } from './platform/index.js';
import { loadProjectDef, projectDirsAbs, resolveDefinedProjectPath } from './projects.js';
import { shellQuote } from './ssh-exec.js';

const HOME = process.env.HOME ?? os.homedir();

export function toHomeRelative(abs: string): string {
  const rel = path.relative(HOME, abs);
  if (rel === '') return '~';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return `~/${toPosix(rel)}`;
  return abs;
}

export function expandLocalHome(p: string): string {
  if (p === '~' || p === '$HOME') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  if (p.startsWith('$HOME/')) return path.join(HOME, p.slice(6));
  return p;
}

export function toRemotePortable(p: string): string {
  // Re-root home-relative paths on the remote host instead of copying the controller's home.
  if (p.startsWith('~') || p.startsWith('$HOME')) return p;
  if (path.isAbsolute(p)) return toHomeRelative(p);
  return p;
}

export function homeRemainder(p: string): string | null {
  if (p === '~' || p === '$HOME') return '';
  if (p.startsWith('~/')) return p.slice(2);
  if (p.startsWith('$HOME/')) return p.slice(6);
  return null;
}

export function deriveMirroredCwd(localCwd: string): string | undefined {
  // Mirroring is available only for paths portable relative to HOME.
  const portable = toRemotePortable(localCwd);
  return homeRemainder(portable) === null ? undefined : portable;
}

export function remoteCdPrefix(remoteCwd?: string, opts: { mirror?: boolean } = {}): string {
  // Mirrored cwd may fall back to remote HOME; an explicit cwd must fail if mistyped.
  if (!remoteCwd) return '';
  const rest = homeRemainder(remoteCwd);
  if (rest === '') return 'cd "$HOME" && ';
  if (rest !== null) {
    const dir = `"$HOME"/${shellQuote(rest)}`;
    return opts.mirror ? `{ cd ${dir} || cd "$HOME"; } && ` : `cd ${dir} && `;
  }
  return `cd ${shellQuote(remoteCwd)} && `;
}

export function getProjectRoot(): string | undefined {
  return readMeta().projectRoot;
}

export function setProjectRoot(rootPath: string): string {
  const stored = toHomeRelative(path.resolve(expandLocalHome(rootPath)));
  updateMeta({ projectRoot: stored });
  return stored;
}

export async function inferProjectRoot(cwd: string): Promise<string | undefined> {
  try {
    const mainRoot = await getMainRepoRoot(cwd);
    return toHomeRelative(path.dirname(mainRoot));
  } catch {
    return undefined;
  }
}

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

export function parseProjectRef(ref: string): ProjectRef {
  const at = ref.indexOf('@');
  if (at === -1) return { slug: ref };
  return { slug: ref.slice(0, at), worktree: ref.slice(at + 1) || undefined };
}

export function buildProjectPath(root: string, ref: string, forRemote: boolean): string {
  const { slug, worktree } = parseProjectRef(ref);
  if (!slug) throw new Error(`Invalid --project value: "${ref}"`);
  let rel = `${root}/${slug}`;
  if (worktree) rel += `/.agents/worktrees/${worktree}`;
  return forRemote ? rel : path.resolve(expandLocalHome(rel));
}

export async function resolveProjectRef(
  ref: string,
  opts: { forRemote: boolean; cwd?: string },
): Promise<string> {
  const { slug, worktree } = parseProjectRef(ref);
  if (!slug) throw new Error(`Invalid --project value: "${ref}"`);

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
