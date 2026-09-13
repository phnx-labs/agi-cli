/**
 * Projects-root resolution for the `agents run --project <slug>` shorthand.
 *
 * Projects follow a predictable layout — `<root>/<repo>` (e.g.
 * `~/src/github.com/<user>/<repo>`), with git worktrees under
 * `<repo>/.agents/worktrees/<slug>`. The root is auto-inferred from the repo you
 * launch inside (the directory ABOVE the git root) and cached in `agents.yaml`
 * so later runs resolve a bare slug from anywhere. It is stored home-relative
 * (`~/…`) when it sits under `$HOME`, so the SAME value resolves on a remote
 * host whose home differs (`/home/<user>` vs `/Users/<user>`): a `--device` run
 * keeps the `~` and lets the remote login shell expand it (see `remoteCdPrefix`
 * in `hosts/dispatch.ts`), while a local run expands `~` against the local home.
 */

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

/**
 * Make a `--cwd`/`--project` value portable to a remote host: an absolute path
 * under the LOCAL home (which the local shell already expanded from `~`) becomes
 * `~/…` so the *remote* shell re-roots it at its own home. Paths already anchored
 * at `~`/`$HOME` pass through; other absolute or relative paths are left as-is
 * (used verbatim on the host). Explicit `--remote-cwd` is NOT run through this —
 * it is a literal remote path by contract.
 */
export function toRemotePortable(p: string): string {
  if (p.startsWith('~') || p.startsWith('$HOME')) return p;
  if (path.isAbsolute(p)) return toHomeRelative(p);
  return p;
}

/**
 * If `p` is anchored at the home dir — a leading `~` or `$HOME` — return the
 * remainder (no leading slash), else null. Callers that want a local-home
 * absolute (`/Users/<me>/x`, from a shell-expanded `--cwd ~/x`) re-rooted at the
 * remote home normalize it to `~/x` first (`toRemotePortable`); explicit
 * `--remote-cwd` is left literal and so is never re-rooted here.
 *
 * The canonical home-anchor stripper — shared by `remoteCdPrefix`,
 * `deriveMirroredCwd`, and the interactive-login shell builder
 * (`devices/connect.ts`), so there is exactly one notion of "the part below the
 * home dir".
 */
export function homeRemainder(p: string): string | null {
  if (p === '~' || p === '$HOME') return '';
  if (p.startsWith('~/')) return p.slice(2);
  if (p.startsWith('$HOME/')) return p.slice(6);
  return null;
}

/**
 * Derive the remote directory to mirror from the local cwd, for a host run the
 * caller gave no `--cwd`/`--remote-cwd` (and for an interactive `agents ssh`
 * login with no command).
 *
 * Without this a `--device` run — or an `agents ssh <device>` login — lands in the
 * remote `$HOME`, so an agent launched from a repo starts with no project
 * context and the user has to `cd` by hand. Only a cwd under the LOCAL home is
 * mirrored — that is the part with a meaningful remote analogue (`~/src/x`
 * re-roots onto the remote home). A path outside home returns undefined:
 * `/opt/thing` on this box says nothing about the target's filesystem, so the
 * run keeps the remote home.
 */
export function deriveMirroredCwd(localCwd: string): string | undefined {
  const portable = toRemotePortable(localCwd);
  return homeRemainder(portable) === null ? undefined : portable;
}

/**
 * Build a `cd <dir> && ` prefix that resolves on the REMOTE host.
 *
 * A `~`/`$HOME`-anchored path must resolve against the REMOTE user's home, not
 * the local one (`/home/<me>` vs `/Users/<me>`). We emit an unquoted `"$HOME"`
 * for that segment — the remote login shell expands it — and shell-quote the
 * remainder. Any other path (absolute or relative) is quoted verbatim.
 *
 * `mirror` marks a directory the caller DERIVED from the local cwd rather than
 * one the user asked for (see `deriveMirroredCwd`). The same repo checked out at
 * the same home-relative path on both boxes is the common fleet layout, so
 * mirroring lands the remote agent in the project instead of `$HOME`. It is a
 * best-effort mirror by definition — the host may simply not have that checkout
 * — so a missing directory falls back to the remote home instead of failing the
 * run. An explicit `--cwd`/`--remote-cwd` is never mirrored: the user named that
 * directory, so a missing one must surface as a `cd` error.
 */
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

/**
 * Infer the projects root from `cwd`: the directory ABOVE the git repo root
 * (cwd inside `~/src/github.com/user/repo` → `~/src/github.com/user`). Returns a
 * home-relative string when under `$HOME`; undefined when `cwd` is not in a repo.
 */
export async function inferProjectRoot(cwd: string): Promise<string | undefined> {
  try {
    const mainRoot = await getMainRepoRoot(cwd);
    return toHomeRelative(path.dirname(mainRoot));
  } catch {
    return undefined;
  }
}

/**
 * Resolve the projects root, auto-inferring and caching on first use. Throws an
 * actionable error when it is neither configured nor inferrable from `cwd`.
 */
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

/**
 * Join a root + `--project` ref into a working directory. Pure (no I/O) so the
 * slug/worktree layout is unit-testable. `forRemote` keeps the path
 * home-relative (`~/…`) for the remote shell to expand; otherwise it is expanded
 * against the local home into an absolute path.
 */
export function buildProjectPath(root: string, ref: string, forRemote: boolean): string {
  const { slug, worktree } = parseProjectRef(ref);
  if (!slug) throw new Error(`Invalid --project value: "${ref}"`);
  let rel = `${root}/${slug}`;
  if (worktree) rel += `/.agents/worktrees/${worktree}`;
  return forRemote ? rel : path.resolve(expandLocalHome(rel));
}

/**
 * Resolve a `--project` ref to a working directory, inferring/caching the root.
 *
 * `forRemote: true` returns a home-relative path (`~/…`) so the REMOTE login
 * shell expands `~`/`$HOME` to its own home. `forRemote: false` returns an
 * absolute local path and verifies it exists (so a mistyped slug fails loudly).
 */
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

/**
 * Resolve a `--project` ref to the cwd an agent lands in PLUS the other
 * directories that project binds, so a spawn can grant them.
 *
 * `cwd` is exactly what `resolveProjectRef` returns — this never changes where
 * an agent starts. `extraDirs` is every other `repos[].path`, and is empty for
 * a convention-resolved project (no definition means no bound repos) and for a
 * definition that binds only its primary checkout.
 */
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
