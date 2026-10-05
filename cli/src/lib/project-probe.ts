/** Project workspace probing behind `projects status`: read-only git calls per home-relative path
 * (presence, branch, ahead/behind, dirty). Drift is against the last-fetched upstream, deliberately
 * no `git fetch`, so it is fast and offline-safe. `--fleet` runs it on peers. */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import chalk from 'chalk';
import { expandLocalHome, toHomeRelative } from './project-root.js';
import { projectProbeTargets, type ProjectDef } from './projects.js';

/** Per-call git budget: a read-only git call over 3s is wedged (NFS stall, index lock), and the
 * fleet fan-out SIGKILLs the SSH hop at 12s, so 3s x 5 calls fits and a slow peer isn't
 * misreported as unreachable. */
const GIT_TIMEOUT_MS = 3_000;

/** The on-disk state of one workspace repo on one machine. */
interface RepoWorkspaceStatus {
  /** The probed path, echoed home-relative (re-roots per machine). */
  path: string;
  /** `.git` exists (a directory, or a FILE for a linked worktree). */
  present: boolean;
  branch?: string;
  /** The configured upstream ref (e.g. `origin/main`); absent → no upstream. */
  upstream?: string;
  /** Commits on HEAD not on the upstream. Undefined without an upstream. */
  ahead?: number;
  /** Commits on the upstream not on HEAD. Undefined without an upstream. */
  behind?: number;
  /** Uncommitted (incl. untracked) paths from `git status --porcelain`. */
  dirty?: number;
  /** ISO 8601 committer date of HEAD. */
  lastCommit?: string;
  /** `.git` exists but git could not read it — never looks silently clean. */
  error?: string;
}

/** A probe result tagged with the machine that answered (the fleet view). */
export interface HostWorkspaceStatus extends RepoWorkspaceStatus {
  host: string;
}

/** One read-only git call against `absPath`; undefined on any failure. */
function git(absPath: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', absPath, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/** Probe one workspace repo. A missing path yields `{present: false}` with no git call; on a present
 * repo each signal is best-effort, and a repo whose git calls all failed surfaces as
 * present-with-error, never silently clean. */
export function probeRepoWorkspace(absPath: string): RepoWorkspaceStatus {
  const status: RepoWorkspaceStatus = { path: toHomeRelative(absPath), present: false };
  if (!fs.existsSync(path.join(absPath, '.git'))) return status;
  status.present = true;

  const branch = git(absPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const upstream = git(absPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  // `--left-right --count A...B` prints "<left>\t<right>" — left is
  // upstream-only (we are BEHIND by that much), right is HEAD-only (AHEAD).
  const counts = upstream !== undefined
    ? git(absPath, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
    : undefined;
  const dirtyOut = git(absPath, ['status', '--porcelain']);
  const lastCommit = git(absPath, ['log', '-1', '--format=%cI']);

  if (branch === undefined && dirtyOut === undefined && lastCommit === undefined) {
    status.error = '.git exists but git could not read this repo';
    return status;
  }
  if (branch !== undefined) status.branch = branch;
  if (upstream !== undefined) status.upstream = upstream;
  if (counts !== undefined) {
    const [behind, ahead] = counts.split(/\s+/).map(Number);
    if (Number.isFinite(behind) && Number.isFinite(ahead)) {
      status.behind = behind;
      status.ahead = ahead;
    }
  }
  if (dirtyOut !== undefined) status.dirty = dirtyOut === '' ? 0 : dirtyOut.split('\n').length;
  if (lastCommit !== undefined) status.lastCommit = lastCommit;
  return status;
}

/** Probe each home-relative path (expanded against the local home), in order. */
export function probeProjectWorkspaces(paths: string[]): RepoWorkspaceStatus[] {
  return paths.map((p) => probeRepoWorkspace(expandLocalHome(p)));
}

/** Home-relative paths to probe for a def: `root` plus each `repos[].path`, deduped and normalized
 * as the probe echoes them so hand-edited defs match. The walk lives in `projects.ts` so probe and
 * spawn grants share one definition. */
export function workspaceTargetsForDef(def: ProjectDef): string[] {
  return projectProbeTargets(def);
}

/** Parse a peer's `projects probe` stdout, tagging rows with the machine. Defensive against version
 * skew (same contract as `parseRemoteActive`): non-JSON or a non-array yields `[]`, and rows
 * without a `path`/`present` core are dropped. */
export function parseRemoteProbe(stdout: string, machine: string): HostWorkspaceStatus[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((x) => {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      const o = x as Record<string, unknown>;
      if (typeof o.path === 'string' && typeof o.present === 'boolean') {
        return [{ ...(o as unknown as RepoWorkspaceStatus), host: machine }];
      }
    }
    return [];
  });
}

/** One workspace's compact state: `✓ clean · main`, `⚠ 12 dirty · ↑3 ↓1 · feature/x`, `✗ missing`,
 * or `⚠ error: …`. Pure apart from chalk. */
export function formatWorkspaceLine(s: RepoWorkspaceStatus): string {
  if (!s.present) return chalk.red('✗ missing');
  if (s.error) return chalk.yellow(`⚠ error: ${s.error}`);
  const parts: string[] = [];
  if (s.dirty !== undefined && s.dirty > 0) parts.push(`${s.dirty} dirty`);
  const drift = [
    s.ahead !== undefined && s.ahead > 0 ? `↑${s.ahead}` : '',
    s.behind !== undefined && s.behind > 0 ? `↓${s.behind}` : '',
  ].filter(Boolean).join(' ');
  if (drift) parts.push(drift);
  const head = parts.length > 0 ? chalk.yellow(`⚠ ${parts.join(' · ')}`) : chalk.green('✓ clean');
  return s.branch ? `${head} ${chalk.dim('·')} ${s.branch}` : head;
}

/** The fleet view of one project's workspaces: a line per probed path (host-sorted `host: state`
 * cells), labelled with the path when more than one. Pure; the caller adds the `fleet` row label. */
export function formatFleetWorkspaces(statuses: HostWorkspaceStatus[]): string[] {
  const paths = [...new Set(statuses.map((s) => s.path))];
  const multi = paths.length > 1;
  return paths.map((p) => {
    const rows = statuses
      .filter((s) => s.path === p)
      .sort((a, b) => a.host.localeCompare(b.host));
    const body = rows.map((r) => `${chalk.cyan(r.host)}: ${formatWorkspaceLine(r)}`).join(chalk.dim('  ·  '));
    return multi ? `${chalk.dim(`${p} · `)}${body}` : body;
  });
}

/** One-line fleet summary (`6/13 clean · 4 behind · 4 dirty · 1 missing`) above the per-host table;
 * zero buckets omitted. `behind` is red when any host is >=10 behind. A host behind and dirty
 * counts in both. Pure apart from chalk. */
export function formatFleetSummary(statuses: HostWorkspaceStatus[]): string {
  const total = statuses.length;
  let clean = 0;
  let behind = 0;
  let dirty = 0;
  let missing = 0;
  let hardBehind = false;
  for (const s of statuses) {
    if (!s.present) {
      missing++;
      continue;
    }
    if (s.error) continue; // unreadable — neither clean nor a drift bucket (surfaced in the footer)
    const isBehind = s.behind !== undefined && s.behind > 0;
    const isDirty = s.dirty !== undefined && s.dirty > 0;
    if (isBehind) {
      behind++;
      if (s.behind! >= 10) hardBehind = true;
    }
    if (isDirty) dirty++;
    if (!isBehind && !isDirty) clean++;
  }
  const parts = [chalk.green(`${clean}/${total} clean`)];
  if (behind) parts.push((hardBehind ? chalk.red : chalk.yellow)(`${behind} behind`));
  if (dirty) parts.push(chalk.yellow(`${dirty} dirty`));
  if (missing) parts.push(chalk.red(`${missing} missing`));
  return parts.join(chalk.dim(' · '));
}

/** Severity for a workspace/repo warning on the project card. */
type WorkspaceWarningSeverity = 'critical' | 'continue';

interface WorkspaceWarning {
  severity: WorkspaceWarningSeverity;
  text: string;
  remediation?: string;
}

/** Turn probed rows into footer warnings GROUPED by root cause so eight drifting hosts are a few
 * lines. Missing/unreadable git is critical; behind is critical at >=10 commits; dirty is
 * informational; ahead-only is none. Grouped per path, naming every host. */
export function workspaceWarnings(statuses: HostWorkspaceStatus[]): WorkspaceWarning[] {
  const out: WorkspaceWarning[] = [];
  const where = (s: HostWorkspaceStatus): string => (s.host ? s.host : 'local');
  const paths = [...new Set(statuses.map((s) => s.path))].sort((a, b) => a.localeCompare(b));
  for (const path of paths) {
    const pathBit = path ? ` (${path})` : '';
    const rows = statuses.filter((s) => s.path === path);
    const present = rows.filter((s) => s.present && !s.error);

    // Missing checkout — grouped critical, a lone host keeps its full sentence.
    const missing = rows.filter((s) => !s.present).sort((a, b) => where(a).localeCompare(where(b)));
    if (missing.length === 1) {
      out.push({
        severity: 'critical',
        text: `${where(missing[0])}: checkout missing${pathBit}`,
        remediation: 'clone or sync the project root on that host before landing agents there',
      });
    } else if (missing.length > 1) {
      out.push({
        severity: 'critical',
        text: `${missing.length} hosts missing checkout${pathBit} — ${missing.map(where).join(', ')}`,
        remediation: 'clone or sync the project root on those hosts before landing agents there',
      });
    }

    // Unreadable git — one per host, since each error message is distinct.
    for (const s of rows.filter((s) => s.present && s.error).sort((a, b) => where(a).localeCompare(where(b)))) {
      out.push({ severity: 'critical', text: `${where(s)}: ${s.error}${pathBit}` });
    }

    // Behind upstream — grouped, worst count first, one shared remediation.
    const behind = present
      .filter((s) => s.behind !== undefined && s.behind > 0)
      .sort((a, b) => (b.behind ?? 0) - (a.behind ?? 0) || where(a).localeCompare(where(b)));
    if (behind.length === 1) {
      const s = behind[0];
      out.push({
        severity: (s.behind ?? 0) >= 10 ? 'critical' : 'continue',
        text: `${where(s)} is ${s.behind} commit${s.behind === 1 ? '' : 's'} behind ${s.upstream ?? 'upstream'}${pathBit}`,
        remediation: 'pull (or rebase) before agents on this host open PRs against a stale base',
      });
    } else if (behind.length > 1) {
      const upstreams = new Set(behind.map((s) => s.upstream ?? 'upstream'));
      const upstream = upstreams.size === 1 ? [...upstreams][0] : 'upstream';
      const list = behind.map((s) => `${where(s)} ↓${s.behind}`).join(', ');
      out.push({
        severity: behind.some((s) => (s.behind ?? 0) >= 10) ? 'critical' : 'continue',
        text: `${behind.length} hosts behind ${upstream}${pathBit} — ${list}`,
        remediation: 'pull (or rebase) before agents on these hosts open PRs against a stale base',
      });
    }

    // Dirty tree — grouped, most changes first, no remediation (local work is fine).
    const dirty = present
      .filter((s) => s.dirty !== undefined && s.dirty > 0)
      .sort((a, b) => (b.dirty ?? 0) - (a.dirty ?? 0) || where(a).localeCompare(where(b)));
    if (dirty.length === 1) {
      const s = dirty[0];
      out.push({
        severity: 'continue',
        text: `${where(s)} has ${s.dirty} uncommitted change${s.dirty === 1 ? '' : 's'}${pathBit}`,
      });
    } else if (dirty.length > 1) {
      const list = dirty.map((s) => `${where(s)} ${s.dirty}`).join(', ');
      out.push({
        severity: 'continue',
        text: `${dirty.length} hosts with uncommitted changes${pathBit} — ${list}`,
      });
    }
  }
  return out;
}

