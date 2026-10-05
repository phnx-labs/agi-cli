/** Project-level progress rollup: aggregates per-session signals (status, plan, PRs, tickets,
 * worktrees) into one row per project, matched by cwd (`projectNameForCwd`). Pure over
 * `ActiveSession[]`; merged-PR (via `gh`) and artifact signals are added in `enrichProjectSignals`. */

import { execFile } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import type { ActiveSession, ActiveStatus } from './session/active.js';
import { projectNameForCwd, type ProjectDef } from './projects.js';
import { readRecentActivity } from './feed/activity.js';

const execFileAsync = promisify(execFile);

/** How many recent merges `gh` is asked for. A busy repo can exceed it (agents-cli merged 100 of its
 * 100 latest PRs within 7 days), so the count is reported as a lower bound. */
const MERGED_PR_LIMIT = 100;

/** One live agent on a project — the WHO behind the byStatus count. */
export interface ProjectMember {
  /** Harness name (claude / codex / …), from the session's `kind`. */
  agent: string;
  /** Lifecycle status (running / idle / …). */
  status: string;
  /** Tracker ticket the session is tied to, when any. */
  ticket?: string;
  /** Machine the session runs on (provenance host / fleet peer), when known. */
  host?: string;
}

/** One project's live session rollup. */
export interface ProjectSessionRollup {
  name: string;
  /** Total sessions whose cwd is inside this project. */
  agents: number;
  /** Count per lifecycle status. */
  byStatus: Partial<Record<ActiveStatus, number>>;
  /** Which agents are on the project (one per matched session). */
  members: ProjectMember[];
  /** Summed checklist progress across this project's sessions. */
  plan: { done: number; total: number };
  /** Distinct open PRs held by this project's sessions. */
  openPrs: { url: string; number?: number }[];
  /** Distinct tickets worked or created by this project's sessions. */
  tickets: string[];
  /** Sessions running inside a worktree. */
  worktrees: number;
}

function blank(name: string): ProjectSessionRollup {
  return {
    name,
    agents: 0,
    byStatus: {},
    members: [],
    plan: { done: 0, total: 0 },
    openPrs: [],
    tickets: [],
    worktrees: 0,
  };
}

/** Roll active sessions up by project: a map keyed by name containing only projects with a matched
 * session; callers merge with the definition list to show zero-agent projects. */

/** Ensure every session carries a host for the roster: local `getActiveSessions()` omits `machine`,
 * remotes set it. Pure. */
export function withDefaultMachine<T extends { machine?: string }>(
  sessions: T[],
  defaultHost: string,
): T[] {
  return sessions.map((s) => (s.machine ? s : { ...s, machine: defaultHost }));
}

export function rollupSessionsByProject(
  defs: ProjectDef[],
  sessions: ActiveSession[],
): Map<string, ProjectSessionRollup> {
  const map = new Map<string, ProjectSessionRollup>();
  const prSeen = new Map<string, Set<string>>();
  const ticketSeen = new Map<string, Set<string>>();

  for (const s of sessions) {
    const name = projectNameForCwd(s.cwd, defs);
    if (!name) continue;
    let r = map.get(name);
    if (!r) {
      r = blank(name);
      map.set(name, r);
      prSeen.set(name, new Set());
      ticketSeen.set(name, new Set());
    }
    r.agents++;
    r.byStatus[s.status] = (r.byStatus[s.status] ?? 0) + 1;
    const member: ProjectMember = { agent: s.kind, status: s.status };
    if (s.ticket?.id) member.ticket = s.ticket.id;
    if (s.machine) member.host = s.machine;
    r.members.push(member);
    if (s.todos) {
      r.plan.done += s.todos.done;
      r.plan.total += s.todos.total;
    }
    if (s.pr?.url && !prSeen.get(name)!.has(s.pr.url)) {
      prSeen.get(name)!.add(s.pr.url);
      r.openPrs.push({ url: s.pr.url, number: s.pr.number });
    }
    const tset = ticketSeen.get(name)!;
    for (const t of [s.ticket?.id, ...(s.createdTickets ?? [])]) {
      if (t && !tset.has(t)) {
        tset.add(t);
        r.tickets.push(t);
      }
    }
    if (s.worktree) r.worktrees++;
  }
  return map;
}

/** Statuses meaning the session is over, per `commands/sessions.ts`: "`closed` and `crashed` are
 * unconditionally dead". `orphaned` is not: `session/active.ts` defines it as alive with no client
 * attached, so counting it dead would understate the unattended running sessions. */
const DEAD_STATUSES = new Set(['closed', 'crashed']);

/** True when a session's status means it is over. Exported so the roster keeps to live sessions: a
 * `crashed x25` beside `23 live` makes the reader distrust both numbers. */
export function isDeadStatus(status: string): boolean {
  return DEAD_STATUSES.has(status);
}

/* Where each `ActiveStatus` lands. Live: running, idle, queued, input_required, orphaned (outlived
 * its window), abandoned (transcript stale; may be forgotten but alive), unknown (can't prove
 * dead). Dead: closed, crashed, per commands/sessions.ts. */

/** Live vs finished sessions on a project. */
interface LiveDeadSplit {
  live: number;
  dead: number;
  /** Dead broken out by status, for the card's parenthetical. */
  deadByStatus: Array<{ status: string; n: number }>;
}

/** Split a rollup's sessions into working and wreckage. The headline used to be the raw count (`39
 * agents` with 19 crashed), which is no throughput signal, but the crashed count is itself worth
 * showing. */
export function liveDeadSplit(byStatus: Partial<Record<ActiveStatus, number>>): LiveDeadSplit {
  let live = 0;
  let dead = 0;
  const deadByStatus: Array<{ status: string; n: number }> = [];
  for (const [status, n] of Object.entries(byStatus)) {
    if (!n) continue;
    if (DEAD_STATUSES.has(status)) {
      dead += n;
      deadByStatus.push({ status, n });
    } else {
      live += n;
    }
  }
  deadByStatus.sort((a, b) => b.n - a.n || a.status.localeCompare(b.status));
  return { live, dead, deadByStatus };
}

/** The `dead` row body: `41 crashed` when all dead sessions share a status, else `12 finished or
 * lost (8 crashed, 4 closed)`; the generic wording only helps when statuses differ. Pure apart from
 * chalk; the caller adds the label and gates on `split.dead > 0`. */
export function formatDeadSummary(split: LiveDeadSplit): string {
  if (split.deadByStatus.length === 1) {
    return chalk.yellow(`${split.dead} ${split.deadByStatus[0].status}`);
  }
  const detail = split.deadByStatus.map((d) => `${d.n} ${d.status}`).join(', ');
  return `${chalk.yellow(`${split.dead} finished or lost`)} ${chalk.dim(`(${detail})`)}`;
}

/** Display order for the members line: running, idle, need-input, queued, then everything else,
 * ascending by status then agent name within a state. */
const MEMBER_STATUS_RANK: Record<string, number> = { running: 0, idle: 1, input_required: 2, queued: 3 };

/** Sort members for the card: running first, then idle, then the rest; agent name asc within a state. */
export function sortProjectMembers(members: ProjectMember[]): ProjectMember[] {
  return [...members].sort((a, b) => {
    const ra = MEMBER_STATUS_RANK[a.status] ?? 4;
    const rb = MEMBER_STATUS_RANK[b.status] ?? 4;
    if (ra !== rb) return ra - rb;
    if (ra === 4 && a.status !== b.status) return a.status.localeCompare(b.status);
    return a.agent.localeCompare(b.agent);
  });
}

/** Cap for the members line before it collapses to `+N more`. */
export const MEMBERS_LINE_LIMIT = 6;

/** Cap for host groups on the multi-line agents roster. */
const MEMBERS_HOST_LIMIT = 8;

/** Collapse members into distinct state cells (`agent · status · ticket[@host]`), counting
 * duplicates as `×N`. Pure. */
function collapseMemberCells(
  members: ProjectMember[],
  opts: { includeHostOnCell?: boolean } = {},
): Array<{ cell: string; n: number; members: number }> {
  const includeHost = opts.includeHostOnCell !== false;
  const counts = new Map<string, { cell: string; n: number }>();
  for (const m of sortProjectMembers(members)) {
    const parts = [m.agent, m.status];
    if (m.ticket) parts.push(m.ticket);
    const cell = parts.join(' · ') + (includeHost && m.host ? ` @${m.host}` : '');
    const key = cell.toLowerCase();
    const entry = counts.get(key);
    if (entry) entry.n++;
    else counts.set(key, { cell, n: 1 });
  }
  return [...counts.values()].map(({ cell, n }) => ({ cell, n, members: n }));
}

function formatCollapsedCells(
  cells: Array<{ cell: string; n: number; members: number }>,
  memberTotal: number,
  limit: number,
): string {
  if (cells.length === 0) return '';
  const shown = cells.slice(0, Math.max(1, limit));
  const shownMembers = shown.reduce((acc, e) => acc + e.members, 0);
  const more = memberTotal - shownMembers;
  const parts = shown.map(({ cell, n }) => (n > 1 ? `${cell} ×${n}` : cell));
  return parts.join(chalk.dim('  ·  ')) + (more > 0 ? chalk.dim(`  ·  +${more} more`) : '');
}

/** The `agents` line under `live`: one cell per DISTINCT member state (`claude · running · RUSH-2107
 * @zion`), identical cells collapsed to `×N`, capped at {@link MEMBERS_LINE_LIMIT} with a `+N more`
 * tail. Prefer {@link formatProjectMembersByHost}: a flat line hides the machine. */
export function formatProjectMembers(members: ProjectMember[], limit = MEMBERS_LINE_LIMIT): string {
  if (members.length === 0) return '';
  return formatCollapsedCells(collapseMemberCells(members, { includeHostOnCell: true }), members.length, limit);
}

/** Host-grouped agents roster, one line per host (`@zion  claude · running ×9  ·  claude · idle
 * ×4`); with no host on any member, falls back to the flat {@link formatProjectMembers} line. Pure. */
export function formatProjectMembersByHost(
  members: ProjectMember[],
  opts: { cellLimit?: number; hostLimit?: number } = {},
): string[] {
  if (members.length === 0) return [];
  const cellLimit = opts.cellLimit ?? MEMBERS_LINE_LIMIT;
  const hostLimit = opts.hostLimit ?? MEMBERS_HOST_LIMIT;

  const byHost = new Map<string, ProjectMember[]>();
  let anyHost = false;
  for (const m of members) {
    if (m.host) anyHost = true;
    const key = m.host ?? '';
    const list = byHost.get(key);
    if (list) list.push(m);
    else byHost.set(key, [m]);
  }

  // Local-only (no host stamps at all) — keep the compact one-liner.
  if (!anyHost) {
    const line = formatProjectMembers(members, cellLimit);
    return line ? [line] : [];
  }

  // Hosts with the most members first, then name; unstamped ("") last.
  const hosts = [...byHost.entries()].sort((a, b) => {
    if (a[0] === '' && b[0] !== '') return 1;
    if (b[0] === '' && a[0] !== '') return -1;
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    return a[0].localeCompare(b[0]);
  });

  const shownHosts = hosts.slice(0, Math.max(1, hostLimit));
  const hiddenMembers = hosts.slice(hostLimit).reduce((acc, [, ms]) => acc + ms.length, 0);
  const hostWidth = Math.max(
    ...shownHosts.map(([h]) => (h ? `@${h}` : '@local').length),
    1,
  );

  const lines = shownHosts.map(([host, ms]) => {
    const label = (host ? `@${host}` : '@local').padEnd(hostWidth);
    // Host is the row key — do not repeat @host on every cell.
    const cells = collapseMemberCells(ms, { includeHostOnCell: false });
    const body = formatCollapsedCells(cells, ms.length, cellLimit);
    return `${chalk.cyan(label)}  ${body}`;
  });

  if (hiddenMembers > 0) {
    const restHosts = hosts.length - shownHosts.length;
    lines.push(chalk.dim(`+${hiddenMembers} more on ${restHosts} host${restHosts === 1 ? '' : 's'}`));
  }
  return lines;
}

/** A card-level warning collected for the footer. */
export type ProjectWarningSeverity = 'critical' | 'continue';

export interface ProjectWarning {
  severity: ProjectWarningSeverity;
  /** One human line. */
  text: string;
  /** Optional fix or next step. */
  remediation?: string;
}

/** Severity markers for the warnings footer: critical stops you (wrong repo, missing checkout, large
 * drift); continue is a soft nudge (dirty tree, schedule not measurable). */
export function warningEmoji(severity: ProjectWarningSeverity): string {
  return severity === 'critical' ? '🔴' : '⚠️';
}

/** Stable sort: critical first, then continue; stable within a tier. */
function sortProjectWarnings(warnings: ProjectWarning[]): ProjectWarning[] {
  const rank = { critical: 0, continue: 1 };
  return [...warnings].sort((a, b) => rank[a.severity] - rank[b.severity] || a.text.localeCompare(b.text));
}

/** Format warning lines for the card footer. Pure (chalk only); empty when there is nothing to say. */
export function formatProjectWarnings(warnings: ProjectWarning[]): string[] {
  if (warnings.length === 0) return [];
  const lines: string[] = [];
  for (const w of sortProjectWarnings(warnings)) {
    const mark = warningEmoji(w.severity);
    const color = w.severity === 'critical' ? chalk.red : chalk.yellow;
    lines.push(`  ${mark}  ${color(w.text)}`);
    if (w.remediation) lines.push(`      ${chalk.dim(w.remediation)}`);
  }
  return lines;
}

/** Harvested signals not on the session list: repo-global merged PRs + releases, local artifacts, in a time window. */
export interface ProjectRemoteSignals {
  windowDays: number;
  /** PRs merged into the primary repo within the window (via `gh`). */
  mergedPrs: number;
  /** True when the `gh` fetch cap cut the count short: `mergedPrs` is then a LOWER bound (rendered
   * `100+`), same contract as `LinearProjectCounts.truncated`. */
  mergedPrsTruncated?: boolean;
  /** Artifacts agents produced within the window (activity.created milestones). */
  artifacts: number;
  /** Basename of the most recent artifact, when any. */
  lastArtifact?: string;
  /** Latest release of the PRIMARY repo (via `gh release list`), when any. */
  latestRelease?: { tag: string; publishedAt: string };
}

/** Harvest signals not on the session list: recently merged PRs (via `gh`) and agent artifacts
 * (local milestone log, matched by cwd). Best-effort: a missing `gh`, no auth, or no repo degrades
 * to zero so `projects status` still renders. `nowMs` is injected for tests. */
export async function enrichProjectSignals(
  def: ProjectDef,
  windowDays: number,
  nowMs: number,
  opts: { activityRoot?: string; skipRemote?: boolean } = {},
): Promise<ProjectRemoteSignals> {
  const sinceMs = nowMs - windowDays * 86_400_000;
  const out: ProjectRemoteSignals = { windowDays, mergedPrs: 0, artifacts: 0 };

  try {
    const evs = readRecentActivity({ events: ['artifact.created'], sinceMs, root: opts.activityRoot });
    const mine = evs.filter((e) => projectNameForCwd(e.cwd, [def]) === def.name);
    out.artifacts = mine.length;
    if (mine.length && typeof mine[0].detail === 'string') out.lastArtifact = mine[0].detail;
  } catch {
    /* activity log unreadable — best-effort */
  }

  if (def.repo && !opts.skipRemote) {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['pr', 'list', '--repo', def.repo, '--state', 'merged', '--json', 'number,mergedAt', '--limit', String(MERGED_PR_LIMIT)],
        { timeout: 8000, encoding: 'utf8' },
      );
      const rows = JSON.parse(stdout) as { mergedAt?: string }[];
      out.mergedPrs = rows.filter((r) => r.mergedAt && Date.parse(r.mergedAt) >= sinceMs).length;
      // `--limit 100` caps the fetch, so a repo with all 100 latest merges inside the window has
      // MORE than 100 (this one does). Say `100+` rather than presenting a cap as a count, per
      // `LinearProjectCounts.truncated`.
      if (rows.length >= MERGED_PR_LIMIT && out.mergedPrs >= MERGED_PR_LIMIT) out.mergedPrsTruncated = true;
    } catch {
      /* gh missing / unauthenticated / repo not found — skip this signal */
    }
    // Latest release of the PRIMARY repo only (repos[] is deliberately not
    // scanned — one release line per card). Same best-effort degradation.
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['release', 'list', '-R', def.repo, '-L', '1', '--json', 'tagName,publishedAt'],
        { timeout: 8000, encoding: 'utf8' },
      );
      const rows = JSON.parse(stdout) as { tagName?: string; publishedAt?: string }[];
      const first = rows[0];
      if (first?.tagName) out.latestRelease = { tag: first.tagName, publishedAt: first.publishedAt ?? '' };
    } catch {
      /* gh missing / unauthenticated / repo has no releases — skip this signal */
    }
  }
  return out;
}
