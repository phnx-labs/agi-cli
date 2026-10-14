import { sessionHeadline } from '../session/title.js';

export interface RosterRow {
  id: string;
  title: string;
  status: string;
  host: string;
  project?: string;
  cwd?: string;
  ticket?: string;
}

export type RosterSnapshot = Record<string, RosterRow>;

type Row = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
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
  };
}

export class FeedRoster {
  private readonly byScope = new Map<string, Map<string, RosterRow>>();
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

export function formatRosterRow(row: RosterRow): string {
  const ticket = row.ticket ? ` ${row.ticket}` : '';
  return `- ${row.id.slice(0, 8)} “${row.title}” ${row.status} on ${row.host}${ticket}`;
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
