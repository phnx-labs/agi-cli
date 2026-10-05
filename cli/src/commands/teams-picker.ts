/**
 * Interactive team picker and table renderer.
 *
 * Provides the fuzzy-searchable team list for `agents teams list` in a TTY,
 * and the non-interactive table fallback when output is piped. Builds rich
 * preview panels showing teammate composition, status breakdown, and last
 * activity for each team.
 */
import chalk from 'chalk';
import { relTime, truncate, humanDuration } from '../lib/format.js';
import { itemPicker } from '../lib/picker.js';
import type { AgentStatusDetail, TaskInfo } from '../lib/teams/api.js';
import { deliveryDisplayLabel, deliveryColorKey, type TeammateDelivery } from '../lib/teams/delivery.js';

export interface TeamRow {
  team: TaskInfo;
  agents: AgentStatusDetail[];
  description?: string;
  /** Short id of the session that spawned this team, when the index knows it. */
  spawnedBy?: string;
}

interface PickedTeam {
  team: string;
}

const AGENT_LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
};

const DOT = chalk.gray(' · ');

function statusColor(status: string): (s: string) => string {
  switch (status) {
    case 'pending': return chalk.blue;
    case 'running': return chalk.yellow;
    case 'completed': return chalk.green;
    case 'stranded': return chalk.yellow;
    case 'failed': return chalk.red;
    case 'stopped': return chalk.gray;
    default: return chalk.white;
  }
}

function firstLine(s: string): string {
  // Collapse to the first non-empty line so multi-line messages (markdown,
  // code blocks) render cleanly inside a one-line preview slot.
  for (const line of s.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function compactPrompt(s: string, max = 140): string {
  return truncate(s.replace(/\s+/g, ' ').trim(), max);
}

function formatTimestamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function displayAgent(agent: string, version?: string | null): string {
  const label = AGENT_LABEL[agent] || agent;
  return version ? `${label}@${version}` : label;
}

// Aggregated status cell: a single colored label when the team is uniform
// (everyone done / everyone working), or a dotted breakdown when mixed.
function statusCell(t: TaskInfo): string {
  if (t.agent_count === 0) return chalk.gray('empty');
  const done = Math.max(0, t.completed - (t.stranded ?? 0));
  const states: Array<[number, (s: string) => string, string]> = [
    [t.pending, chalk.blue, 'pending'],
    [t.running, chalk.yellow, 'working'],
    [done, chalk.green, 'done'],
    [t.stranded ?? 0, chalk.yellow, 'stranded'],
    [t.failed, chalk.red, 'failed'],
    [t.stopped, chalk.gray, 'stopped'],
  ];
  const nonzero = states.filter(([n]) => n > 0);
  if (nonzero.length === 1) {
    const [, color, label] = nonzero[0];
    return color(label);
  }
  return nonzero.map(([n, color, label]) => color(`${n} ${label}`)).join(chalk.gray(' · '));
}

function statusSummaryParts(t: TaskInfo): string[] {
  const done = Math.max(0, t.completed - (t.stranded ?? 0));
  const parts: string[] = [];
  if (t.pending) parts.push(chalk.blue(`${t.pending} pending`));
  if (t.running) parts.push(chalk.yellow(`${t.running} working`));
  if (done) parts.push(chalk.green(`${done} done`));
  if (t.stranded) parts.push(chalk.yellow(`${t.stranded} stranded`));
  if (t.failed) parts.push(chalk.red(`${t.failed} failed`));
  if (t.stopped) parts.push(chalk.gray(`${t.stopped} stopped`));
  return parts;
}

// "claude×4" for a homogeneous team; "claude×2 codex" when mixed. Counts only
// show when > 1 — "codex" alone is cleaner than "codex×1".
function formatComposition(agents: AgentStatusDetail[]): string {
  if (agents.length === 0) return '';
  const counts = new Map<string, number>();
  for (const a of agents) {
    counts.set(a.agent_type, (counts.get(a.agent_type) || 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => (n === 1 ? type : `${type}×${n}`));
  return parts.join(' ');
}


function runtimeSpan(t: TaskInfo): string {
  const startMs = new Date(t.created_at).getTime();
  const endMs = new Date(t.modified_at).getTime();
  const ms = Math.max(0, endMs - startMs);
  if (ms < 1000) return '';
  return humanDuration(ms);
}

// Prefer "files modified" as the work signal — it answers "what did this cost
// me in change footprint". Fall back to tool count for read-only teams so the
// column never disappears silently.
function workCell(agents: AgentStatusDetail[]): string {
  const files = agents.reduce((n, a) => n + a.files_modified.length, 0);
  if (files > 0) return `${files} file${files === 1 ? '' : 's'}`;
  const tools = agents.reduce((n, a) => n + a.tool_count, 0);
  if (tools > 0) return `${tools} tool${tools === 1 ? '' : 's'}`;
  return '';
}

/** Format a single team as a one-line row for the list table or picker label. */
function formatTeamRow(row: TeamRow, nameWidth: number, compositionWidth: number): string {
  const t = row.team;
  const name = chalk.cyan(t.task_name.padEnd(nameWidth));
  const composition = chalk.white(formatComposition(row.agents).padEnd(compositionWidth));
  const status = statusCell(t);
  const work = workCell(row.agents);
  const runtime = runtimeSpan(t);
  const age = chalk.gray(relTime(t.modified_at));

  const spawnedBy = row.spawnedBy ? chalk.green(`by ${row.spawnedBy}`) : '';
  const middleParts = [status, work, runtime, spawnedBy].filter(Boolean);
  const middle = middleParts.join(chalk.gray(' · '));

  return `${name}  ${composition}  ${middle}${middle ? chalk.gray(' · ') : ''}${age}`;
}

function handle(a: AgentStatusDetail): string {
  return a.name || a.agent_id.slice(0, 8);
}

function displayHandle(a: AgentStatusDetail): string {
  if (a.name && a.session_label && a.name !== a.session_label) {
    return `${a.name} / ${a.session_label}`;
  }
  return a.name || a.session_label || a.agent_id.slice(0, 8);
}

/** Build a multi-line preview string for the picker's detail pane. */
function buildTeamPreview(row: TeamRow): string {
  const t = row.team;
  const lines: string[] = [];

  const head: string[] = [];
  head.push(chalk.bold.white(t.task_name));
  head.push(chalk.gray(`created ${relTime(t.created_at)}`));
  if (t.modified_at !== t.created_at) {
    head.push(chalk.gray(`last activity ${relTime(t.modified_at)}`));
  }
  const summary = statusSummaryParts(t);
  if (summary.length) head.push(summary.join(' '));
  lines.push(head.join(DOT));

  if (row.description) {
    lines.push(chalk.gray(row.description));
  }

  if (row.agents.length === 0) {
    lines.push('');
    lines.push(chalk.gray('  (no teammates yet — add one with `agents teams add`)'));
    return lines.join('\n');
  }

  lines.push('');

  // Column widths
  const nameW = Math.max(6, ...row.agents.map((a) => displayHandle(a).length));
  const agentW = Math.max(8, ...row.agents.map((a) => displayAgent(a.agent_type, a.version).length));

  for (const a of row.agents) {
    const delivery = a.delivery as TeammateDelivery | undefined;
    const colorKey = delivery ? deliveryColorKey(delivery, a.status) : a.status;
    const label = delivery
      ? deliveryDisplayLabel(delivery, a.status)
      : a.status.toUpperCase();
    const stat = statusColor(colorKey)(label);
    const metaParts: string[] = [];
    if (a.task_type) metaParts.push(chalk.magenta(a.task_type));
    if (a.duration) metaParts.push(chalk.white(a.duration));
    metaParts.push(chalk.gray(`${a.tool_count} tools`));
    const modified = a.files_modified.length;
    if (modified) metaParts.push(chalk.gray(`${modified} file${modified === 1 ? '' : 's'} modified`));
    const meta = metaParts.join(DOT);

    lines.push(
      `  ${chalk.cyan(displayHandle(a).padEnd(nameW))}  ${displayAgent(a.agent_type, a.version).padEnd(agentW)}  ${stat}${DOT}${meta}`
    );

    if (a.prompt) {
      lines.push(`    ${chalk.gray('task')} ${chalk.white(compactPrompt(a.prompt))}`);
    }
    const started = formatTimestamp(a.started_at);
    const completed = formatTimestamp(a.completed_at);
    if (started || completed) {
      const parts = [];
      if (started) parts.push(`started ${started}`);
      if (completed) parts.push(`ended ${completed}`);
      lines.push(`    ${chalk.gray(parts.join(' · '))}`);
    }

    for (const call of a.recent_tool_calls.slice(-3)) {
      const when = call.timestamp ? `${relTime(call.timestamp)} ` : '';
      lines.push(`    ${chalk.gray(when)}${chalk.bold(call.tool)} ${chalk.gray(truncate(call.summary, 96))}`);
    }

    const lastMsg = a.last_messages[a.last_messages.length - 1];
    if (lastMsg) {
      const oneLine = firstLine(lastMsg);
      if (oneLine) {
        lines.push(`    ${chalk.gray('└')} ${chalk.gray(truncate(oneLine, 96))}`);
      }
    }
    if (a.has_errors) {
      lines.push(`    ${chalk.red('!')} ${chalk.red('reported an error')}`);
    }
  }

  return lines.join('\n');
}

/** Print a non-interactive team table to stdout (used when output is piped). */
export function printTeamTable(rows: TeamRow[]): void {
  if (rows.length === 0) return;
  const nameWidth = Math.max(12, ...rows.map((r) => r.team.task_name.length));
  const compositionWidth = Math.max(
    8,
    ...rows.map((r) => formatComposition(r.agents).length)
  );
  for (const row of rows) {
    console.log(formatTeamRow(row, nameWidth, compositionWidth));
  }
  console.log(chalk.gray(`\n${rows.length} team${rows.length === 1 ? '' : 's'}.`));
}

// Build a searchable blob from every field that would help a user find a team:
// name, description, each teammate's agent type, version, and handle. Lowercased
// once so the per-keystroke filter is a straight `includes` per term.
function searchHaystack(row: TeamRow): string {
  const parts: string[] = [row.team.task_name];
  if (row.description) parts.push(row.description);
  for (const a of row.agents) {
    parts.push(a.agent_type);
    if (a.version) parts.push(a.version);
    if (a.name) parts.push(a.name);
    // Include each teammate's live status so "failed", "working", "stopped"
    // are searchable.
    parts.push(a.status);
  }
  // Also include team-level status words exposed in the row ("done",
  // "working", "pending", "stranded", "failed", "stopped", "empty") so the
  // search matches what the user sees on screen.
  const t = row.team;
  if (t.agent_count === 0) parts.push('empty');
  if (t.pending) parts.push('pending');
  if (t.running) parts.push('working', 'running');
  if (t.completed) parts.push('done', 'completed');
  if (t.stranded) parts.push('stranded');
  if (t.failed) parts.push('failed');
  if (t.stopped) parts.push('stopped');
  return parts.join(' ').toLowerCase();
}

/** Show an interactive team picker with fuzzy search and return the selected team name. */
export async function teamPicker(rows: TeamRow[], initialSearch?: string): Promise<PickedTeam | null> {
  const nameWidth = Math.max(12, ...rows.map((r) => r.team.task_name.length));
  const compositionWidth = Math.max(
    8,
    ...rows.map((r) => formatComposition(r.agents).length)
  );

  // Precompute haystacks so the filter stays O(terms × rows) per keystroke.
  const haystacks = new Map<TeamRow, string>();
  for (const r of rows) haystacks.set(r, searchHaystack(r));

  const picked = await itemPicker<TeamRow>({
    message: 'Select a team:',
    items: rows,
    filter: (query: string) => {
      const trimmed = query.trim().toLowerCase();
      if (!trimmed) return rows;
      // Multi-term AND: every whitespace-split term must match somewhere. This
      // lets "claude done" surface claude-only teams that finished, and
      // "alice working" surface teams where alice is still running.
      const terms = trimmed.split(/\s+/).filter(Boolean);
      return rows.filter((r) => {
        const hay = haystacks.get(r) || '';
        return terms.every((t) => hay.includes(t));
      });
    },
    labelFor: (row) => formatTeamRow(row, nameWidth, compositionWidth),
    buildPreview: buildTeamPreview,
    shortIdFor: (row) => row.team.task_name,
    pageSize: 10,
    initialSearch,
    emptyMessage: 'No teams match.',
    enterHint: 'view status',
  });

  if (!picked) return null;
  return { team: picked.item.team.task_name };
}
