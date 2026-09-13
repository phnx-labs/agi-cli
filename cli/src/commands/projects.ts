/**
 * `agents projects` — named, multi-repo projects and the progress
 * rollup. Definitions live in `~/.agents/projects/<name>.yaml` (see
 * `lib/projects.ts`); this registers the command tree over them.
 *
 * The headline is `status`: instead of the vague per-agent activity line, it
 * rolls every session up by project (matched on cwd) into one card — agents by
 * lifecycle state, plan completion, open PRs, and tickets in flight.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';

import { setHelpSections } from '../lib/help.js';
import { getMainRepoRoot } from '../lib/git.js';
import { parseOwnerRepoFromRemote } from '../lib/registry.js';
import { truncate } from '../lib/format.js';
import { expandLocalHome, getProjectRoot, toHomeRelative } from '../lib/project-root.js';
import { machineId } from '../lib/machine-id.js';
import { getActiveSessions } from '../lib/session/active.js';
import { gatherRemoteActive } from '../lib/session/remote-active.js';
import { gatherRemoteAgentsJson } from '../lib/remote-agents-json.js';
import {
  formatFleetSummary,
  formatFleetWorkspaces,
  parseRemoteProbe,
  probeProjectWorkspaces,
  workspaceTargetsForDef,
  workspaceWarnings,
  type HostWorkspaceStatus,
} from '../lib/project-probe.js';
import {
  listProjectDefs,
  loadProjectDef,
  writeProjectDef,
  removeProjectDef,
  projectDefPath,
  isSafeProjectName,
  validateProjectDef,
  projectNameForCwd,
  projectRepoTargetsForDef,
  type ProjectDef,
  type ProjectContext,
  type ProjectGoal,
  type ProjectRepo,
  type ProjectRepoTarget,
} from '../lib/projects.js';
import {
  buildPullEnvelope,
  decodePullTargets,
  fingerprintTargets,
  pullLocalArgs,
  parseProjectPullEnvelope,
  printProjectPullSummary,
  projectPullComplete,
  pullProjectTargets,
} from '../lib/project-pull.js';
import {
  rollupSessionsByProject,
  withDefaultMachine,
  isDeadStatus,
  formatDeadSummary,
  liveDeadSplit,
  enrichProjectSignals,
  formatProjectMembersByHost,
  formatProjectWarnings,
  type ProjectSessionRollup,
  type ProjectRemoteSignals,
  type ProjectWarning,
} from '../lib/project-status.js';
import { fetchLinearProjectCounts, type LinearMilestone, type LinearProjectCounts } from '../lib/linear-project-counts.js';
import { listLinearProjects, nextLinearLink, pickLinearProject, type LinearPick, type LinearProjectLite } from '../lib/linear-projects.js';
import { checkRepoSlug } from '../lib/project-doctor.js';
import { formatFocusAreas, readFocusAreas, type FocusArea } from '../lib/project-focus.js';
import { formatVerdict, scheduleVerdict } from '../lib/project-schedule.js';
import {
  buildLinearImportCandidates,
  validateImportOpts,
  type ImportOptions,
  type ImportPlan,
  type RawImportFlags,
} from '../lib/project-import.js';

/** Recursion guard: a peer answering a probe fan-out never re-fans-out itself. */
const PROJECTS_NO_FANOUT_ENV = 'AGENTS_PROJECTS_LOCAL';

/** Max peers named in the skipped note before the rest collapse to `+N`. */
const SKIPPED_NAME_LIMIT = 4;

/**
 * A path-shaped `agents projects view` argument — `.`, `..`, a `~`-prefixed
 * value, or anything containing a path separator — means "auto-detect the
 * project for this DIRECTORY", not "a project named literally this". A bare
 * token (no separators) stays a project name, exactly as before.
 */
export function looksLikePath(token: string): boolean {
  return token === '.' || token === '..' || token.startsWith('~') || token.includes('/');
}

/** Machine-readable shape of `agents projects view <path> --json`. */
interface ViewDetection {
  /** Detected project name, or null when no definition contains the path. */
  name: string | null;
  /** The detected project's Linear binding; fields are null when unbound. */
  linear: { name: string | null; projectId: string | null };
  /** The detected project's repo/monorepo root (home-relative), or null. */
  root: string | null;
}

/**
 * Best-effort cwd->project detection for `agents projects view <path>`. Delegates
 * to the shared {@link projectNameForCwd} (def-root containment, longest wins),
 * then reads the matched definition's Linear binding and root so ONE call yields
 * the name AND the Linear projectId. Fail-open: an all-null shape when nothing
 * contains the path — never throws, so a scripted caller stays unscoped rather
 * than crashing. This subsumes the removed `agents projects for-cwd`.
 */
export function detectProjectForPath(cwd: string, defs: ProjectDef[]): ViewDetection {
  const name = projectNameForCwd(cwd, defs);
  const def = name ? defs.find((d) => d.name === name) : undefined;
  return {
    name: name ?? null,
    linear: {
      name: def?.linear?.name ?? null,
      projectId: def?.linear?.projectId ?? null,
    },
    root: def?.root ?? null,
  };
}

/**
 * One compact trailing note for peers that didn't answer the `--fleet`
 * fan-out — unreachable, running an agents-cli too old to carry `projects
 * probe`, or too slow to finish inside the 12s SSH budget. Mirrors
 * `formatUnreachableNote` (activity) with the probe-specific reasons; empty
 * string when everything answered.
 */
export function formatFleetSkippedNote(skipped: string[]): string {
  if (skipped.length === 0) return '';
  const named = skipped.slice(0, SKIPPED_NAME_LIMIT);
  const rest = skipped.length - named.length;
  const list = rest > 0 ? `${named.join(', ')} +${rest}` : named.join(', ');
  const noun = skipped.length === 1 ? 'device' : 'devices';
  return chalk.gray(`  · ${skipped.length} ${noun} didn't answer (unreachable, older agents-cli, or timed out): ${list}\n`);
}

/**
 * One compact trailing note for peers that DID answer a fan-out but whose
 * payload failed verification — a wrong machine id, a fingerprint that doesn't
 * match the targets we sent, or a malformed row. Deliberately separate from
 * {@link formatFleetSkippedNote}: silence means a peer never ran, while this
 * means it ran and we cannot trust what it reports, which is the worse state.
 * Empty string when every answer verified.
 */
export function formatFleetUnverifiedNote(unverified: string[]): string {
  if (unverified.length === 0) return '';
  const named = unverified.slice(0, SKIPPED_NAME_LIMIT);
  const rest = unverified.length - named.length;
  const list = rest > 0 ? `${named.join(', ')} +${rest}` : named.join(', ');
  const noun = unverified.length === 1 ? 'device' : 'devices';
  return chalk.red(`  · ${unverified.length} ${noun} answered with a result that could not be verified: ${list}\n`);
}

/** `path:purpose` → a context anchor. Purpose may contain colons. */
function parseContextFlag(raw: string): ProjectContext {
  const i = raw.indexOf(':');
  if (i === -1) return { path: raw.trim(), purpose: '' };
  return { path: raw.slice(0, i).trim(), purpose: raw.slice(i + 1).trim() };
}

/** `objective:measure` → a goal. The measure is optional; the objective may contain colons only after the first is claimed. */
function parseGoalFlag(raw: string): ProjectGoal {
  const i = raw.indexOf(':');
  if (i === -1) return { objective: raw.trim() };
  const measure = raw.slice(i + 1).trim();
  const goal: ProjectGoal = { objective: raw.slice(0, i).trim() };
  if (measure) goal.measure = measure;
  return goal;
}

/**
 * Best-effort `owner/repo` from a repo's origin remote.
 *
 * `stderr: 'ignore'` is load-bearing, not tidiness. A checkout with no origin
 * makes git print `error: No such remote 'origin'` on ITS stderr, which is the
 * terminal's — the catch below never sees it. Absence of a remote is an
 * expected answer here (`undefined`), not something to report.
 */
export function originSlug(cwd: string): string | undefined {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return parseOwnerRepoFromRemote(url) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turn a `--dir` / `--add-dir` value into a `repos[]` row.
 *
 * The slug comes from the DIRECTORY'S OWN origin remote, never from its path:
 * a checkout at `~/src/github.com/muqsitnawaz/agents-cli` whose origin is
 * `phnx-labs/agents-cli` must record the remote it actually pushes to. Pass
 * `slugOverride` for a directory with no origin (a vendored tree, a fresh
 * `git init`).
 *
 * The stored `path` is left for `writeProjectDef` to normalize home-relative,
 * so the same definition re-roots on every machine.
 */
export function projectRepoFromDir(
  dir: string,
  slugOverride?: string,
): { ok: true; repo: ProjectRepo } | { ok: false; error: string } {
  const abs = path.resolve(expandLocalHome(dir));
  if (!fs.existsSync(abs)) return { ok: false, error: `No such directory: ${abs}` };
  if (!fs.statSync(abs).isDirectory()) return { ok: false, error: `Not a directory: ${abs}` };

  const slug = slugOverride ?? originSlug(abs);
  if (!slug) {
    return {
      ok: false,
      error:
        `${abs} has no origin remote, so its slug cannot be inferred.\n` +
        `  Name it explicitly: --add-dir ${dir} --slug <owner/repo>`,
    };
  }
  return { ok: true, repo: { slug, path: toHomeRelative(abs) } };
}

/**
 * List the workspace's Linear projects and plan their import, binding each to a
 * local checkout under the configured projects root when the names match
 * exactly. A missing / logged-out `linear` CLI is loud (this is an explicit user
 * command), and nothing is written before the whole plan is built.
 */
function runLinearImport(existing: Map<string, ProjectDef>, opts: ImportOptions): ImportPlan {
  let list: LinearProjectLite[];
  try {
    list = listLinearProjects();
  } catch (e) {
    console.error(chalk.red(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }
  // No projects root configured (or unreadable) → no local matching; every def
  // still imports, carrying its Linear link and nothing it can't prove.
  const rootAbs = getProjectRoot() ? expandLocalHome(getProjectRoot()!) : undefined;
  let localDirs: string[] = [];
  if (rootAbs) {
    try {
      localDirs = fs
        .readdirSync(rootAbs, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name);
    } catch {
      localDirs = [];
    }
  }
  return buildLinearImportCandidates(list, existing, {
    localDirs,
    resolveRoot: (dir) => (rootAbs ? toHomeRelative(path.join(rootAbs, dir)) : undefined),
    resolveOrigin: (dir) => (rootAbs ? originSlug(path.join(rootAbs, dir)) : undefined),
  }, opts);
}

/** One `projects list` row, pre-render. */
export interface ProjectListRow {
  name: string;
  path: string;
  repo: string;
}

/** Longest path a `list` row shows before it truncates. */
const LIST_PATH_MAX = 48;

/**
 * Column widths for `projects list`, sized to the rows actually being printed.
 * Fixed padding was the bug: home-relative roots run past 50 characters, so a
 * hardcoded 32 pushed the repo column off its gridline on every long path.
 * Paths longer than {@link LIST_PATH_MAX} truncate rather than widen the table.
 */
export function computeProjectListWidths(rows: ProjectListRow[]): { name: number; path: number; repo: number } {
  const widest = (pick: (r: ProjectListRow) => string, cap: number) =>
    Math.min(cap, rows.reduce((w, r) => Math.max(w, pick(r).length), 0));
  return {
    name: widest((r) => r.name, 64),
    path: widest((r) => r.path, LIST_PATH_MAX),
    repo: widest((r) => r.repo, 64),
  };
}

/**
 * A milestone's target date as a person would say it — "due tomorrow",
 * "overdue by 3 days", "due Aug 21" — never a raw `2026-08-21` or a duration in
 * hours. Linear stores a calendar date with no timezone, so both sides are
 * compared at LOCAL midnight; parsing `YYYY-MM-DD` with `new Date(str)` would
 * read it as UTC and shift the answer by a day for anyone west of Greenwich.
 */
export function formatMilestoneDue(targetDate: string, nowMs: number): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(targetDate.trim());
  if (!m) return undefined;
  const due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(due.getTime())) return undefined;
  const now = new Date(nowMs);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  if (days === -1) return 'overdue by a day';
  if (days < 0) return `overdue by ${-days} days`;
  if (days <= 14) return `due in ${days} days`;
  const sameYear = due.getFullYear() === today.getFullYear();
  const label = due.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  return `due ${label}`;
}

/**
 * The milestone block. `status` prints one line — the next checkpoint — because
 * a roll-up across projects has to stay scannable. `view` prints every declared
 * milestone, because "how many are there and when are they due" is the shape of
 * the plan and the reason to open one project.
 *
 * Pure (chalk only) so the layout is testable without a Linear account.
 */
export function formatMilestoneLines(
  milestones: LinearMilestone[],
  next: LinearMilestone | undefined,
  nowMs: number,
  limit: number,
): string[] {
  if (milestones.length === 0) {
    // `next` without a list only happens on a cached answer written before the
    // list existed; render what we have rather than dropping the row.
    return next ? [`  ${chalk.dim('next')}     ${formatNextMilestone(next, nowMs)}`] : [];
  }
  // The next milestone leads, always. Linear can flag a LATER-dated milestone
  // as next, and `milestones` is date-ordered — so slicing the front would show
  // an earlier one and hide the actual next behind "+N more", which is the one
  // thing this row exists to say. Identity is name+targetDate: two milestones
  // can share a name, and matching on name alone labelled the wrong row.
  const key = (m: LinearMilestone) => `${m.name}${m.targetDate ?? ''}`;
  const lead = next ? milestones.filter((m) => key(m) === key(next)).slice(0, 1) : [];
  const others = next ? milestones.filter((m) => key(m) !== key(next)) : milestones;
  const ordered = [...lead, ...others];
  const shown = ordered.slice(0, Math.max(1, limit));
  const out = shown.map((m, i) => {
    const label = i === 0 && lead.length > 0 ? 'next' : i === 0 ? 'plan' : '';
    return `  ${chalk.dim(label.padEnd(4))}     ${formatNextMilestone(m, nowMs)}`;
  });
  const rest = milestones.length - shown.length;
  if (rest > 0) {
    out.push(`  ${' '.repeat(4)}     ${chalk.dim(`+${rest} more milestone${rest === 1 ? '' : 's'} — agents projects view <name>`)}`);
  }
  return out;
}

/** The `next` card line: what this project is due to hit, and how far along it is. */
export function formatNextMilestone(ms: LinearMilestone, nowMs: number): string {
  const parts = [chalk.bold(ms.name)];
  // A milestone with nothing filed under it yet has no progress to report —
  // `0/0` is noise, not information.
  if (ms.total > 0) parts.push(`${ms.done}/${ms.total}`);
  const due = ms.targetDate ? formatMilestoneDue(ms.targetDate, nowMs) : undefined;
  if (due) parts.push(due.startsWith('overdue') ? chalk.yellow(due) : chalk.dim(due));
  return parts.join(chalk.dim('  ·  '));
}

function statusBar(r: ProjectSessionRollup): string {
  const parts: string[] = [];
  const push = (n: number | undefined, label: string, color: (s: string) => string) => {
    if (n && n > 0) parts.push(color(`${n} ${label}`));
  };
  push(r.byStatus.running, 'running', chalk.green);
  push(r.byStatus.idle, 'idle', chalk.gray);
  push(r.byStatus.input_required, 'need-input', chalk.yellow);
  push(r.byStatus.queued, 'queued', chalk.gray);
  const shown =
    (r.byStatus.running ?? 0) + (r.byStatus.idle ?? 0) + (r.byStatus.input_required ?? 0) + (r.byStatus.queued ?? 0);
  // The remainder is the LIVE sessions in a state without its own chip
  // (orphaned, unknown). Dead ones are on their own row now, so counting them
  // here made the line disagree with the headline — `19 live` beside
  // `+24 other`, which invites the reader to trust neither.
  const live = liveDeadSplit(r.byStatus).live;
  if (live > shown) parts.push(chalk.gray(`+${live - shown} other`));
  return parts.join(' · ') || chalk.gray('no live agents');
}

/** Everything a project card needs beyond the stored definition. */
interface ProjectRenderData {
  roll: Map<string, ProjectSessionRollup>;
  remote: Map<string, ProjectRemoteSignals>;
  linear: Map<string, LinearProjectCounts>;
  focus: Map<string, FocusArea[]>;
}

/**
 * Gather the live/remote/Linear/focus signals for the projects about to be
 * rendered. `status` and `view` share this deliberately: `view` used to build
 * its own thinner picture, so the command you open to learn everything about
 * ONE project showed strictly less than the roll-up across all of them — no
 * agents, no ships, no focus, no schedule verdict. One gatherer means a signal
 * added for either surface appears on both.
 *
 * Only the shown projects are enriched. `skipRemote` still reads the local
 * artifact log and git focus, and skips just the network calls (`gh`, Linear).
 */
async function enrichProjectsForRender(
  defs: ProjectDef[],
  all: ProjectDef[],
  opts: {
    windowDays: number;
    nowMs: number;
    skipRemote: boolean;
    extraSessions?: Awaited<ReturnType<typeof getActiveSessions>>;
  },
): Promise<ProjectRenderData> {
  // Local getActiveSessions() leaves `machine` unset (the sessions renderer
  // falls back to this box). Host-grouped agents need an explicit stamp so
  // under `--fleet` this box does not render as `@local` next to peers that
  // carry real device ids.
  const local = withDefaultMachine(await getActiveSessions(), machineId());
  const roll = rollupSessionsByProject(all, [...local, ...(opts.extraSessions ?? [])]);
  const remote = new Map<string, ProjectRemoteSignals>();
  const linear = new Map<string, LinearProjectCounts>();
  // Local git, no API, no rate limit — measured 0.23s over a 897-commit week.
  const focus = new Map<string, FocusArea[]>();
  await Promise.all(
    defs.map(async (d) => {
      const [sig, counts] = await Promise.all([
        enrichProjectSignals(d, opts.windowDays, opts.nowMs, { skipRemote: opts.skipRemote }),
        !opts.skipRemote && d.linear?.projectId
          ? fetchLinearProjectCounts(d.linear.projectId)
          : Promise.resolve(undefined),
      ]);
      remote.set(d.name, sig);
      if (counts) linear.set(d.name, counts);
      if (d.root) focus.set(d.name, await readFocusAreas(expandLocalHome(d.root), opts.windowDays));
    }),
  );
  return { roll, remote, linear, focus };
}

function renderCard(
  def: ProjectDef,
  r: ProjectSessionRollup | undefined,
  remote: ProjectRemoteSignals | undefined,
  fleet?: HostWorkspaceStatus[],
  linear?: LinearProjectCounts,
  nowMs: number = Date.now(),
  /** How many milestones to print. `status` shows the next one; `view` shows all. */
  milestoneLimit: number = 1,
  /** Directories the window's work landed in, from local git. */
  focus: FocusArea[] = [],
  /** `view` mode: the caller prints the stored definition in full afterwards. */
  detail: boolean = false,
  /**
   * Workspace probe rows used only for the warnings footer. May be the full
   * `--fleet` set or a local-only probe so drift is never silent by default.
   */
  warnWorkspaces: HostWorkspaceStatus[] = [],
): void {
  // The headline counts LIVE agents. It used to be every matched session, which
  // read `39 agents` on a project where 19 had crashed. `planPct` used to sit
  // here too and is gone: it summed each session's latest checklist snapshot,
  // so one agent opening a fresh 40-item plan rendered the whole project `0%`.
  const split = r ? liveDeadSplit(r.byStatus) : { live: 0, dead: 0, deadByStatus: [] };
  console.log(`${chalk.bold(def.name)}  ${chalk.dim('·')}  ${chalk.bold(`${split.live} live`)}`);
  if (def.description) console.log(`  ${chalk.dim(def.description)}`);
  console.log(`  ${chalk.dim('live')}     ${r ? statusBar(r) : chalk.gray('no live agents')}`);
  if (split.dead > 0) {
    // Wreckage is worth a number of its own — 19 crashed sessions is a thing to
    // go fix, not a throughput signal to fold into the headline.
    console.log(`  ${chalk.dim('dead')}     ${formatDeadSummary(split)}`);
  }
  // Live only, grouped by host when machine stamps exist so "who is on which
  // box" is visible. Flat collapse hid that when harness×status matched across hosts.
  const liveMembers = r?.members.filter((m) => !isDeadStatus(m.status)) ?? [];
  if (liveMembers.length) {
    const agentLines = formatProjectMembersByHost(liveMembers);
    agentLines.forEach((line, i) => {
      console.log(`  ${chalk.dim((i === 0 ? 'agents' : '').padEnd(7))}  ${line}`);
    });
  }
  const ships: string[] = [];
  if (remote?.mergedPrs) {
    ships.push(chalk.green(`${remote.mergedPrs}${remote.mergedPrsTruncated ? '+' : ''} merged (${remote.windowDays}d)`));
  }
  if (r?.openPrs.length) ships.push(`${r.openPrs.length} open PR${r.openPrs.length === 1 ? '' : 's'}`);
  if (r?.worktrees) ships.push(`${r.worktrees} worktree${r.worktrees === 1 ? '' : 's'}`);
  if (remote?.latestRelease) ships.push(remote.latestRelease.tag);
  if (ships.length) console.log(`  ${chalk.dim('ships')}    ${ships.join(' · ')}`);
  if (linear) {
    const pct = linear.total > 0 ? ` ${chalk.dim(`(${Math.round((linear.done / linear.total) * 100)}%)`)}` : '';
    console.log(
      `  ${chalk.dim('linear')}   ${linear.done}/${linear.total}${linear.truncated ? '+' : ''} done${pct} · ${linear.inProgress} in progress`,
    );
  }
  for (const line of formatMilestoneLines(linear?.milestones ?? [], linear?.nextMilestone, nowMs, milestoneLimit)) {
    console.log(line);
  }
  // Informational schedule only. Warn-level verdicts land in the footer so the
  // bottom of the card is the one place you look for "what needs attention".
  const verdict = linear?.milestones?.length ? formatVerdict(scheduleVerdict(linear.milestones, nowMs)) : undefined;
  if (verdict && !verdict.warn) {
    console.log(`  ${chalk.dim('schedule')} ${verdict.text}`);
  }
  if (focus.length) {
    const windowDays = remote?.windowDays ?? 7;
    console.log(`  ${chalk.dim('focus')}    ${formatFocusAreas(focus, windowDays)}`);
  }
  if (r && r.tickets.length) {
    console.log(`  ${chalk.dim('tickets')}  ${r.tickets.slice(0, 8).join(' · ')}${r.tickets.length > 8 ? ' …' : ''}`);
  }
  if (fleet) {
    const table = formatFleetWorkspaces(fleet);
    if (table.length === 0) {
      console.log(`  ${chalk.dim('fleet')}    ${chalk.gray('no workspace paths (set root or repos[].path)')}`);
    } else {
      // A compact health line first (scan without reading every host), then the
      // full per-host table under it. The grouped footer carries the actionable
      // subset; this line + the table carry the whole picture.
      [formatFleetSummary(fleet), ...table].forEach((line, i) => {
        console.log(`  ${chalk.dim((i === 0 ? 'fleet' : '').padEnd(5))}    ${line}`);
      });
    }
  }
  if (remote?.artifacts) {
    const last = remote.lastArtifact ? `  ${chalk.dim(`· last: ${remote.lastArtifact}`)}` : '';
    console.log(`  ${chalk.dim('proof')}    ${remote.artifacts} artifact${remote.artifacts === 1 ? '' : 's'} (${remote.windowDays}d)${last}`);
  }
  const repos = [def.repo, ...(def.repos ?? []).map((x) => x.slug)].filter(Boolean) as string[];
  if (repos.length) console.log(`  ${chalk.dim('repos')}    ${[...new Set(repos)].join(' · ')}`);

  // Warnings footer — critical (🔴) then continue (⚠️). Sources: repo slug
  // mismatch, workspace drift/dirty/missing, schedule that cannot measure.
  const warnings: ProjectWarning[] = [];
  const mismatch = def.root ? checkRepoSlug(def, originSlug(expandLocalHome(def.root))) : undefined;
  if (mismatch) {
    warnings.push({ severity: 'critical', text: mismatch.message, remediation: mismatch.remediation });
  }
  for (const w of workspaceWarnings(warnWorkspaces)) {
    warnings.push(w);
  }
  if (verdict?.warn) {
    warnings.push({ severity: 'continue', text: verdict.text });
  }
  if (split.dead > 0 && (split.deadByStatus.find((d) => d.status === 'crashed')?.n ?? 0) > 0) {
    const crashed = split.deadByStatus.find((d) => d.status === 'crashed')!.n;
    warnings.push({
      severity: crashed >= 10 ? 'critical' : 'continue',
      text: `${crashed} crashed session${crashed === 1 ? '' : 's'} on this project`,
      remediation: 'inspect with agents sessions --active / clean up stuck worktrees',
    });
  }
  for (const line of formatProjectWarnings(warnings)) console.log(line);

  // `view` prints these in full (path + purpose, label + URL) right below, so
  // the compact one-line summaries would just say the same thing twice.
  if (!detail && def.goals?.length) {
    console.log(`  ${chalk.dim('goal')}     ${def.goals.map((g) => g.objective).join(' · ')}`);
  }
  if (!detail && def.contexts?.length) {
    console.log(`  ${chalk.dim('context')}  ${def.contexts.map((c) => c.path).join(' · ')}`);
  }
  if (!detail && def.integrations?.length) {
    console.log(`  ${chalk.dim('links')}    ${def.integrations.map((i) => i.label ?? i.kind).join(' · ')}`);
  }
  if (!detail) console.log('');
}

/** Options shared by `status` and `view`. */
type ProjectCardOpts = {
  json?: boolean;
  window?: string;
  remote?: boolean;
  /** Scope the fleet fan-out to specific devices; undefined = the whole fleet. */
  deviceFilter?: string[];
};

/**
 * Merge `--device a b` (variadic) and `--devices a,b,c` (comma list) into one
 * deduped device filter; undefined when neither was given (= whole fleet).
 */
function resolveDeviceFilter(device?: string[], devices?: string): string[] | undefined {
  const merged = [
    ...(device ?? []),
    ...(devices ? devices.split(',').map((s) => s.trim()).filter(Boolean) : []),
  ];
  return merged.length ? [...new Set(merged)] : undefined;
}

/** Print the YAML-side fields that sit under the shared card in `view` mode. */
function printProjectDefinition(def: ProjectDef, name: string): void {
  console.log();
  if (def.root) console.log(`  ${chalk.dim('root')}     ${def.root}`);
  if (def.defaultPath) console.log(`  ${chalk.dim('path')}     ${def.defaultPath}`);
  for (const rp of def.repos ?? []) {
    const where = [rp.subpath ? `subpath ${rp.subpath}` : undefined, rp.path].filter(Boolean).join(' · ');
    console.log(`  ${chalk.dim('repo')}     ${rp.slug}${where ? chalk.dim(`  (${where})`) : ''}`);
  }
  for (const g of def.goals ?? []) console.log(`  ${chalk.dim('goal')}     ${g.objective}${g.measure ? chalk.dim(`  · ${g.measure}`) : ''}`);
  for (const c of def.contexts ?? []) console.log(`  ${chalk.dim('context')}  ${chalk.cyan(c.path)} ${chalk.dim('—')} ${c.purpose}`);
  for (const ig of def.integrations ?? []) {
    console.log(`  ${chalk.dim(ig.kind.padEnd(8))} ${ig.url}${ig.label ? chalk.dim(`  (${ig.label})`) : ''}`);
  }
  if (def.linear?.url || def.linear?.projectId || def.linear?.name) {
    const ref = def.linear.url ?? def.linear.projectId;
    const label = def.linear.name ? chalk.cyan(def.linear.name) : '';
    console.log(`  ${chalk.dim('linear')}   ${[label, ref && chalk.dim(ref)].filter(Boolean).join('  ')}`);
  }
  for (const d of def.docs ?? []) console.log(`  ${chalk.dim('doc')}      ${d}`);
  console.log(chalk.gray(`  ${projectDefPath(name)}`));
}

export function registerProjectsCommands(program: Command): void {
  const projects = program
    .command('projects')
    .description('Named multi-repo projects with a progress rollup.');

  setHelpSections(projects, {
    examples: `
      agents projects import --from-linear  # the projects you actually track
      agents projects add rush --repo phnx-labs/rush --path apps/web
      agents projects add rush --root ~/src/rush --dir ~/src/rush-infra  # bind another dir
      agents projects set rush --add-dir ~/.agents/.system  # bind one more
      agents projects set rush --rm-dir ~/src/rush-infra    # unbind it again
      agents projects list                 # definitions only (no session scan)
      agents projects list --with-agents   # opt-in local active counts
      agents projects list --json          # machine-readable defs (AGI EXT uses this)
      echo '{...}' | agents projects save --json  # create/update one def from stdin
      agents projects remove rush --json   # machine-readable removal
      agents projects status              # every project, across the whole fleet
      agents projects status rush         # one project (same body as view)
      agents projects view rush           # alias of status <name>
      agents projects status --device s0  # scope to one device (or --devices a,b,c)
      agents projects link rush --linear  # bind the Linear project (auto-suggest)
      agents run --project rush           # land an agent in the project
    `,
    notes: `
      Definitions are hand-editable YAML in ~/.agents/projects/ and sync across
      machines with 'agents repo push user' / 'agents repo pull user'. AGI EXT
      reads and writes only through these commands — never
      ~/.agents/factory/projects.json.

      A project may bind several directories ('--dir' / '--add-dir'). The cwd an
      agent lands in is 'defaultPath' (else 'root') — set it with --root/--path,
      not with --dir. Every bound directory other than that cwd rides along as
      an --add-dir grant (Claude, Codex, Cursor, Kimi, Grok consume it; others ignore).
    `,
  });

  // ---- list ----
  projects
    .command('list')
    .description('List defined projects (definitions only by default; no session scan).')
    .option('--json', 'Machine-readable output')
    .option('--with-agents', 'Include local active agent counts (opt-in; never SSH)')
    .action(async (opts: { json?: boolean; withAgents?: boolean }) => {
      const defs = listProjectDefs();
      // Definitions-only by default: zero session scan / SSH. --with-agents is
      // an explicit opt-in for local active counts only (getActiveSessions is
      // local; it never fans out).
      const roll = opts.withAgents
        ? rollupSessionsByProject(defs, await getActiveSessions())
        : undefined;
      if (opts.json) {
        console.log(
          JSON.stringify(
            opts.withAgents
              ? defs.map((d) => ({ ...d, agents: roll!.get(d.name)?.agents ?? 0 }))
              : defs,
            null,
            2,
          ),
        );
        return;
      }
      if (!defs.length) {
        console.log(chalk.gray('No projects defined. Add one: agents projects add <name>'));
        return;
      }
      const rows: ProjectListRow[] = defs.map((d) => ({
        name: d.name,
        path: truncate(d.root ?? d.defaultPath ?? '', LIST_PATH_MAX),
        repo: d.repo ?? d.repos?.[0]?.slug ?? '',
      }));
      const w = computeProjectListWidths(rows);
      for (const [i, d] of defs.entries()) {
        const row = rows[i];
        const agentsSuffix =
          opts.withAgents && roll ? ` ${roll.get(d.name)?.agents ?? 0} agents` : '';
        console.log(
          `  ${chalk.bold(row.name.padEnd(w.name))} ${chalk.dim(row.path.padEnd(w.path))} ${chalk.cyan(row.repo.padEnd(w.repo))}${agentsSuffix}`,
        );
      }
    });

  // ---- add ----
  projects
    .command('add <name>')
    .description('Define a project. Infers root and repo from the current git repo when not given.')
    .option('--root <path>', 'Repo / monorepo root (defaults to the current git repo root)')
    .option('--path <subdir>', 'Default cwd for agents (a monorepo subdir)')
    .option('--repo <owner/repo>', 'Primary GitHub slug (defaults to the origin remote)')
    .option('--dir <path...>', 'A directory this project binds; slug read from its origin. Repeatable')
    .option('--context <path:purpose...>', 'A described starting point; repeatable')
    .option('--goal <objective:measure...>', 'An outcome the project serves; repeatable')
    .option('--linear <url-or-id>', 'Linear project URL or id')
    .option('--force', 'Overwrite an existing definition')
    .action(
      async (
        name: string,
        opts: { root?: string; path?: string; repo?: string; dir?: string[]; context?: string[]; goal?: string[]; linear?: string; force?: boolean },
      ) => {
        if (!isSafeProjectName(name)) {
          console.error(chalk.red(`Invalid project name: "${name}" (letters, digits, ., _, - only)`));
          process.exit(1);
        }
        if (loadProjectDef(name) && !opts.force) {
          console.error(chalk.red(`Project "${name}" already exists. Use --force to overwrite, or 'agents projects edit ${name}'.`));
          process.exit(1);
        }
        const cwd = process.cwd();
        let root = opts.root;
        if (!root) {
          try {
            root = toHomeRelative(await getMainRepoRoot(cwd));
          } catch {
            console.error(chalk.red('Not inside a git repo — pass --root <path> explicitly.'));
            process.exit(1);
          }
        }
        const repo = opts.repo ?? originSlug(cwd);
        const def: ProjectDef = { name, root };
        if (opts.path) def.defaultPath = `${root!.replace(/\/$/, '')}/${opts.path.replace(/^\//, '')}`;
        if (repo) def.repo = repo;
        if (opts.dir?.length) {
          const repos: ProjectRepo[] = [];
          for (const d of opts.dir) {
            const r = projectRepoFromDir(d);
            if (!r.ok) {
              console.error(chalk.red(r.error));
              process.exit(1);
            }
            repos.push(r.repo);
          }
          def.repos = repos;
        }
        if (opts.context?.length) def.contexts = opts.context.map(parseContextFlag);
        if (opts.goal?.length) def.goals = opts.goal.map(parseGoalFlag);
        if (opts.linear) {
          def.linear = /^https?:/.test(opts.linear) ? { url: opts.linear } : { projectId: opts.linear };
        }
        const target = writeProjectDef(def);
        console.log(chalk.green(`Defined project "${name}"`));
        console.log(chalk.gray(`  ${target}`));
        console.log(chalk.gray(`  root ${def.root}${def.repo ? `  ·  repo ${def.repo}` : ''}`));
        for (const r of def.repos ?? []) console.log(chalk.gray(`  dir  ${r.path}  ·  ${r.slug}`));
      },
    );

async function runProjectCard(
    name: string | undefined,
    opts: ProjectCardOpts,
    mode: 'status' | 'view',
  ): Promise<void> {
    const detail = mode === 'view';
    const all = listProjectDefs();
    // Named lookup goes through the strict single-def loader so a broken
    // <name>.yaml surfaces its validation error instead of "No project named".
    const defs = name ? [loadProjectDef(name)].filter((d): d is ProjectDef => d !== undefined) : all;
    if (name && !defs.length) {
      console.error(
        chalk.red(
          detail
            ? `No project named "${name}". List them: agents projects list`
            : `No project named "${name}".`,
        ),
      );
      process.exit(1);
    }
    if (!defs.length) {
      if (opts.json) console.log('[]');
      else console.log(chalk.gray('No projects defined. Add one: agents projects add <name>'));
      return;
    }
    const windowDays = Math.max(1, Number.parseInt(opts.window ?? '7', 10) || 7);
    const nowMs = Date.now();

    // Fleet is the default: probe each shown def's workspace paths (root +
    // repos[].path) locally AND on every peer in one parallel SSH round, and
    // widen the live-session rollup to the fleet via the sessions fan-out.
    // `--device`/`--devices` scopes the remote fan-out to a subset; with no
    // filter every registered device is dialled.
    const fleetTargets = [...new Set(defs.flatMap(workspaceTargetsForDef))];
    let fleetWs: HostWorkspaceStatus[] = [];
    let fleetSkipped: string[] = [];
    let fleetSessions: Awaited<ReturnType<typeof getActiveSessions>> = [];
    {
      const self = machineId();
      fleetWs.push(...probeProjectWorkspaces(fleetTargets).map((s) => ({ ...s, host: self })));
      const [probeRes, activeRes] = await Promise.all([
        fleetTargets.length > 0
          ? gatherRemoteAgentsJson({
              args: ['projects', 'probe', ...fleetTargets],
              noFanoutEnv: PROJECTS_NO_FANOUT_ENV,
              hosts: opts.deviceFilter,
              parse: parseRemoteProbe,
              quiet: true,
            })
          : Promise.resolve({ items: [] as HostWorkspaceStatus[], deviceCount: 0, skipped: [] as string[] }),
        gatherRemoteActive(opts.deviceFilter, { quiet: true }),
      ]);
      fleetWs.push(...probeRes.items);
      fleetSkipped = probeRes.skipped;
      fleetSessions = activeRes.sessions;
    }

    const { roll, remote, linear, focus } = await enrichProjectsForRender(defs, all, {
      windowDays,
      nowMs,
      skipRemote: opts.remote === false,
      extraSessions: fleetSessions,
    });

    /** This def's slice of the fleet probe, in its own target order. */
    const fleetFor = (d: ProjectDef): HostWorkspaceStatus[] => {
      const targets = new Set(workspaceTargetsForDef(d));
      return fleetWs.filter((s) => targets.has(s.path));
    };

    if (opts.json) {
      if (fleetSkipped.length > 0) process.stderr.write(formatFleetSkippedNote(fleetSkipped));
      // `view` used to nest the def fields at the top level and omit plan /
      // worktrees / windowDays; keep one machine shape for both verbs so a
      // consumer that switches `status`↔`view` does not re-learn the schema.
      console.log(
        JSON.stringify(
          defs.map((d) => {
            const r = roll.get(d.name);
            const rem = remote.get(d.name);
            const counts = linear.get(d.name);
            return {
              ...(detail ? d : { name: d.name }),
              agents: r?.agents ?? 0,
              byStatus: r?.byStatus ?? {},
              members: r?.members ?? [],
              plan: r?.plan ?? { done: 0, total: 0 },
              schedule: counts?.milestones?.length ? scheduleVerdict(counts.milestones, nowMs) : null,
              focus: focus.get(d.name) ?? [],
              live: r ? liveDeadSplit(r.byStatus).live : 0,
              dead: r ? liveDeadSplit(r.byStatus).dead : 0,
              openPrs: r?.openPrs ?? [],
              mergedPrs: rem?.mergedPrs ?? 0,
              latestRelease: rem?.latestRelease ?? null,
              linear: detail ? { ...d.linear, ...(counts ?? {}) } : (counts ?? null),
              tickets: r?.tickets ?? [],
              worktrees: r?.worktrees ?? 0,
              artifacts: rem?.artifacts ?? 0,
              lastArtifact: rem?.lastArtifact ?? null,
              windowDays,
              repos: [d.repo, ...(d.repos ?? []).map((r2) => r2.slug)].filter(Boolean),
              workspaces: fleetFor(d),
            };
          }),
          null,
          2,
        ),
      );
      return;
    }

    // Compact rollup shows the next milestone; `view` shows every declared one.
    const milestoneLimit = detail ? Number.POSITIVE_INFINITY : 1;
    // Stamp the fleet-wide rollup with when it was taken, so a scrollback isn't
    // mistaken for a live snapshot. A single named `view` skips it (one card, and
    // its own detail makes the freshness obvious).
    if (!detail) {
      const t = new Date(nowMs);
      const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
      console.log(chalk.dim(`fleet snapshot · as of ${hhmm}`));
      console.log('');
    }
    for (const d of defs) {
      renderCard(
        d,
        roll.get(d.name),
        remote.get(d.name),
        fleetFor(d),
        linear.get(d.name),
        nowMs,
        milestoneLimit,
        focus.get(d.name) ?? [],
        detail,
        // Always feed workspace rows into the warnings footer so behind/dirty
        // is never silent.
        fleetFor(d),
      );
      if (detail) printProjectDefinition(d, d.name);
    }
    if (fleetSkipped.length > 0) process.stdout.write(formatFleetSkippedNote(fleetSkipped));
  }

  projects
    .command('status [nameOrPath]')
    .alias('view')
    .description('Progress card for every project across the whole fleet, or one named project (alias: view). Named form also prints every milestone and the stored definition. A path argument (., .., a ~-prefixed value, a /-containing value, or --path) auto-detects the project that CONTAINS that directory.')
    .option('--json', 'Machine-readable output')
    .option('--path [dir]', 'Treat the argument as a DIRECTORY and auto-detect the project that contains it (bare --path uses the cwd). With --json prints {name, linear:{name,projectId}, root}, all-null when nothing matches (fail-open, exit 0).')
    .option('--window <days>', 'Window for merged PRs, artifacts, and focus areas', '7')
    .option('--no-remote', 'Skip the GitHub and Linear lookups; faster, offline')
    .option('--device <name...>', 'Scope fleet status to one or more devices (repeatable)')
    .option('--devices <names>', 'Scope fleet status to a comma-separated list of devices')
    .action(async (name: string | undefined, rawOpts: ProjectCardOpts & { path?: string | boolean; device?: string[]; devices?: string }) => {
      // Path mode: an explicit --path, or a path-shaped positional (., .., a
      // ~-prefixed value, or a /-containing value) means "auto-detect the
      // project for this DIRECTORY" rather than "a project named literally
      // this". projectNameForCwd resolves the dir (expandLocalHome +
      // path.resolve), so `.`, `~/…`, and relative paths all normalize. This
      // subsumes the removed `agents projects for-cwd`.
      let detectDir: string | undefined;
      if (typeof rawOpts.path === 'string') detectDir = rawOpts.path;
      else if (rawOpts.path === true) detectDir = process.cwd();
      else if (name !== undefined && looksLikePath(name)) detectDir = name;
      if (detectDir !== undefined) {
        const detection = detectProjectForPath(detectDir, listProjectDefs());
        if (rawOpts.json) {
          console.log(JSON.stringify(detection));
          return;
        }
        if (!detection.name) {
          console.log(chalk.gray(`No defined project contains ${detectDir}`));
          return;
        }
        // Non-JSON: fall through and render the full card for the detected project.
        name = detection.name;
      }
      // Named invocation = `view` depth (all milestones + definition). Unnamed
      // stays the scannable multi-project rollup. `view` is a commander alias
      // of this same command, so there is only one implementation.
      // Fleet is dialled by default; --device/--devices narrows it to a subset.
      const opts: ProjectCardOpts = {
        json: rawOpts.json,
        window: rawOpts.window,
        remote: rawOpts.remote,
        deviceFilter: resolveDeviceFilter(rawOpts.device, rawOpts.devices),
      };
      const mode: 'status' | 'view' = name ? 'view' : 'status';
      await runProjectCard(name, opts, mode);
    });


  // ---- edit ----
  projects
    .command('edit <name>')
    .description('Open the project YAML in $EDITOR (it is hand-editable regardless).')
    .action((name: string) => {
      const target = projectDefPath(name);
      if (!fs.existsSync(target)) {
        console.error(chalk.red(`No project named "${name}". Create it: agents projects add ${name}`));
        process.exit(1);
      }
      const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
      // $EDITOR commonly carries args ("code --wait") — split like monitors/routines do.
      const parts = editor.split(/\s+/).filter(Boolean);
      const res = spawnSync(parts[0], [...parts.slice(1), target], { stdio: 'inherit' });
      process.exit(res.status ?? 0);
    });

  // ---- probe (hidden; the peer half of `status --fleet`) ----
  projects
    .command('probe [paths...]', { hidden: true })
    .description('Probe workspace repos (presence, branch, drift, dirtiness) and print JSON. Answers for this machine only.')
    .action((paths: string[]) => {
      // Never fans out — the recursion guard env is set by the parent fan-out,
      // and this command has no remote code path either way.
      console.log(JSON.stringify(probeProjectWorkspaces(paths ?? []), null, 2));
    });

  // ---- pull-local (hidden; the peer half of `pull`) ----
  projects
    .command('pull-local', { hidden: true })
    .description('Fast-forward workspace repos (default-branch only) and print JSON. Answers for this machine only.')
    .requiredOption('--targets <json>', 'JSON array of {path, expectedSlug} targets, from the orchestrating `pull`')
    .action(async (opts: { targets: string }) => {
      // Never fans out — this is the peer half of the fleet fan-out.
      //
      // Targets arrive as {path, expectedSlug} PAIRS, not bare paths: the slug
      // is what lets this machine refuse to fast-forward a directory hosting a
      // different repo, and it is hashed into the fingerprint the caller
      // verifies. Decoding failures exit non-zero so the caller records this
      // peer as skipped instead of reading a missing answer as "nothing to do".
      let targets: ProjectRepoTarget[];
      try {
        targets = decodePullTargets(opts.targets);
      } catch (err) {
        console.error(chalk.red(`Invalid --targets: ${(err as Error).message}`));
        process.exit(1);
      }
      const results = await pullProjectTargets(targets);
      const envelope = buildPullEnvelope(results, targets);
      console.log(JSON.stringify(envelope, null, 2));
    });

  // ---- pull ----
  const pullCmd = projects
    .command('pull <name>')
    .description('Fast-forward every fleet checkout of a named project to its remote default branch.')
    .option('--device <name...>', 'Scope fleet pull to one or more devices (repeatable)')
    .option('--devices <names>', 'Scope fleet pull to a comma-separated list of devices')
    .option('--json', 'Machine-readable output')
    .action(async (name: string, rawOpts: { device?: string[]; devices?: string; json?: boolean }) => {
      const def = loadProjectDef(name);
      if (!def) {
        console.error(chalk.red(`No project named "${name}". Create it: agents projects add ${name}`));
        process.exit(1);
      }

      const targets = projectRepoTargetsForDef(def);
      if (targets.length === 0) {
        console.error(chalk.yellow(`Project "${name}" has no configured repositories.`));
        process.exit(0);
      }

      const deviceFilter = resolveDeviceFilter(rawOpts.device, rawOpts.devices);

      // Pull locally first.
      const self = machineId();
      const localResults = await pullProjectTargets(targets, self);

      // Fan out to fleet peers. Send the full {path, expectedSlug} targets —
      // bare paths would disable slug verification on every peer AND make the
      // peer's fingerprint (which hashes the slug) unmatchable, so its whole
      // answer would be discarded. Compute the fingerprint once so every peer
      // envelope can be verified against the exact target set we sent.
      const expectedFingerprint = fingerprintTargets(targets);
      const remoteRes = await gatherRemoteAgentsJson({
        args: pullLocalArgs(targets),
        noFanoutEnv: PROJECTS_NO_FANOUT_ENV,
        hosts: deviceFilter,
        parse: (stdout: string, machine: string) =>
          parseProjectPullEnvelope(stdout, machine, { expectedFingerprint }),
        quiet: true,
        timeoutMs: 120_000,
      });

      const allResults = [...localResults, ...remoteRes.items];

      if (rawOpts.json) {
        // Mirror `status --json`: peers that didn't answer, or answered
        // unverifiably, go to stderr so a machine caller can still tell them
        // apart from a device with nothing to report (the JSON array itself
        // stays a clean result list).
        if (remoteRes.skipped.length > 0) process.stderr.write(formatFleetSkippedNote(remoteRes.skipped));
        if (remoteRes.parseFailed.length > 0) process.stderr.write(formatFleetUnverifiedNote(remoteRes.parseFailed));
        console.log(JSON.stringify(allResults, null, 2));
      } else {
        printProjectPullSummary(name, allResults, remoteRes.skipped, remoteRes.parseFailed);
      }

      // A peer whose answer could not be verified already ran a real pull whose
      // outcome we cannot see — that is a failed pull, not a quiet success.
      if (!projectPullComplete(allResults) || remoteRes.parseFailed.length > 0) {
        process.exit(1);
      }
    });

  setHelpSections(pullCmd, {
    examples: `
      agents projects pull rush                        # pull every checkout in the project
      agents projects pull rush --device yosemite-s0  # scope to one device
      agents projects pull rush --devices s0,s1       # scope to multiple devices
      agents projects pull rush --json                # machine-readable results
    `,
    notes: `
      Only checkouts on their remote's default branch are fast-forwarded. Dirty
      trees, local commits ahead of upstream, or a wrong branch are blocked and
      reported — never overwritten.

      Each checkout is verified against the project's declared repo slug before
      anything is fast-forwarded — on every device, not just this one. A path
      hosting a different repo is blocked.

      Checkouts absent on a device are skipped (never cloned). Blocked or failed
      checkouts drive a non-zero exit; missing paths do not. A device that
      answers with a result that cannot be verified is reported as unverified
      and also drives a non-zero exit; a device that never answers is reported
      as unavailable and does not.
    `,
  });

  // ---- import ----
  projects
    .command('import')
    .description('Import project definitions from Linear (via the `linear` CLI).')
    .option('--from-linear', 'Import the workspace\'s Linear projects')
    .option('--force', 'Overwrite existing definitions')
    .action((raw: RawImportFlags) => {
      let opts: ImportOptions;
      try {
        opts = validateImportOpts(raw);
      } catch (e) {
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
      const existing = new Map(listProjectDefs().map((d) => [d.name, d]));
      const result = runLinearImport(existing, opts);
      for (const def of result.defs) writeProjectDef(def);
      const n = result.defs.length;
      const s = result.skipped.length;
      console.log(chalk.green(`Imported ${n} project${n === 1 ? '' : 's'}${s ? chalk.gray(` (${s} skipped)`) : ''}`));
      for (const skip of result.skipped) console.log(chalk.gray(`  skip ${skip.name}: ${skip.reason}`));
    });

  // ---- set ----
  projects
    .command('set <name>')
    .description('Change one field on a project definition, preserving everything else.')
    .option('--repo <owner/repo>', 'Primary GitHub slug')
    .option('--root <path>', 'Repo / monorepo root')
    .option('--path <subdir>', 'Default cwd for agents (a monorepo subdir)')
    .option('--description <text>', 'One-line description shown on the card')
    .option('--goal <objective:measure...>', 'Replace the goals this project serves; repeatable')
    .option('--add-dir <path>', 'Bind another directory to this project; repeatable', (val: string, prev: string[]) => [...prev, val], [])
    .option('--rm-dir <path>', 'Unbind a directory from this project; repeatable', (val: string, prev: string[]) => [...prev, val], [])
    .option('--slug <owner/repo>', 'Slug for a single --add-dir whose origin cannot be read')
    .action((name: string, opts: { repo?: string; root?: string; path?: string; description?: string; goal?: string[]; addDir: string[]; rmDir: string[]; slug?: string }) => {
      const def = loadProjectDef(name);
      if (!def) {
        console.error(chalk.red(`No project named "${name}". List them: agents projects list`));
        process.exit(1);
      }
      const fields = (['repo', 'root', 'path', 'description'] as const).filter((k) => opts[k] !== undefined);
      const dirWork = opts.addDir.length > 0 || opts.rmDir.length > 0;
      if (fields.length === 0 && !opts.goal?.length && !dirWork) {
        console.error(chalk.red('Nothing to set. Pass a field, e.g. --repo <owner/repo>.'));
        process.exit(1);
      }
      // One --slug cannot name two directories. Refuse rather than guess which
      // --add-dir it was meant for.
      if (opts.slug && opts.addDir.length !== 1) {
        console.error(chalk.red('--slug names a single --add-dir; pass exactly one --add-dir with it.'));
        process.exit(1);
      }
      // Load, mutate the named fields, write back — the `link` pattern. NEVER
      // the `add --force` pattern, which rebuilds the def from flags alone and
      // silently drops linear/contexts/integrations that were not re-passed.
      if (opts.repo !== undefined) def.repo = opts.repo;
      if (opts.root !== undefined) def.root = opts.root;
      if (opts.description !== undefined) def.description = opts.description;
      if (opts.goal?.length) def.goals = opts.goal.map(parseGoalFlag);
      if (opts.path !== undefined) {
        // `--path` is a subdir OF the root, so without one there is nothing to
        // hang it off. A def imported with `--from-linear` that found no local
        // checkout carries name + linear and no root — joining against '' there
        // would silently write `/apps/cli`, an absolute path at the filesystem
        // root, and the def would resolve somewhere that does not exist.
        const base = (opts.root ?? def.root ?? '').replace(/\/$/, '');
        if (!base) {
          console.error(chalk.red(`"${def.name}" has no root, so --path has nothing to resolve against.`));
          console.error(chalk.gray(`  Set one first: agents projects set ${def.name} --root <path> --path ${opts.path}`));
          process.exit(1);
        }
        def.defaultPath = `${base}/${opts.path.replace(/^\//, '')}`;
      }

      // --rm-dir before --add-dir, so re-pointing one directory in a single
      // command (`--rm-dir old --add-dir new`) does what it reads like.
      const removed: string[] = [];
      for (const d of opts.rmDir) {
        const target = path.resolve(expandLocalHome(d));
        const before = def.repos?.length ?? 0;
        def.repos = (def.repos ?? []).filter(
          (r) => !r.path || path.resolve(expandLocalHome(r.path)) !== target,
        );
        if ((def.repos.length ?? 0) === before) {
          console.error(chalk.red(`"${def.name}" does not bind ${target} — nothing to remove.`));
          process.exit(1);
        }
        removed.push(target);
      }
      const added: ProjectRepo[] = [];
      for (const d of opts.addDir) {
        const r = projectRepoFromDir(d, opts.slug);
        if (!r.ok) {
          console.error(chalk.red(r.error));
          process.exit(1);
        }
        const target = path.resolve(expandLocalHome(r.repo.path!));
        const dup = (def.repos ?? []).some(
          (x) => x.path && path.resolve(expandLocalHome(x.path)) === target,
        );
        if (dup) {
          console.error(chalk.red(`"${def.name}" already binds ${target}.`));
          process.exit(1);
        }
        def.repos = [...(def.repos ?? []), r.repo];
        added.push(r.repo);
      }
      if (def.repos?.length === 0) delete def.repos;

      writeProjectDef(def);
      console.log(chalk.green(`Updated ${def.name}`));
      for (const f of fields) console.log(chalk.gray(`  ${f}  ${f === 'path' ? def.defaultPath : def[f as 'repo' | 'root' | 'description']}`));
      if (opts.goal?.length) console.log(chalk.gray(`  goals  ${def.goals?.map((g) => g.objective).join(' · ')}`));
      for (const r of removed) console.log(chalk.gray(`  - dir  ${toHomeRelative(r)}`));
      for (const r of added) console.log(chalk.gray(`  + dir  ${r.path}  ·  ${r.slug}`));
    });

  // ---- link ----
  projects
    .command('link <name>')
    .description('Attach an external tracker to a project definition (writes linear.projectId + name into the YAML; re-run to pick up a Linear rename).')
    .option('--linear [query]', 'Bind a Linear project by exact name or id; no value auto-suggests from the def name + repo')
    .action((name: string, opts: { linear?: string | boolean }) => {
      const def = loadProjectDef(name);
      if (!def) {
        console.error(chalk.red(`No project named "${name}". List them: agents projects list`));
        process.exit(1);
      }
      if (opts.linear === undefined) {
        console.error(chalk.red('Nothing to link. Pass a tracker flag, e.g. --linear [query].'));
        process.exit(1);
      }
      // Explicit user command — a missing/unauthenticated `linear` CLI is loud,
      // unlike the best-effort card enrichment.
      let list: ReturnType<typeof listLinearProjects>;
      try {
        list = listLinearProjects();
      } catch (e) {
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
      const query = typeof opts.linear === 'string' ? opts.linear.trim() : '';
      let pick: LinearPick;
      if (query) {
        pick = pickLinearProject(query, list);
      } else {
        // Auto-suggest from the def's own identity — the primary repo slug is
        // the sharpest key, then the def name. Only an exact normalized match
        // writes itself; anything weaker asks the user to disambiguate.
        pick = { kind: 'none' };
        for (const hint of [def.repo, def.name].filter((h): h is string => typeof h === 'string' && h.length > 0)) {
          const d = pickLinearProject(hint, list);
          if (d.kind === 'match') {
            pick = d;
            break;
          }
          if (pick.kind === 'none') pick = d;
        }
      }
      if (pick.kind !== 'match') {
        if (pick.kind === 'candidates') {
          console.error(chalk.yellow(`No confident Linear match${query ? ` for "${query}"` : ` for "${def.name}"`}. Candidates:`));
          for (const c of pick.projects) console.error(`  ${chalk.cyan(c.id)}  ${c.name}`);
        } else {
          console.error(chalk.yellow(`No Linear project matches${query ? ` "${query}"` : ` "${def.name}"`}. Available:`));
          for (const c of list) console.error(`  ${chalk.cyan(c.id)}  ${c.name}`);
        }
        console.error(chalk.gray(`Re-run with an explicit name or id: agents projects link ${name} --linear "<name-or-id>"`));
        process.exit(1);
      }
      const p = pick.project;
      // Preserve every other field — load, set linear, write back. Keep a
      // previously linked url when the new CLI row carries none.
      if (def.linear?.projectId && def.linear.projectId !== p.id) {
        console.log(chalk.gray(`  replacing previous Linear link (${def.linear.projectId})`));
      }
      if (def.linear?.name && def.linear.name !== p.name) {
        console.log(chalk.gray(`  renaming "${def.linear.name}" → "${p.name}" (Linear is authoritative)`));
      }
      // Assigned, not spread over `def.linear`: a spread would resurrect a url
      // that nextLinearLink deliberately dropped. The block has no other fields.
      def.linear = nextLinearLink(def.linear, p);
      writeProjectDef(def);
      console.log(chalk.green(`${def.name} → Linear project "${p.name}" (${p.id})${p.url ? ` ${p.url}` : ''}`));
    });

  // ---- save ----
  projects
    .command('save')
    .description('Create or update one project from a complete ProjectDef JSON object on stdin.')
    .option('--json', 'Required: read ProjectDef JSON from stdin; print the saved definition as JSON')
    .action(async (opts: { json?: boolean }) => {
      if (!opts.json) {
        console.error(chalk.red('projects save requires --json (pipe one complete ProjectDef JSON object on stdin).'));
        process.exit(1);
      }
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        console.error(chalk.red('projects save --json: empty stdin (expected one ProjectDef JSON object).'));
        process.exit(1);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        console.error(chalk.red(`projects save --json: invalid JSON: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
      let def: ProjectDef;
      try {
        def = validateProjectDef(parsed);
      } catch (e) {
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
      writeProjectDef(def);
      const saved = loadProjectDef(def.name);
      if (!saved) {
        console.error(chalk.red(`projects save: wrote "${def.name}" but could not reload it`));
        process.exit(1);
      }
      console.log(JSON.stringify(saved, null, 2));
    });

  // ---- rm ----
  projects
    .command('remove <name>')
    .alias('rm')
    .description('Remove a project definition. Never touches the repo.')
    .option('--json', 'Machine-readable success / error')
    .action((name: string, opts: { json?: boolean }) => {
      if (!isSafeProjectName(name)) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, name, error: `Invalid project name: "${name}"` }));
        } else {
          console.error(chalk.red(`Invalid project name: "${name}"`));
        }
        process.exit(1);
      }
      const removed = removeProjectDef(name);
      if (opts.json) {
        console.log(JSON.stringify(removed
          ? { ok: true, name, removed: true }
          : { ok: false, name, error: `No project named "${name}"` }
        ));
      } else if (removed) {
        console.log(chalk.green(`Removed project "${name}"`));
      } else {
        console.error(chalk.red(`No project named "${name}".`));
      }
      if (!removed) process.exit(1);
    });
}
