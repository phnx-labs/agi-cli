
import { execFile } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import type { ActiveSession, ActiveStatus } from './session/active.js';
import { projectNameForCwd, type ProjectDef } from './projects.js';
import { readRecentActivity } from './feed/activity.js';

const execFileAsync = promisify(execFile);

const MERGED_PR_LIMIT = 100;

export interface ProjectMember {
  agent: string;
  status: string;
  ticket?: string;
  host?: string;
}

export interface ProjectSessionRollup {
  name: string;
  agents: number;
  byStatus: Partial<Record<ActiveStatus, number>>;
  members: ProjectMember[];
  plan: { done: number; total: number };
  openPrs: { url: string; number?: number }[];
  tickets: string[];
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

const DEAD_STATUSES = new Set(['closed', 'crashed']);

export function isDeadStatus(status: string): boolean {
  return DEAD_STATUSES.has(status);
}


interface LiveDeadSplit {
  live: number;
  dead: number;
  deadByStatus: Array<{ status: string; n: number }>;
}

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

export function formatDeadSummary(split: LiveDeadSplit): string {
  if (split.deadByStatus.length === 1) {
    return chalk.yellow(`${split.dead} ${split.deadByStatus[0].status}`);
  }
  const detail = split.deadByStatus.map((d) => `${d.n} ${d.status}`).join(', ');
  return `${chalk.yellow(`${split.dead} finished or lost`)} ${chalk.dim(`(${detail})`)}`;
}

const MEMBER_STATUS_RANK: Record<string, number> = { running: 0, idle: 1, input_required: 2, queued: 3 };

export function sortProjectMembers(members: ProjectMember[]): ProjectMember[] {
  return [...members].sort((a, b) => {
    const ra = MEMBER_STATUS_RANK[a.status] ?? 4;
    const rb = MEMBER_STATUS_RANK[b.status] ?? 4;
    if (ra !== rb) return ra - rb;
    if (ra === 4 && a.status !== b.status) return a.status.localeCompare(b.status);
    return a.agent.localeCompare(b.agent);
  });
}

export const MEMBERS_LINE_LIMIT = 6;

const MEMBERS_HOST_LIMIT = 8;

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

export function formatProjectMembers(members: ProjectMember[], limit = MEMBERS_LINE_LIMIT): string {
  if (members.length === 0) return '';
  return formatCollapsedCells(collapseMemberCells(members, { includeHostOnCell: true }), members.length, limit);
}

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

  if (!anyHost) {
    const line = formatProjectMembers(members, cellLimit);
    return line ? [line] : [];
  }

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

export type ProjectWarningSeverity = 'critical' | 'continue';

export interface ProjectWarning {
  severity: ProjectWarningSeverity;
  text: string;
  remediation?: string;
}

export function warningEmoji(severity: ProjectWarningSeverity): string {
  return severity === 'critical' ? '🔴' : '⚠️';
}

function sortProjectWarnings(warnings: ProjectWarning[]): ProjectWarning[] {
  const rank = { critical: 0, continue: 1 };
  return [...warnings].sort((a, b) => rank[a.severity] - rank[b.severity] || a.text.localeCompare(b.text));
}

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

export interface ProjectRemoteSignals {
  windowDays: number;
  mergedPrs: number;
  mergedPrsTruncated?: boolean;
  artifacts: number;
  lastArtifact?: string;
  latestRelease?: { tag: string; publishedAt: string };
}

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
      if (rows.length >= MERGED_PR_LIMIT && out.mergedPrs >= MERGED_PR_LIMIT) out.mergedPrsTruncated = true;
    } catch {
    }
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
    }
  }
  return out;
}
