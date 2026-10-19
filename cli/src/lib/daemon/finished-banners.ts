/**
 * Finished-turn banners: an interactive session whose turn ran at least two minutes
 * and went from running to idle posts one `done` banner, through the same
 * attention-notify tick and AGI Menu `--notify` path as the asks. A finish waits
 * FINISH_SETTLE_MS (the Stop hook's verdict lands, a flap back to running cancels it);
 * finishes that land together (each within the settle window of the last, at most
 * FINISH_BURST_WINDOW_MS in all) post as one banner, a summary when there are three or more.
 */

import type { ActiveSession } from '../session/active.js';
import type { DoneVerdict } from '../session/hook-sessions.js';
import { harnessOf } from '../feed/attention.js';
import { formatWaited } from '../feed/notify-schedule.js';
import type { DesktopNotification } from '../menubar/notify-desktop.js';

export const FINISH_MIN_WORK_MS = 2 * 60_000;
export const FINISH_SETTLE_MS = 15_000;
export const FINISH_BURST_WINDOW_MS = 60_000;
export const FINISH_BURST_MIN = 3;
const BODY_MAX = 200;
const VERDICT_SKEW_MS = 5_000;

export type FinishRow = Partial<Pick<ActiveSession,
  'sessionId' | 'status' | 'lead' | 'title' | 'label' | 'lastAgentLine' | 'doneVerdict' | 'userTurns'
  | 'harness' | 'kind' | 'project' | 'pr'>> & { context?: string; previous?: boolean };

export interface ObservedRow {
  scope: string;
  row: FinishRow;
}

export interface TurnFinish {
  scope: string;
  sessionId: string;
  turnStartMs: number;
  endedAtMs: number;
  row: FinishRow;
}

const GAP_WORDS: Record<string, string> = {
  'open-pr': 'a pull request is still open',
  'keep-moving': 'it stopped with work left to do',
  delivery: 'the delivery is not verified',
  'live-team': 'teammates are still running',
  'self-audit': 'it has not checked its own work',
};

function isInteractive(row: FinishRow): boolean {
  return row.context === 'terminal' && !row.lead && !row.previous && !!row.sessionId;
}

function lastUserTurnMs(row: FinishRow): number | undefined {
  const turns = row.userTurns ?? [];
  const at = turns.length ? turns[turns.length - 1]!.atMs : undefined;
  return typeof at === 'number' && Number.isFinite(at) ? at : undefined;
}

export class TurnFinishTracker {
  private readonly working = new Map<string, number>();
  private readonly idleAt = new Map<string, number>();
  private readonly pending = new Map<string, TurnFinish>();

  observe(rows: readonly ObservedRow[], nowMs: number): void {
    const present = new Set<string>();
    for (const { scope, row } of rows) {
      if (!isInteractive(row)) continue;
      const key = `${scope}/${row.sessionId}`;
      present.add(key);
      if (row.status === 'running') {
        const resumed = this.pending.get(key);
        if (resumed) {
          this.pending.delete(key);
          this.working.set(key, resumed.turnStartMs);
        } else if (!this.working.has(key)) {
          const asked = lastUserTurnMs(row);
          const idleAt = this.idleAt.get(key);
          this.working.set(key, asked !== undefined && asked <= nowMs && (idleAt === undefined || asked > idleAt) ? asked : nowMs);
        }
      } else if (row.status === 'idle') {
        const startMs = this.working.get(key);
        this.working.delete(key);
        this.idleAt.set(key, nowMs);
        const held = this.pending.get(key);
        if (held) held.row = row;
        else if (startMs !== undefined && nowMs - startMs >= FINISH_MIN_WORK_MS) {
          this.pending.set(key, { scope, sessionId: row.sessionId!, turnStartMs: startMs, endedAtMs: nowMs, row });
        }
      } else {
        this.working.delete(key);
        this.pending.delete(key);
      }
    }
    for (const map of [this.working, this.idleAt, this.pending]) {
      for (const key of map.keys()) if (!present.has(key)) map.delete(key);
    }
  }

  // The held finishes once the burst has settled; empty while one is still settling.
  due(nowMs: number): TurnFinish[] {
    if (this.pending.size === 0) return [];
    const ends = [...this.pending.values()].map((f) => f.endedAtMs);
    const settled = nowMs - Math.max(...ends) >= FINISH_SETTLE_MS;
    const capped = nowMs - Math.min(...ends) >= FINISH_BURST_WINDOW_MS;
    if (!settled && !capped) return [];
    const out = [...this.pending.values()].sort((a, b) => a.endedAtMs - b.endedAtMs);
    this.pending.clear();
    return out;
  }
}

function shorten(text: string, max = BODY_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  return end >= 0 ? flat.slice(0, end + 1) : flat;
}

function turnVerdict(finish: TurnFinish): DoneVerdict | undefined {
  const v = finish.row.doneVerdict;
  if (!v) return undefined;
  const at = Date.parse(v.at);
  return Number.isFinite(at) && at >= finish.turnStartMs - VERDICT_SKEW_MS ? v : undefined;
}

export function gapsInWords(gaps: readonly string[]): string {
  const words = gaps.map((g) => GAP_WORDS[g] ?? g.replace(/-/g, ' '));
  const text = words.join('; ');
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}.` : '';
}

function rowTitle(finish: TurnFinish): string {
  return finish.row.title?.trim() || finish.row.label?.trim() || finish.sessionId.slice(0, 8);
}

function verdictWord(v: DoneVerdict | undefined): string {
  return v?.state === 'done' ? '✓ Done' : v?.state === 'open' ? 'Not done' : 'Finished';
}

export function finishKey(finish: TurnFinish): string {
  return `${finish.scope}/${finish.sessionId}/done-${finish.turnStartMs}`;
}

export function buildFinishNotification(finish: TurnFinish): DesktopNotification {
  const verdict = turnVerdict(finish);
  const worked = `worked ${formatWaited(finish.endedAtMs - finish.turnStartMs)}`;
  const gaps = verdict?.state === 'open' ? gapsInWords(verdict.gaps) : '';
  const line = finish.row.lastAgentLine ? firstSentence(finish.row.lastAgentLine) : '';
  const n: DesktopNotification = {
    title: `${verdictWord(verdict)} · ${rowTitle(finish)}`,
    body: shorten(gaps || line || `The turn ended after it ${worked}.`),
    subtitle: [finish.scope, finish.row.project, worked].filter(Boolean).join(' · '),
    category: 'done',
    key: finishKey(finish),
    sessionId: finish.sessionId,
  };
  const agent = harnessOf(finish.row);
  if (agent) n.agent = agent;
  if (finish.row.pr?.url) n.action = `url:${finish.row.pr.url}`;
  return n;
}

export function buildBurstNotification(finishes: readonly TurnFinish[], key: string): DesktopNotification {
  const counts = new Map<string, number>();
  for (const f of finishes) {
    const word = verdictWord(turnVerdict(f)).replace('✓ ', '').toLowerCase();
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return {
    title: `${finishes.length} sessions finished`,
    body: shorten(finishes.map(rowTitle).join(' · ')),
    subtitle: [...counts].map(([word, n]) => `${n} ${word}`).join(' · '),
    category: 'done',
    key,
  };
}
