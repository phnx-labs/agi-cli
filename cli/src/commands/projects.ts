
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
import {
  approveProjectPr,
  buildProjectPrs,
  commentOnProjectPr,
  markProjectPrReady,
  mergeProjectPr,
  resolveTargetSlugs,
  setProjectPrAutoMerge,
  MERGE_METHODS,
  MERGED_WINDOW_DAYS,
  type CiState,
  type MergeMethod,
} from '../lib/github/project-prs.js';
import { ghExec } from '../lib/github/pr-mergeable.js';
import { readCiFailure, rerunFailedJobs } from '../lib/github/ci-failure.js';
import { registerProjectTodoCommands } from './projects-todo.js';

function ciMark(state: CiState | null): string {
  if (state === 'SUCCESS') return chalk.green('✓');
  if (state === 'FAILURE' || state === 'ERROR') return chalk.red('✗');
  if (state === 'PENDING' || state === 'EXPECTED') return chalk.yellow('●');
  return ' ';
}

const PROJECTS_NO_FANOUT_ENV = 'AGENTS_PROJECTS_LOCAL';

const SKIPPED_NAME_LIMIT = 4;

export function looksLikePath(token: string): boolean {
  return token === '.' || token === '..' || token.startsWith('~') || token.includes('/');
}

interface ViewDetection {
  name: string | null;
  linear: { name: string | null; projectId: string | null };
  root: string | null;
}

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

export function formatFleetSkippedNote(skipped: string[]): string {
  if (skipped.length === 0) return '';
  const named = skipped.slice(0, SKIPPED_NAME_LIMIT);
  const rest = skipped.length - named.length;
  const list = rest > 0 ? `${named.join(', ')} +${rest}` : named.join(', ');
  const noun = skipped.length === 1 ? 'device' : 'devices';
  return chalk.gray(`  · ${skipped.length} ${noun} didn't answer (unreachable, older agents-cli, or timed out): ${list}\n`);
}

export function formatFleetUnverifiedNote(unverified: string[]): string {
  if (unverified.length === 0) return '';
  const named = unverified.slice(0, SKIPPED_NAME_LIMIT);
  const rest = unverified.length - named.length;
  const list = rest > 0 ? `${named.join(', ')} +${rest}` : named.join(', ');
  const noun = unverified.length === 1 ? 'device' : 'devices';
  return chalk.red(`  · ${unverified.length} ${noun} answered with a result that could not be verified: ${list}\n`);
}

function parseContextFlag(raw: string): ProjectContext {
  const i = raw.indexOf(':');
  if (i === -1) return { path: raw.trim(), purpose: '' };
  return { path: raw.slice(0, i).trim(), purpose: raw.slice(i + 1).trim() };
}

function parseGoalFlag(raw: string): ProjectGoal {
  const i = raw.indexOf(':');
  if (i === -1) return { objective: raw.trim() };
  const measure = raw.slice(i + 1).trim();
  const goal: ProjectGoal = { objective: raw.slice(0, i).trim() };
  if (measure) goal.measure = measure;
  return goal;
}

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

function runLinearImport(existing: Map<string, ProjectDef>, opts: ImportOptions): ImportPlan {
  let list: LinearProjectLite[];
  try {
    list = listLinearProjects();
  } catch (e) {
    console.error(chalk.red(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }
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

export interface ProjectListRow {
  name: string;
  path: string;
  repo: string;
}

const LIST_PATH_MAX = 48;

export function computeProjectListWidths(rows: ProjectListRow[]): { name: number; path: number; repo: number } {
  const widest = (pick: (r: ProjectListRow) => string, cap: number) =>
    Math.min(cap, rows.reduce((w, r) => Math.max(w, pick(r).length), 0));
  return {
    name: widest((r) => r.name, 64),
    path: widest((r) => r.path, LIST_PATH_MAX),
    repo: widest((r) => r.repo, 64),
  };
}

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

export function formatMilestoneLines(
  milestones: LinearMilestone[],
  next: LinearMilestone | undefined,
  nowMs: number,
  limit: number,
): string[] {
  if (milestones.length === 0) {
    return next ? [`  ${chalk.dim('next')}     ${formatNextMilestone(next, nowMs)}`] : [];
  }
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

export function formatNextMilestone(ms: LinearMilestone, nowMs: number): string {
  const parts = [chalk.bold(ms.name)];
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
  const live = liveDeadSplit(r.byStatus).live;
  if (live > shown) parts.push(chalk.gray(`+${live - shown} other`));
  return parts.join(' · ') || chalk.gray('no live agents');
}

interface ProjectRenderData {
  roll: Map<string, ProjectSessionRollup>;
  remote: Map<string, ProjectRemoteSignals>;
  linear: Map<string, LinearProjectCounts>;
  focus: Map<string, FocusArea[]>;
}

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
  const local = withDefaultMachine(await getActiveSessions(), machineId());
  const roll = rollupSessionsByProject(all, [...local, ...(opts.extraSessions ?? [])]);
  const remote = new Map<string, ProjectRemoteSignals>();
  const linear = new Map<string, LinearProjectCounts>();
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
  milestoneLimit: number = 1,
  focus: FocusArea[] = [],
  detail: boolean = false,
  warnWorkspaces: HostWorkspaceStatus[] = [],
): void {
  const split = r ? liveDeadSplit(r.byStatus) : { live: 0, dead: 0, deadByStatus: [] };
  console.log(`${chalk.bold(def.name)}  ${chalk.dim('·')}  ${chalk.bold(`${split.live} live`)}`);
  if (def.description) console.log(`  ${chalk.dim(def.description)}`);
  console.log(`  ${chalk.dim('live')}     ${r ? statusBar(r) : chalk.gray('no live agents')}`);
  if (split.dead > 0) {
    console.log(`  ${chalk.dim('dead')}     ${formatDeadSummary(split)}`);
  }
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

type ProjectCardOpts = {
  json?: boolean;
  window?: string;
  remote?: boolean;
  deviceFilter?: string[];
};

function resolveDeviceFilter(device?: string[], devices?: string): string[] | undefined {
  const merged = [
    ...(device ?? []),
    ...(devices ? devices.split(',').map((s) => s.trim()).filter(Boolean) : []),
  ];
  return merged.length ? [...new Set(merged)] : undefined;
}

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


function prFail(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}

function prProjectOrExit(name: string): ProjectDef {
  return loadProjectDef(name) ?? prFail(`No project named "${name}". List them: agents projects list`);
}

function prNumberOrExit(raw: string): number {
  const t = raw.trim();
  const number = /^\d+$/.test(t) ? Number.parseInt(t, 10) : NaN;
  if (!Number.isSafeInteger(number) || number <= 0) prFail(`--number expects a positive integer, got "${raw}".`);
  return number;
}

function prShaOrExit(raw: string): string {
  const sha = raw.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) prFail(`--sha expects a commit SHA, got "${raw}".`);
  return sha;
}

function prCommentBodyOrExit(body: string | undefined, bodyFile: string | undefined): string {
  if ((body === undefined) === (bodyFile === undefined)) prFail('Pass exactly one of --body <text> or --body-file <path|->.');
  let text = body;
  if (bodyFile !== undefined) {
    try {
      text = fs.readFileSync(bodyFile === '-' ? 0 : bodyFile, 'utf-8');
    } catch (e) {
      prFail(`Could not read --body-file ${bodyFile}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!text || !text.trim()) prFail('The comment is empty.');
  return text.trimEnd();
}

function prMethodOrExit(raw: string | undefined): MergeMethod | undefined {
  if (raw !== undefined && !(MERGE_METHODS as readonly string[]).includes(raw)) {
    prFail(`--method expects one of ${MERGE_METHODS.join(', ')}, got "${raw}".`);
  }
  return raw as MergeMethod | undefined;
}

async function prRepoOrExit(def: ProjectDef, repo: string): Promise<string> {
  try {
    const [resolved] = await resolveTargetSlugs(def, repo, ghExec);
    return resolved;
  } catch (e) {
    return prFail(e instanceof Error ? e.message : String(e));
  }
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

  projects
    .command('list')
    .description('List defined projects (definitions only by default; no session scan).')
    .option('--json', 'Machine-readable output')
    .option('--with-agents', 'Include local active agent counts (opt-in; never SSH)')
    .action(async (opts: { json?: boolean; withAgents?: boolean }) => {
      const defs = listProjectDefs();
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

    const fleetFor = (d: ProjectDef): HostWorkspaceStatus[] => {
      const targets = new Set(workspaceTargetsForDef(d));
      return fleetWs.filter((s) => targets.has(s.path));
    };

    if (opts.json) {
      if (fleetSkipped.length > 0) process.stderr.write(formatFleetSkippedNote(fleetSkipped));
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

    const milestoneLimit = detail ? Number.POSITIVE_INFINITY : 1;
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
        name = detection.name;
      }
      const opts: ProjectCardOpts = {
        json: rawOpts.json,
        window: rawOpts.window,
        remote: rawOpts.remote,
        deviceFilter: resolveDeviceFilter(rawOpts.device, rawOpts.devices),
      };
      const mode: 'status' | 'view' = name ? 'view' : 'status';
      await runProjectCard(name, opts, mode);
    });


  const prsCmd = projects
    .command('prs')
    .description('A project\'s open pull requests: list them (default), act on one (ready, review, comment, merge), or read and re-run failed CI (failure, rerun).');
  const prsListCmd = prsCmd
    .command('list <name>', { isDefault: true })
    .description('Every OPEN pull request across a project\'s attached repos (drafts included, no author filter), scoped to this project\'s paths in a shared repo.')
    .option('--json', 'Machine-readable output (the AGI Menu contract shape)')
    .option('--repo <owner/repo>', 'Restrict to one of the project\'s attached repos')
    .option('--number <n>', 'Lazy detail: enrich exactly this PR with checks + reviewDecision (requires --repo)')
    .action(async (name: string, opts: { json?: boolean; repo?: string; number?: string }) => {
      const def = loadProjectDef(name);
      if (!def) {
        console.error(chalk.red(`No project named "${name}". List them: agents projects list`));
        process.exit(1);
      }
      let number: number | undefined;
      if (opts.number !== undefined) {
        if (!opts.repo) {
          console.error(chalk.red('--number names one PR in one repo; pass --repo <owner/repo> with it.'));
          process.exit(1);
        }
        const raw = opts.number.trim();
        number = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : NaN;
        if (!Number.isSafeInteger(number) || number <= 0) {
          console.error(chalk.red(`--number expects a positive integer, got "${opts.number}".`));
          process.exit(1);
        }
      }
      let envelope;
      try {
        envelope = await buildProjectPrs(def, { repo: opts.repo, number }, undefined, listProjectDefs());
      } catch (e) {
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify(envelope, null, 2));
        return;
      } else {
        for (const r of envelope.repositories) {
          if (r.error) {
            console.log(`${chalk.bold(r.slug)}  ${chalk.red(`— fetch failed: ${r.error}`)}`);
            continue;
          }
          const branch = r.defaultBranch ? `  ${r.defaultBranch.name} ${ciMark(r.defaultBranch.ciState)}` : '';
          console.log(`${chalk.bold(r.slug)}  ${chalk.dim(`${r.pullRequests.length} open`)}${branch}`);
          for (const pr of r.pullRequests) {
            const draft = pr.isDraft ? chalk.gray(' [draft]') : '';
            const wide = pr.scope === 'repo-wide' ? chalk.gray(' [repo-wide]') : '';
            console.log(`  ${ciMark(pr.ciState)} #${pr.number}${draft}${wide}  ${pr.title}  ${chalk.gray(`@${pr.author.login} · ${pr.headRefName}`)}`);
          }
          if (r.release) {
            const npm = r.release.npm?.version ? ` · npm ${r.release.npm.version}` : '';
            const since = `${r.release.mergesSince}${r.release.mergesSinceComplete ? '' : '+'}`;
            console.log(chalk.dim(`  ${r.release.latestTag} tagged ${r.release.latestTagAt.slice(0, 10)}${npm} · ${since} merged since`));
          }
          if (r.releaseError) console.log(chalk.yellow(`  Latest release could not be read: ${r.releaseError}`));
          if (r.ciError) console.log(chalk.yellow(`  CI and merged PRs are incomplete: ${r.ciError}`));
          if (r.truncated) console.log(chalk.yellow('  Merged list may be missing PRs: too many closed PRs were updated this week to read them all.'));
          if (r.recentlyMerged.length > 0) {
            console.log(chalk.dim(`  merged in the last ${MERGED_WINDOW_DAYS} days:`));
            for (const pr of r.recentlyMerged) {
              console.log(`  ${ciMark(pr.ciState)} #${pr.number}  ${pr.title}  ${chalk.gray(`@${pr.author.login} · ${pr.mergedAt.slice(0, 10)}`)}`);
            }
          }
        }
        if (envelope.partial) {
          console.log(chalk.yellow('\nSome repositories could not be fetched — the list above is incomplete.'));
        }
      }
      if (envelope.partial) process.exit(1);
    });

  const mergeCmd = prsCmd
    .command('merge <name>')
    .description('Merge one open PR of a project, pinned to the head SHA you reviewed.')
    .requiredOption('--repo <owner/repo>', 'One of the project\'s attached repos')
    .requiredOption('--number <n>', 'The PR number')
    .requiredOption('--sha <head-sha>', 'The head SHA you reviewed; GitHub refuses if the branch moved since')
    .option('--method <method>', `${MERGE_METHODS.join(' | ')} (default: the first the repo allows, in that order)`)
    .option('--admin', 'Merge a PR branch protection blocks, as a repository admin. For a person\'s explicit confirm only; agents must never pass it')
    .option('--json', 'Machine-readable result')
    .action(async (name: string, opts: { repo: string; number: string; sha: string; method?: string; admin?: boolean; json?: boolean }) => {
      const def = prProjectOrExit(name);
      const number = prNumberOrExit(opts.number);
      const sha = prShaOrExit(opts.sha);
      const method = prMethodOrExit(opts.method);
      const repo = await prRepoOrExit(def, opts.repo);
      const result = await mergeProjectPr(repo, number, sha, method, { admin: opts.admin === true });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.merged) {
        console.log(`${chalk.green('Merged')} ${repo}#${number} (${result.method}) ${chalk.gray(result.sha ?? '')}`);
      } else {
        console.error(chalk.red(`Not merged: ${repo}#${number}: ${result.message}`));
      }
      if (!result.merged) process.exit(1);
    });

  setHelpSections(mergeCmd, {
    examples: `
      agents projects prs rush --json --repo phnx-labs/agi-cli --number 3646   # read headSha + mergeableState
      agents projects prs merge rush --repo phnx-labs/agi-cli --number 3646 --sha <headSha>
      agents projects prs merge rush --repo phnx-labs/agi-cli --number 3646 --sha <headSha> --method squash --json
    `,
    notes: `
      The merge is a single REST call pinned to --sha: if anything was pushed after
      you read the PR, GitHub refuses and nothing merges. Without --admin, a PR whose
      live mergeable_state is not clean/unstable/has_hooks (blocked by a pending or red
      required check or a review, behind, conflicted, or not computed yet) is refused
      before the call. --admin skips that refusal and lets a
      repository admin merge past branch protection where GitHub allows it; it exists
      for a person's explicit confirm (AGI Menu's "Confirm admin merge") and agents
      must never pass it. To land a PR once its checks pass, use prs automerge. A
      refusal exits 1 with GitHub's reason (merged: false in --json).
    `,
  });

  const automergeCmd = prsCmd
    .command('automerge <name>')
    .description('Turn GitHub auto-merge on (or off with --off) for one open PR, so it merges itself once its required checks pass.')
    .requiredOption('--repo <owner/repo>', 'One of the project\'s attached repos')
    .requiredOption('--number <n>', 'The PR number')
    .option('--sha <head-sha>', 'The head SHA you reviewed (required to turn it on); GitHub refuses if the branch moved since')
    .option('--method <method>', `${MERGE_METHODS.join(' | ')} (default: the first the repo allows, in that order)`)
    .option('--off', 'Turn auto-merge off instead')
    .option('--json', 'Machine-readable result')
    .action(async (name: string, opts: { repo: string; number: string; sha?: string; method?: string; off?: boolean; json?: boolean }) => {
      const def = prProjectOrExit(name);
      const number = prNumberOrExit(opts.number);
      const enable = opts.off !== true;
      if (enable && opts.sha === undefined) prFail('Pass --sha <head-sha>: auto-merge is pinned to the head you reviewed.');
      if (!enable && opts.method !== undefined) prFail('--method only applies when turning auto-merge on.');
      const sha = opts.sha === undefined ? undefined : prShaOrExit(opts.sha);
      const method = prMethodOrExit(opts.method);
      const repo = await prRepoOrExit(def, opts.repo);
      const result = await setProjectPrAutoMerge(repo, number, enable && sha !== undefined ? { enable: true, sha, method } : { enable: false });
      const ok = result.enabled === enable;
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else if (ok) console.log(`${chalk.green(result.message)}: ${repo}#${number}`);
      else console.error(chalk.red(`Auto-merge not changed: ${repo}#${number}: ${result.message}`));
      if (!ok) process.exit(1);
    });

  setHelpSections(automergeCmd, {
    examples: `
      agents projects prs rush --json --repo phnx-labs/agi-cli --number 3646   # read headSha + merge.autoMergeAllowed
      agents projects prs automerge rush --repo phnx-labs/agi-cli --number 3646 --sha <headSha>
      agents projects prs automerge rush --repo phnx-labs/agi-cli --number 3646 --off --json
    `,
    notes: `
      GitHub has no REST endpoint for auto-merge, so each call is one GraphQL
      mutation (enablePullRequestAutoMerge / disablePullRequestAutoMerge) after a REST
      read. Turning it on passes expectedHeadOid, so a branch that moved since --sha
      is refused. The repository must allow auto-merge (merge.autoMergeAllowed in
      prs --json), and GitHub refuses it on a PR that can already merge: use prs merge
      for that. Exits 1 unless auto-merge ends in the requested state.
    `,
  });

  const readyCmd = prsCmd
    .command('ready <name>')
    .description('Mark one draft PR of a project ready for review.')
    .requiredOption('--repo <owner/repo>', 'One of the project\'s attached repos')
    .requiredOption('--number <n>', 'The PR number')
    .option('--sha <head-sha>', 'The head SHA you looked at; refused if the branch moved since')
    .option('--json', 'Machine-readable result')
    .action(async (name: string, opts: { repo: string; number: string; sha?: string; json?: boolean }) => {
      const def = prProjectOrExit(name);
      const number = prNumberOrExit(opts.number);
      const sha = opts.sha === undefined ? undefined : prShaOrExit(opts.sha);
      const repo = await prRepoOrExit(def, opts.repo);
      const result = await markProjectPrReady(repo, number, sha);
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else if (result.ready) console.log(`${chalk.green(result.message)}: ${repo}#${number}`);
      else console.error(chalk.red(`Not marked ready: ${repo}#${number}: ${result.message}`));
      if (!result.ready) process.exit(1);
    });

  setHelpSections(readyCmd, {
    examples: `
      agents projects prs rush --json --repo phnx-labs/agi-cli --number 3646   # read isDraft + headSha
      agents projects prs ready rush --repo phnx-labs/agi-cli --number 3646 --sha <headSha>
      agents projects prs ready rush --repo phnx-labs/agi-cli --number 3646 --json
    `,
    notes: `
      GitHub has no REST endpoint for this, so it is one GraphQL mutation
      (markPullRequestReadyForReview) after a REST read. A PR that is already ready
      succeeds without a write. With --sha, a head that moved is refused before the
      write; GitHub cannot pin the mutation itself, so that check is not atomic.
    `,
  });

  const reviewCmd = prsCmd
    .command('review <name>')
    .description('Approve one open PR of a project, pinned to the head SHA you reviewed.')
    .requiredOption('--repo <owner/repo>', 'One of the project\'s attached repos')
    .requiredOption('--number <n>', 'The PR number')
    .requiredOption('--sha <head-sha>', 'The head SHA you reviewed; refused if the branch moved since')
    .option('--approve', 'Submit an approving review (the only review this command submits)')
    .option('--body <text>', 'Text to post with the approval')
    .option('--json', 'Machine-readable result')
    .action(async (name: string, opts: { repo: string; number: string; sha: string; approve?: boolean; body?: string; json?: boolean }) => {
      const def = prProjectOrExit(name);
      const number = prNumberOrExit(opts.number);
      const sha = prShaOrExit(opts.sha);
      if (!opts.approve) prFail('Pass --approve: approving is the only review this command submits.');
      const repo = await prRepoOrExit(def, opts.repo);
      const result = await approveProjectPr(repo, number, sha, opts.body);
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else if (result.submitted) console.log(`${chalk.green('Approved')} ${repo}#${number} at ${chalk.gray((result.sha ?? '').slice(0, 7))}`);
      else console.error(chalk.red(`Not approved: ${repo}#${number}: ${result.message}`));
      if (!result.submitted) process.exit(1);
    });

  setHelpSections(reviewCmd, {
    examples: `
      agents projects prs rush --json --repo phnx-labs/agi-cli --number 3646   # read headSha
      agents projects prs review rush --repo phnx-labs/agi-cli --number 3646 --approve --sha <headSha>
      agents projects prs review rush --repo phnx-labs/agi-cli --number 3646 --approve --sha <headSha> --body "Checked the migration" --json
    `,
    notes: `
      One REST call (POST pulls/{n}/reviews, event APPROVE). The live head is read
      first and a moved head is refused; the review carries commit_id = that SHA, so
      it is recorded against the code you saw. On your own PR it answers at once
      (exit 1, submitted: false) without calling GitHub, which never allows that.
    `,
  });

  const commentCmd = prsCmd
    .command('comment <name>')
    .description('Post a comment on one open PR of a project.')
    .requiredOption('--repo <owner/repo>', 'One of the project\'s attached repos')
    .requiredOption('--number <n>', 'The PR number')
    .option('--body <text>', 'The comment text')
    .option('--body-file <path>', 'Read the comment from a file; - reads stdin')
    .option('--json', 'Machine-readable result')
    .action(async (name: string, opts: { repo: string; number: string; body?: string; bodyFile?: string; json?: boolean }) => {
      const def = prProjectOrExit(name);
      const number = prNumberOrExit(opts.number);
      const body = prCommentBodyOrExit(opts.body, opts.bodyFile);
      const repo = await prRepoOrExit(def, opts.repo);
      const result = await commentOnProjectPr(repo, number, body);
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else if (result.commented) console.log(`${chalk.green('Commented')} on ${repo}#${number} ${chalk.gray(result.url ?? '')}`);
      else console.error(chalk.red(`Not commented: ${repo}#${number}: ${result.message}`));
      if (!result.commented) process.exit(1);
    });

  setHelpSections(commentCmd, {
    examples: `
      agents projects prs comment rush --repo phnx-labs/agi-cli --number 3646 --body "Looks good once CI is green"
      printf 'Two notes:\\n- one\\n- two\\n' | agents projects prs comment rush --repo phnx-labs/agi-cli --number 3646 --body-file - --json
    `,
    notes: `
      One REST call (POST issues/{n}/comments), not the GraphQL-backed gh pr comment.
      Pass exactly one of --body or --body-file; an empty comment is refused.
    `,
  });

  const failureCmd = prsCmd
    .command('failure <name>')
    .description('Why one commit\'s CI failed: each failing check with the error lines of its job log.')
    .requiredOption('--repo <owner/repo>', 'One of the project\'s attached repos')
    .requiredOption('--sha <commit>', 'The commit whose checks failed: a PR head, a merge commit, or the default branch head')
    .option('--json', 'Machine-readable result')
    .action(async (name: string, opts: { repo: string; sha: string; json?: boolean }) => {
      const def = prProjectOrExit(name);
      const sha = prShaOrExit(opts.sha);
      const repo = await prRepoOrExit(def, opts.repo);
      const report = await readCiFailure(repo, sha);
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else if (report.error) {
        console.error(chalk.red(`Could not read the checks of ${repo}@${sha.slice(0, 7)}: ${report.error}`));
      } else if (report.checks.length === 0) {
        console.log(`No failing checks on ${repo}@${sha.slice(0, 7)}.`);
      } else {
        for (const check of report.checks) {
          console.log(`${chalk.red('✗')} ${chalk.bold(check.name)}  ${chalk.gray(check.conclusion.toLowerCase())}${check.url ? `  ${chalk.gray(check.url)}` : ''}`);
          for (const line of check.excerpt) console.log(`    ${line}`);
          if (check.excerptError) console.log(chalk.yellow(`    ${check.excerptError}`));
          if (check.runId !== null) console.log(chalk.gray(`    re-run: agents projects prs rerun ${name} --repo ${repo} --run-id ${check.runId}`));
        }
      }
      if (report.error) process.exit(1);
    });

  setHelpSections(failureCmd, {
    examples: `
      agents projects prs rush --json                                   # read a ✗: defaultBranch.sha, a PR's headSha, or a merge's mergeCommitSha
      agents projects prs failure rush --repo phnx-labs/agi-cli --sha <sha>
      agents projects prs failure rush --repo phnx-labs/agi-cli --sha <sha> --json
    `,
    notes: `
      REST only: the commit's check runs and statuses, then each failing GitHub
      Actions job's log (GET actions/jobs/{job}/logs). The excerpt drops timestamps,
      colour and the runner's cleanup after "Post job cleanup.", and keeps the lines
      that read like an error with one line of context each side, at most 12. A log
      that cannot be read empties that excerpt and says why in excerptError; a check
      that is not an Actions job has no log here. Exits 1 only when the checks
      themselves could not be read.
    `,
  });

  const rerunCmd = prsCmd
    .command('rerun <name>')
    .description('Re-run the failed jobs of one GitHub Actions workflow run.')
    .requiredOption('--repo <owner/repo>', 'One of the project\'s attached repos')
    .requiredOption('--run-id <id>', 'The workflow run (runId from prs failure --json)')
    .option('--json', 'Machine-readable result')
    .action(async (name: string, opts: { repo: string; runId: string; json?: boolean }) => {
      const def = prProjectOrExit(name);
      const raw = opts.runId.trim();
      const runId = /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(runId) || runId <= 0) prFail(`--run-id expects a positive integer, got "${opts.runId}".`);
      const repo = await prRepoOrExit(def, opts.repo);
      const result = await rerunFailedJobs(repo, runId);
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else if (result.requested) console.log(`${chalk.green(result.message)}: ${repo} run ${runId}`);
      else console.error(chalk.red(`Not re-run: ${repo} run ${runId}: ${result.message}`));
      if (!result.requested) process.exit(1);
    });

  setHelpSections(rerunCmd, {
    examples: `
      agents projects prs failure rush --repo phnx-labs/agi-cli --sha <sha> --json   # runId per failing check
      agents projects prs rerun rush --repo phnx-labs/agi-cli --run-id 37243157132
    `,
    notes: `
      One REST call (POST actions/runs/{id}/rerun-failed-jobs). Re-running only
      repeats jobs, so it is safe to click again; GitHub refuses a run that is still
      in progress (exit 1, requested: false in --json).
    `,
  });

  setHelpSections(prsCmd, {
    examples: `
      agents projects prs rush --json                       # every open PR across rush's repos (= prs list rush)
      agents projects prs rush --json --repo phnx-labs/agi-cli --number 3646  # one PR, with checks + mergeability
      agents projects prs ready rush --repo phnx-labs/agi-cli --number 3646 --sha <headSha>
      agents projects prs review rush --repo phnx-labs/agi-cli --number 3646 --approve --sha <headSha>
      agents projects prs comment rush --repo phnx-labs/agi-cli --number 3646 --body-file -
      agents projects prs merge rush --repo phnx-labs/agi-cli --number 3646 --sha <headSha>
      agents projects prs failure rush --repo phnx-labs/agi-cli --sha <sha>
      agents projects prs rerun rush --repo phnx-labs/agi-cli --run-id <runId>
    `,
  });

  setHelpSections(prsListCmd, {
    examples: `
      agents projects prs rush --json                       # every open PR across rush's repos
      agents projects prs rush --json --repo phnx-labs/agi-cli
      agents projects prs rush --json --repo phnx-labs/agi-cli --number 3646  # one PR, with checks + review + mergeability
      agents projects prs merge rush --repo phnx-labs/agi-cli --number 3646 --sha <headSha>
    `,
    notes: `
      Repos come from the project definition's attached repos only (repo + repos[].slug);
      --repo is refused unless it is one of them.

      The list is read from GitHub over REST and paginated in full, drafts included,
      with no author filter. checks and reviewDecision are null in the list; --number
      enriches exactly that one PR against its live head SHA, with mergeable and
      mergeableState.

      A repository attached to several projects (a monorepo) is scoped by the paths
      each project claims, the same rule that attributes a session's cwd: a
      defaultPath narrowed under root, or a repos[] subpath. A PR is listed when it
      touches this project's paths (scope: project) or no sharing project's paths
      (scope: repo-wide). Changed files are cached per head SHA, so only a new push
      costs a read.

      A repository whose fetch fails is reported with an error and marks the result
      partial (JSON reports errors per repository; text mode exits non-zero).
    `,
  });

  registerProjectTodoCommands(projects);

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
      const parts = editor.split(/\s+/).filter(Boolean);
      const res = spawnSync(parts[0], [...parts.slice(1), target], { stdio: 'inherit' });
      process.exit(res.status ?? 0);
    });

  projects
    .command('probe [paths...]', { hidden: true })
    .description('Probe workspace repos (presence, branch, drift, dirtiness) and print JSON. Answers for this machine only.')
    .action((paths: string[]) => {
      console.log(JSON.stringify(probeProjectWorkspaces(paths ?? []), null, 2));
    });

  projects
    .command('pull-local', { hidden: true })
    .description('Fast-forward workspace repos (default-branch only) and print JSON. Answers for this machine only.')
    .requiredOption('--targets <json>', 'JSON array of {path, expectedSlug} targets, from the orchestrating `pull`')
    .action(async (opts: { targets: string }) => {
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

      const self = machineId();
      const localResults = await pullProjectTargets(targets, self);

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
        if (remoteRes.skipped.length > 0) process.stderr.write(formatFleetSkippedNote(remoteRes.skipped));
        if (remoteRes.parseFailed.length > 0) process.stderr.write(formatFleetUnverifiedNote(remoteRes.parseFailed));
        console.log(JSON.stringify(allResults, null, 2));
      } else {
        printProjectPullSummary(name, allResults, remoteRes.skipped, remoteRes.parseFailed);
      }

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
      if (opts.slug && opts.addDir.length !== 1) {
        console.error(chalk.red('--slug names a single --add-dir; pass exactly one --add-dir with it.'));
        process.exit(1);
      }
      if (opts.repo !== undefined) def.repo = opts.repo;
      if (opts.root !== undefined) def.root = opts.root;
      if (opts.description !== undefined) def.description = opts.description;
      if (opts.goal?.length) def.goals = opts.goal.map(parseGoalFlag);
      if (opts.path !== undefined) {
        const base = (opts.root ?? def.root ?? '').replace(/\/$/, '');
        if (!base) {
          console.error(chalk.red(`"${def.name}" has no root, so --path has nothing to resolve against.`));
          console.error(chalk.gray(`  Set one first: agents projects set ${def.name} --root <path> --path ${opts.path}`));
          process.exit(1);
        }
        def.defaultPath = `${base}/${opts.path.replace(/^\//, '')}`;
      }

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
      if (def.linear?.projectId && def.linear.projectId !== p.id) {
        console.log(chalk.gray(`  replacing previous Linear link (${def.linear.projectId})`));
      }
      if (def.linear?.name && def.linear.name !== p.name) {
        console.log(chalk.gray(`  renaming "${def.linear.name}" → "${p.name}" (Linear is authoritative)`));
      }
      def.linear = nextLinearLink(def.linear, p);
      writeProjectDef(def);
      console.log(chalk.green(`${def.name} → Linear project "${p.name}" (${p.id})${p.url ? ` ${p.url}` : ''}`));
    });

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
