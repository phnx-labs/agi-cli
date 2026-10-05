/** Surface the held set of agent worktrees (PHNX-3520). The nightly `worktree-sweep` (PHNX-3503)
 * holds dirty/unmerged/undeterminable trees but prints only `held=<n>`. Read-only: buckets them,
 * deletes nothing, fails closed. `unmerged-commits` is stranded work (PHNX-2951/2732): push it. */
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const WORKTREE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** Coarse bucket of a held worktree. `unmerged-commits`: real work nobody can see; push or open a
 * PR, never delete. `uncommitted-changes`: dirty tree, needs a human. `undeterminable`: broken or
 * locked checkout; fails closed, never sweep. */
export type HeldBucket = 'unmerged-commits' | 'uncommitted-changes' | 'undeterminable';

/** Specific reason inside a bucket; `undeterminable` splits into `status-unreadable` (locked index)
 * and `merge-state-unknown` (no resolvable default ref). */
export type HeldReason =
  | 'unmerged-commits'
  | 'uncommitted-changes'
  | 'status-unreadable'
  | 'merge-state-unknown';

export interface HeldWorktree {
  repo: string;
  repoName: string;
  name: string;
  path: string;
  branch: string | null;
  bucket: HeldBucket;
  reason: HeldReason;
  /** Commits with no patch-equivalent upstream (`git cherry`); -1 means it could not be established. */
  unmergedCommits: number;
  dirtyFiles: number;
  hasRemoteBranch: boolean;
  ageDays: number;
  sizeBytes: number;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

/** Resolve the default branch ref: `origin/HEAD`, else `origin/main` or `origin/master`. Null when
 * none resolve, making every worktree `merge-state-unknown` instead of comparing against nothing. */
export async function resolveDefaultRef(repoRoot: string): Promise<string | null> {
  try {
    const head = await git(repoRoot, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']);
    if (head) return head;
  } catch {
  }
  for (const ref of ['origin/main', 'origin/master']) {
    try {
      await git(repoRoot, ['rev-parse', '--verify', '--quiet', ref]);
      return ref;
    } catch {
    }
  }
  return null;
}

/** Count commits with no patch-equivalent upstream; -1 when unknown (`merge-state-unknown`).
 * Patch-id (`git cherry`), not ancestry: this fleet rebase-merges, so `merge-base --is-ancestor`
 * reports landed work as unmerged. It also covers unpushed commits. */
async function countUnmergedCommits(
  worktreePath: string,
  defaultRef: string | null,
): Promise<number> {
  if (!defaultRef) return -1;
  try {
    const out = await git(worktreePath, ['cherry', defaultRef, 'HEAD']);
    if (!out) return 0;
    return out.split('\n').filter((l) => l.startsWith('+')).length;
  } catch {
    return -1;
  }
}

interface PorcelainEntry {
  path: string;
  branch: string | null;
  detached: boolean;
}

function parseWorktreePorcelain(out: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  let cur: PorcelainEntry | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur);
      cur = { path: line.slice('worktree '.length), branch: null, detached: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

/** True when `child` is `parent` or beneath it, on path boundaries: a raw `startsWith` makes
 * `.../fix-1103` look inside `.../fix-110`. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

interface HeldFacts {
  branch: string | null;
  dirtyFiles: number;
  unmergedCommits: number;
}

/** Decide a worktree's bucket, or null when clean and fully upstream. Pure. Precedence is for
 * surfacing, not deletion: a determinable `unmerged-commits` wins even if the tree is dirty, since
 * recoverable work is the priority. `undeterminable` only when merge state itself is unreadable. */
export function classifyHeld(facts: HeldFacts): { bucket: HeldBucket; reason: HeldReason } | null {
  if (facts.unmergedCommits < 0) return { bucket: 'undeterminable', reason: 'merge-state-unknown' };
  if (facts.unmergedCommits > 0) return { bucket: 'unmerged-commits', reason: 'unmerged-commits' };
  if (facts.dirtyFiles < 0) return { bucket: 'undeterminable', reason: 'status-unreadable' };
  if (facts.dirtyFiles > 0) return { bucket: 'uncommitted-changes', reason: 'uncommitted-changes' };
  return null;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return -1;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        const sub = await dirSize(p);
        if (sub > 0) total += sub;
      } else if (e.isFile()) {
        const st = await fs.stat(p);
        total += st.size;
      }
    } catch {
    }
  }
  return total;
}

/** Classify every worktree under one repo and return the held ones. Read-only (no remove, branch -d,
 * or push); the primary checkout is never a `.agents/worktrees` slug, so it is skipped. */
export async function collectHeldWorktrees(repoRoot: string): Promise<HeldWorktree[]> {
  let porcelain: string;
  try {
    porcelain = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  } catch {
    return [];
  }
  const entries = parseWorktreePorcelain(porcelain);
  const defaultRef = await resolveDefaultRef(repoRoot);
  const now = Date.now();
  const wtContainer = path.join(repoRoot, '.agents', 'worktrees');
  const repoName = path.basename(repoRoot);

  const held: HeldWorktree[] = [];
  for (const e of entries) {
    if (!isInside(e.path, wtContainer)) continue;

    let dirtyFiles = -1;
    try {
      const status = await git(e.path, ['status', '--porcelain']);
      dirtyFiles = status ? status.split('\n').length : 0;
    } catch {
      dirtyFiles = -1;
    }
    const unmergedCommits = await countUnmergedCommits(e.path, defaultRef);

    const verdict = classifyHeld({ branch: e.branch, dirtyFiles, unmergedCommits });
    if (!verdict) continue;

    let hasRemoteBranch = false;
    if (e.branch) {
      try {
        const ls = await git(repoRoot, ['ls-remote', '--heads', 'origin', e.branch]);
        hasRemoteBranch = ls.length > 0;
      } catch {
        hasRemoteBranch = false;
      }
    }

    let ageDays = 0;
    try {
      const st = await fs.stat(e.path);
      ageDays = Math.max(0, Math.floor((now - st.mtimeMs) / 86_400_000));
    } catch {
      ageDays = 0;
    }

    held.push({
      repo: repoRoot,
      repoName,
      name: path.basename(e.path),
      path: e.path,
      branch: e.branch,
      bucket: verdict.bucket,
      reason: verdict.reason,
      unmergedCommits,
      dirtyFiles,
      hasRemoteBranch,
      ageDays,
      sizeBytes: await dirSize(e.path),
    });
  }
  return held;
}

/** Discover repo roots owning a `.agents/worktrees` container under `searchHome`, mirroring the
 * sweep: match directory shape and prune heavy dirs. Read-only. */
async function discoverWorktreeRepos(searchHome: string, maxDepth = 7): Promise<string[]> {
  const PRUNE = new Set([
    'node_modules', '.cache', '.npm', '.bun', 'Library', '.venv', 'dist', 'target', '.git',
  ]);
  const repos = new Set<string>();

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (PRUNE.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.name === '.agents') {
        try {
          const st = await fs.stat(path.join(p, 'worktrees'));
          if (st.isDirectory()) repos.add(dir);
        } catch {
        }
        continue;
      }
      await walk(p, depth + 1);
    }
  }

  await walk(searchHome, 0);
  return [...repos].sort();
}

export async function collectHeldWorktreesUnder(searchHome: string): Promise<HeldWorktree[]> {
  const repos = await discoverWorktreeRepos(searchHome);
  const all: HeldWorktree[] = [];
  for (const repo of repos) {
    all.push(...(await collectHeldWorktrees(repo)));
  }
  return all;
}

interface HeldSummary {
  total: number;
  buckets: Record<HeldBucket, HeldWorktree[]>;
}

const EMPTY_BUCKETS = (): Record<HeldBucket, HeldWorktree[]> => ({
  'unmerged-commits': [],
  'uncommitted-changes': [],
  'undeterminable': [],
});

export function summarizeHeld(held: HeldWorktree[]): HeldSummary {
  const buckets = EMPTY_BUCKETS();
  for (const w of held) buckets[w.bucket].push(w);
  return { total: held.length, buckets };
}

export interface DeviceHeld {
  device: string;
  held: HeldWorktree[];
}

interface FleetHeldSummary extends HeldSummary {
  devices: { device: string; total: number }[];
}

/** Merge several devices' held sets into one fleet roll-up, stamping each entry with its device so
 * `unmerged-commits` names where the work lives. Pure; the SSH fan-out is in the command layer. */
export function aggregateHeld(perDevice: DeviceHeld[]): FleetHeldSummary {
  const buckets = EMPTY_BUCKETS();
  const devices: { device: string; total: number }[] = [];
  let total = 0;
  for (const d of perDevice) {
    devices.push({ device: d.device, total: d.held.length });
    total += d.held.length;
    for (const w of d.held) buckets[w.bucket].push({ ...w, device: d.device } as HeldWorktree & { device: string });
  }
  return { total, buckets, devices };
}

interface PushResult {
  name: string;
  branch: string | null;
  pushed: boolean;
  reason: string;
}

/** Safe automatic action for `unmerged-commits`: publish the branch, never remove anything. Fails
 * closed: only if still `unmerged-commits`, only if the branch is not already on `origin` (no
 * force-update), only for slug-shaped names. No `--force`; failures are returned. */
export async function pushStrandedBranch(repoRoot: string, wt: HeldWorktree): Promise<PushResult> {
  const base: PushResult = { name: wt.name, branch: wt.branch, pushed: false, reason: '' };
  if (!WORKTREE_NAME_RE.test(wt.name)) return { ...base, reason: 'unsafe worktree name' };
  if (!wt.branch) return { ...base, reason: 'detached HEAD — no branch to push' };

  const defaultRef = await resolveDefaultRef(repoRoot);
  const unmerged = await countUnmergedCommits(wt.path, defaultRef);
  const fresh = classifyHeld({ branch: wt.branch, dirtyFiles: 0, unmergedCommits: unmerged });
  if (!fresh || fresh.bucket !== 'unmerged-commits') {
    return { ...base, reason: `no longer stranded (${fresh?.reason ?? 'clean'})` };
  }

  try {
    const ls = await git(repoRoot, ['ls-remote', '--heads', 'origin', wt.branch]);
    if (ls.length > 0) return { ...base, reason: 'branch already on origin' };
  } catch (err: any) {
    return { ...base, reason: `could not query origin: ${String(err?.stderr || err?.message || err).trim()}` };
  }

  try {
    await git(wt.path, ['push', '-u', 'origin', wt.branch]);
    return { ...base, pushed: true, reason: 'pushed to origin' };
  } catch (err: any) {
    return { ...base, reason: `push failed: ${String(err?.stderr || err?.message || err).trim()}` };
  }
}
