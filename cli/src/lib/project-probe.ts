/**
 * Project workspace probing — the drift signal behind `projects status`.
 *
 * Projects are natively multi-device: the same definition (home-relative paths)
 * re-roots on every fleet machine, and the question is whether the project's
 * repos are PRESENT on each box, on which branch, how far ahead/behind their
 * upstream, and whether they carry uncommitted changes. This module is the pure
 * local half: given a set of home-relative paths it probes each one with a
 * handful of read-only git calls. Drift is measured against the LAST-FETCHED
 * upstream (`@{upstream}`) — deliberately no `git fetch`, so a probe is fast
 * and offline-safe. The fleet half (`--fleet`) just runs this probe on every
 * peer via the canonical `remote-agents-json` SSH fan-out.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import chalk from 'chalk';
import { expandLocalHome, toHomeRelative } from './project-root.js';
import { projectProbeTargets, type ProjectDef } from './projects.js';

/** Per-call git budget. A read-only git call taking >3s is wedged by any
 * definition (NFS stall, index lock) — and the fleet fan-out SIGKILLs the SSH
 * hop at 12s, so a probe must fit inside that budget to avoid a slow peer
 * being misreported as unreachable: 3s × 5 calls leaves headroom even when
 * one repo is genuinely stuck. */
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

/**
 * Probe one workspace repo. A missing path yields `{present: false}` and no
 * git call is made. On a present repo every signal is best-effort: whatever
 * succeeded is reported, and a repo whose `.git` exists yet every git call
 * failed surfaces as present-with-error rather than silently clean.
 */
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

/**
 * The home-relative paths to probe for a project definition: its `root` plus
 * each `repos[].path` (the opt-in for additional repos), deduped. Every target
 * is normalized through the same `toHomeRelative(expandLocalHome(...))` the
 * probe echoes, so a hand-edited def (absolute path under home, trailing
 * slash) matches its probe rows exactly — `writeProjectDef` normalizes on
 * write, but defs are hand-editable YAML and never silently drop a row.
 *
 * The walk itself lives in `projects.ts` so the probe and the spawn grants read
 * one definition of "the project's directories" instead of two that drift.
 */
export function workspaceTargetsForDef(def: ProjectDef): string[] {
  return projectProbeTargets(def);
}

/**
 * Parse a peer's `projects probe` stdout, tagging each row with the
 * machine that answered. Defensive against version skew / partial output, the
 * same boundary contract as `parseRemoteActive`: non-JSON or a non-array
 * yields `[]`, and rows without a `path`/`present` core are dropped.
 */
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

/**
 * One workspace's compact state: `✓ clean · main`, `⚠ 12 dirty · ↑3 ↓1 ·
 * feature/x`, `✗ missing`, or `⚠ error: …`. Pure — chalk styling only.
 */
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

/**
 * The fleet view of one project's workspaces: one content line per probed
 * path (host-sorted `host: state` cells joined by ` · `), labelled with the
 * path when a project probes more than one. Pure — the caller adds the
 * `fleet` row label.
 */
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

/**
 * One-line fleet health summary — `6/13 clean · 4 behind · 4 dirty · 1 missing`.
 * Sits ABOVE the per-host {@link formatFleetWorkspaces} table so the card is
 * scannable without reading every host cell; the table keeps the per-host branch
 * and drift detail. Zero buckets are omitted. `behind` colours red when any host
 * is ≥10 behind (matching the footer's critical threshold), else yellow; a host
 * that is both behind and dirty counts in both. Each host×path row is one unit,
 * the same unit the table renders. Pure — chalk styling only.
 */
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

/**
 * Turn probed workspace rows into card-footer warnings, GROUPED by root cause so
 * a fleet where eight hosts drift is a few lines, not sixteen (each with its own
 * repeated remediation).
 *
 * - missing / unreadable git → critical (agents there cannot share a tree)
 * - behind upstream → critical when ANY host is ≥10 commits behind, else continue
 * - dirty tree → continue (local work is fine; just note it)
 * - ahead-only is not a warning (that is progress waiting to push)
 *
 * Within one probed path, all behind hosts collapse to one warning listing each
 * host with its count (`4 hosts behind origin/main — mac-mini ↓172, …`) plus one
 * shared remediation; a lone host keeps its full sentence. Missing and dirty
 * collapse the same way. `error` stays per-host (each message is distinct).
 * Grouping is per path so two different repos never merge into one count. Unlike
 * doctor's `emitGroup`, the list names EVERY host, not the first two — each
 * host's drift count differs and is individually actionable. Pure — chalk only.
 * Caller decides whether the rows came from `--fleet` or a local probe.
 */
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

