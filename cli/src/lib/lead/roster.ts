import { sessionHeadline } from '../session/title.js';

export interface RosterRow {
  id: string;
  title: string;
  status: string;
  host: string;
  project?: string;
  cwd?: string;
  ticket?: string;
  startedAtMs?: number;
  lastActivityMs?: number;
}

export type RosterSnapshot = Record<string, RosterRow>;

export interface LeadAttention {
  key: string;
  sessionId: string;
  host: string;
  project?: string;
  kind: string;
  openedAt: string;
  question?: string;
  choices: Array<{ id: string; label: string }>;
}

type Row = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

export function rosterRowFromFeed(scope: string, agent: Row): RosterRow | null {
  const id = str(agent.sessionId);
  if (!id || agent.previous === true) return null;
  return {
    id,
    title: str(agent.title)
      ?? sessionHeadline({ label: str(agent.label), generatedTitle: str(agent.generatedTitle), topic: str(agent.topic) })
      ?? id.slice(0, 8),
    status: str(agent.status) ?? 'unknown',
    host: str(agent.machine) ?? scope,
    project: str(agent.confirmedProject),
    cwd: str(agent.cwd),
    ticket: str(agent.ticketId),
    startedAtMs: num(agent.startedAtMs),
    lastActivityMs: num(agent.lastActivityMs),
  };
}

export function attentionFromFeed(item: Row): LeadAttention | null {
  const key = str(item.key);
  const sessionId = str(item.sessionId);
  if (!key || !sessionId || item.state !== 'open') return null;
  const question = (item.question ?? {}) as Row;
  const choices = Array.isArray(item.choices) ? (item.choices as Row[]) : [];
  return {
    key,
    sessionId,
    host: str(item.host) ?? key.split('/')[0],
    project: str(item.project),
    kind: str(item.kind) ?? 'question',
    openedAt: str(item.openedAt) ?? '',
    question: str(question.text) ?? str(question.header),
    choices: choices.flatMap((c) => (str(c.id) ? [{ id: String(c.id), label: str(c.label) ?? String(c.id) }] : [])),
  };
}

export class FeedRoster {
  private readonly byScope = new Map<string, Map<string, RosterRow>>();
  private readonly attentionByScope = new Map<string, Map<string, LeadAttention>>();
  private readonly scopesSeen = new Set<string>();
  private readonly waiters: Array<() => void> = [];

  apply(envelope: Row): void {
    const scope = str(envelope.scope) ?? '';
    switch (envelope.type) {
      case 'reset': {
        const rows = new Map<string, RosterRow>();
        for (const agent of (envelope.agents as Row[] | undefined) ?? []) {
          const row = rosterRowFromFeed(scope, agent);
          if (row) rows.set(String(agent.rowKey ?? row.id), row);
        }
        this.byScope.set(scope, rows);
        const asks = new Map<string, LeadAttention>();
        for (const item of (envelope.attention as Row[] | undefined) ?? []) {
          const ask = attentionFromFeed(item);
          if (ask) asks.set(ask.key, ask);
        }
        this.attentionByScope.set(scope, asks);
        this.scopesSeen.add(scope);
        for (const wake of this.waiters.splice(0)) wake();
        return;
      }
      case 'agent.upsert': {
        const rows = this.scopeRows(scope);
        const key = String(envelope.rowKey);
        const row = rosterRowFromFeed(scope, (envelope.agent as Row) ?? {});
        if (row) rows.set(key, row);
        else rows.delete(key);
        return;
      }
      case 'agent.remove':
        this.scopeRows(scope).delete(String(envelope.rowKey));
        return;
      case 'attention.upsert': {
        const asks = this.scopeAttention(scope);
        const key = String(envelope.rowKey);
        const ask = attentionFromFeed((envelope.attention as Row) ?? {});
        if (ask) asks.set(key, ask);
        else asks.delete(key);
        return;
      }
      case 'attention.remove':
        this.scopeAttention(scope).delete(String(envelope.rowKey));
        return;
      default:
        return;
    }
  }

  get ready(): boolean {
    return this.scopesSeen.size > 0;
  }

  whenReady(timeoutMs: number): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.ready), timeoutMs);
      timer.unref();
      this.waiters.push(() => { clearTimeout(timer); resolve(true); });
    });
  }

  snapshot(): RosterSnapshot {
    const out: RosterSnapshot = {};
    for (const rows of this.byScope.values()) {
      for (const row of rows.values()) out[row.id] = row;
    }
    return out;
  }

  openAttention(): LeadAttention[] {
    const out = new Map<string, LeadAttention>();
    for (const asks of this.attentionByScope.values()) for (const ask of asks.values()) out.set(ask.key, ask);
    return [...out.values()].sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  }

  private scopeAttention(scope: string): Map<string, LeadAttention> {
    let asks = this.attentionByScope.get(scope);
    if (!asks) { asks = new Map(); this.attentionByScope.set(scope, asks); }
    return asks;
  }

  private scopeRows(scope: string): Map<string, RosterRow> {
    let rows = this.byScope.get(scope);
    if (!rows) { rows = new Map(); this.byScope.set(scope, rows); }
    return rows;
  }
}

export function filterProject(
  snapshot: RosterSnapshot,
  project: string,
  projectForCwd: (cwd: string | undefined) => string | undefined,
  exclude: ReadonlySet<string> = new Set(),
): RosterSnapshot {
  const out: RosterSnapshot = {};
  for (const row of Object.values(snapshot)) {
    if (exclude.has(row.id)) continue;
    if ((projectForCwd(row.cwd) ?? row.project) === project) out[row.id] = row;
  }
  return out;
}

export function formatRosterRow(row: RosterRow, nowMs = Date.now()): string {
  const ticket = row.ticket ? ` ${row.ticket}` : '';
  const started = row.startedAtMs ? ` · started ${ago(row.startedAtMs, nowMs)}` : '';
  const active = row.lastActivityMs ? ` · last active ${ago(row.lastActivityMs, nowMs)}` : '';
  return `- ${row.id.slice(0, 8)} “${row.title}” ${row.status} on ${row.host}${ticket}${started}${active}`;
}

export function rosterDelta(prev: RosterSnapshot | null, cur: RosterSnapshot): string[] {
  if (!prev) {
    const rows = Object.values(cur);
    return rows.length === 0 ? ['No live sessions for this project.'] : rows.map(formatRosterRow);
  }
  const lines: string[] = [];
  for (const row of Object.values(cur)) {
    const before = prev[row.id];
    if (!before) lines.push(`+ started ${row.id.slice(0, 8)} “${row.title}” ${row.status} on ${row.host}`);
    else if (before.status !== row.status) lines.push(`~ ${row.id.slice(0, 8)} “${row.title}” ${before.status} → ${row.status}`);
    else if (before.title !== row.title) lines.push(`~ ${row.id.slice(0, 8)} renamed “${before.title}” → “${row.title}”`);
  }
  for (const row of Object.values(prev)) {
    if (!cur[row.id]) lines.push(`- ended ${row.id.slice(0, 8)} “${row.title}” (was ${row.status} on ${row.host})`);
  }
  return lines;
}

const MAX_QUESTION_CHARS = 240;

/** How long ago, in the words the Lead reads: "just now", "5m ago", "3h ago", "4d ago". */
export function ago(at: string | number, nowMs: number): string {
  const ms = nowMs - (typeof at === 'number' ? at : Date.parse(at));
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export function formatAttention(ask: LeadAttention, row: RosterRow | undefined, nowMs = Date.now()): string {
  const question = (ask.question ?? `(${ask.kind}, no question text)`).replace(/\s+/g, ' ').trim();
  const trimmed = question.length > MAX_QUESTION_CHARS ? `${question.slice(0, MAX_QUESTION_CHARS - 1)}…` : question;
  const title = row?.title ?? ask.sessionId.slice(0, 8);
  const project = ask.project ?? row?.project;
  const choices = ask.choices.length ? ` Choices: ${ask.choices.map((c) => `${c.id}=${c.label}`).join(', ')}` : ' Free-text answer.';
  return `- ${ask.key} “${title}” on ${ask.host}${project ? ` · ${project}` : ''} · ${ago(ask.openedAt, nowMs)}: ${trimmed}${choices}`;
}
