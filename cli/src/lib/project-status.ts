/**
 * Project-level progress rollup — the headline of the projects subsystem.
 *
 * At 50–100 agents the per-agent activity line is noise; what matters is the
 * PROJECT. This aggregates the signals already carried per session (status,
 * plan progress, open PRs, tickets, worktrees) into one row per project, keyed
 * by matching each session's cwd to a defined project root (`projectNameForCwd`).
 * The session set is whatever the caller passes (today `getActiveSessions()` —
 * this machine's live view, matched by local-home cwd; a fleet-wide fan-out is a
 * deferred follow-up). Pure over an `ActiveSession[]` so the aggregation is
 * unit-testable; the merged-PR signal IS repo-global (harvested via `gh`) and the
 * artifact signal is local, both added in `enrichProjectSignals`.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import type { ActiveSession, ActiveStatus } from './session/active.js';
import { projectNameForCwd, type ProjectDef } from './projects.js';
import { readRecentActivity } from './feed/activity.js';

const execFileAsync = promisify(execFile);

/**
 * How many recent merges `gh` is asked for. A repo busy enough that all of them
 * land inside the window has more than this — agents-cli itself merged 100 of
 * its 100 most recent PRs within 7 days — so the count is reported as a lower
 * bound rather than as a total.
 */
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

/**
 * Roll active sessions up by project. Returns a map keyed by project name,
 * containing only projects with at least one matched session — callers merge
 * with the full definition list to show zero-agent projects.
 */

/**
 * Ensure every session carries a host for the card roster. Local
 * `getActiveSessions()` omits `machine`; remotes already set it. Pure.
 */
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

/**
 * Statuses that mean the session is over. Taken from the repo's own rule
 * (`commands/sessions.ts`): "`closed` and `crashed` are unconditionally dead".
 * `orphaned` is NOT among them — `session/active.ts` defines it as "Alive, but
 * no client is attached", i.e. the agent outlived its window and is still
 * working. Counting it as dead understates the project by exactly the sessions
 * that are running unattended.
 */
const DEAD_STATUSES = new Set(['closed', 'crashed']);

/**
 * True when a session's status means it is over. Exported so the card can keep
 * the `agents` roster to live sessions: the headline and the `dead` row already
 * separate the two, and a roster that reads `crashed ×25` beside `23 live`
 * makes the reader distrust both numbers.
 */
export function isDeadStatus(status: string): boolean {
  return DEAD_STATUSES.has(status);
}

/*
 * Every `ActiveStatus`, and why it lands where it does:
 *
 *   running, idle, queued, input_required   live — obviously working or waiting
 *   orphaned                                live — "alive, but no client is
 *                                           attached"; the agent outlived its
 *                                           window and is still running
 *   abandoned                               live — it fires on transcript
 *                                           staleness BEFORE the liveness check,
 *                                           so it also covers the live-but-
 *                                           forgotten session that asked a
 *                                           question and sat over a weekend
 *   unknown                                 live — we cannot prove it is dead,
 *                                           and claiming so would overstate the
 *                                           wreckage row
 *   closed, crashed                         dead — unconditionally, per
 *                                           commands/sessions.ts
 */

/** Live vs finished sessions on a project. */
interface LiveDeadSplit {
  live: number;
  dead: number;
  /** Dead broken out by status, for the card's parenthetical. */
  deadByStatus: Array<{ status: string; n: number }>;
}

/**
 * Split a rollup's sessions into what is working and what is wreckage.
 *
 * The headline used to be the raw session count, which on a real project read
 * `39 agents` when 19 of those had crashed. A count that is half corpses is not
 * a throughput signal — but the corpses are worth their own number, because 19
 * crashed sessions is itself a thing to go fix.
 */
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

/**
 * The `dead` row body: `41 crashed` when every dead session shares one status,
 * else `12 finished or lost (8 crashed, 4 closed)`. The generic "finished or
 * lost" only earns its keep when the statuses actually differ — with a single
 * status it just hides which one behind a parenthetical that repeats the count.
 * Pure — chalk styling only; the caller adds the `dead` label. Assumes
 * `split.dead > 0` (the caller gates on it).
 */
export function formatDeadSummary(split: LiveDeadSplit): string {
  if (split.deadByStatus.length === 1) {
    return chalk.yellow(`${split.dead} ${split.deadByStatus[0].status}`);
  }
  const detail = split.deadByStatus.map((d) => `${d.n} ${d.status}`).join(', ');
  return `${chalk.yellow(`${split.dead} finished or lost`)} ${chalk.dim(`(${detail})`)}`;
}

/**
 * Display order for the members line: the states a human scans for first
 * (running, then idle, then need-input, then queued), everything else after,
 * status name then agent name ascending within a state.
 */
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

/**
 * Collapse members into distinct state cells (`agent · status · ticket[@host]`),
 * counting duplicates as `×N`. Pure.
 */
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

/**
 * The `agents` line under `live`: one cell per DISTINCT member state —
 * `claude · running · RUSH-2107 @zion` — with identical cells collapsed to a
 * `×N` count (35 same-harness sessions in one state are one fact, not six
 * truncated duplicates), capped at {@link MEMBERS_LINE_LIMIT} cells with a
 * `+N more` tail counting members, not cells. Pure (chalk styling only); the
 * caller adds the label.
 *
 * Prefer {@link formatProjectMembersByHost} on the card: a flat line hides which
 * machine is running the work when the same harness×status spans hosts.
 */
export function formatProjectMembers(members: ProjectMember[], limit = MEMBERS_LINE_LIMIT): string {
  if (members.length === 0) return '';
  return formatCollapsedCells(collapseMemberCells(members, { includeHostOnCell: true }), members.length, limit);
}

/**
 * Host-grouped agents roster. One content line per host:
 * `@zion  claude · running ×9  ·  claude · idle ×4`
 *
 * When no member carries a host (local-only rollup with no machine stamp), falls
 * back to a single flat line via {@link formatProjectMembers}. Pure.
 */
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

/**
 * Severity markers for the warnings footer. User-facing by design: critical
 * stops you (wrong repo, missing checkout, large drift); continue is a soft
 * nudge (dirty tree, schedule not measurable).
 */
export function warningEmoji(severity: ProjectWarningSeverity): string {
  return severity === 'critical' ? '🔴' : '⚠️';
}

/** Stable sort: critical first, then continue; stable within a tier. */
function sortProjectWarnings(warnings: ProjectWarning[]): ProjectWarning[] {
  const rank = { critical: 0, continue: 1 };
  return [...warnings].sort((a, b) => rank[a.severity] - rank[b.severity] || a.text.localeCompare(b.text));
}

/**
 * Format one or more warning lines for the card footer. Pure (chalk only).
 * Returns empty when there is nothing to say.
 */
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
  /**
   * True when the `gh` fetch cap cut the count short — `mergedPrs` is then a
   * LOWER bound (rendered `100+`), never presented as the complete count. Same
   * contract `LinearProjectCounts.truncated` keeps for the Linear line.
   */
  mergedPrsTruncated?: boolean;
  /** Artifacts agents produced within the window (activity.created milestones). */
  artifacts: number;
  /** Basename of the most recent artifact, when any. */
  lastArtifact?: string;
  /** Latest release of the PRIMARY repo (via `gh release list`), when any. */
  latestRelease?: { tag: string; publishedAt: string };
}

/**
 * Harvest the signals that don't live on the active-session list: recently
 * merged PRs (from GitHub via `gh`) and artifacts agents produced (from the
 * local activity-milestone log, matched to the project by cwd). Best-effort —
 * a missing `gh`, no auth, or no repo degrades to zero rather than throwing, so
 * `projects status` still renders. `nowMs` is injected for testability.
 */
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
      // `--limit 100` caps the fetch, so a busy repo where every one of the 100
      // most recent merges falls inside the window has MORE than 100 — this repo
      // really does. Say so (`100+`) rather than presenting a cap as a count,
      // the same contract `LinearProjectCounts.truncated` already keeps.
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
