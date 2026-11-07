import { listNativeAccounts } from '../account-registry.js';
import { usageKeyForNativeIdentity } from '../agents.js';
import { readFleetSharedDeviceStates } from '../fleet-shared-state.js';
import { readMeta } from '../state.js';
import type { AgentId } from '../types.js';
import { getUsageHistoryPath, mergeUsagePeaks, parseUsagePeaks, readUsageHistory, type UsagePeak } from './usage-history.js';

/**
 * Account right-sizing: how many subscription seats a harness actually needs.
 *
 * Balanced rotation spreads work over every healthy account, so how often an
 * account is used says nothing about how many accounts are needed. The signal
 * is total demand: the sum of every account's weekly peak, in account-weeks.
 * The advice is a count (`keep`), and which accounts to pause is secondary.
 */
export interface AdviseAccountInput {
  name: string;
  id: string;
  usageKey: string;
  paused: boolean;
  isDefault: boolean;
}

export interface AccountUsageRow {
  name: string;
  id: string;
  paused: boolean;
  isDefault: boolean;
  /** Weekly peak percent per complete week, oldest first; null = no reading that week. */
  peaks: Array<number | null>;
  /** The current, unfinished week so far. */
  thisWeek: number | null;
  /** `thisWeek` projected to the full window, once a day of it has passed; capped at 100. */
  pace: number | null;
  limitedWeeks: number;
}

export type AdviceConfidence = 'high' | 'low' | 'none';

export interface AccountsAdvice {
  weeks: string[];
  rows: AccountUsageRow[];
  demand: number[];
  /** This week's demand from each account's pace (or its reading so far). */
  currentDemand: number | null;
  peakDemand: number | null;
  target: number;
  coverage: { measured: number; total: number };
  advice: {
    keep: number;
    pause: string[];
    resume: string[];
    add: number;
    confidence: AdviceConfidence;
    reason: string;
  };
}

export interface AdviseOptions {
  now?: Date;
  weeks?: number;
  target?: number;
}

export const DEFAULT_ADVISE_WEEKS = 4;
export const DEFAULT_ADVISE_TARGET = 0.8;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Monday 00:00 UTC of the week containing `ms`. */
export function weekStartUtc(ms: number): number {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * DAY_MS;
}

/** A weekly window is filed under the calendar week it started in. */
function windowWeek(p: UsagePeak): number {
  return weekStartUtc(Date.parse(p.resetsAt) - WEEK_MS);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function adviseAccounts(
  accounts: readonly AdviseAccountInput[],
  peaks: readonly UsagePeak[],
  options: AdviseOptions = {},
): AccountsAdvice {
  const now = options.now ?? new Date();
  const weekCount = Math.max(1, Math.floor(options.weeks ?? DEFAULT_ADVISE_WEEKS));
  const target = options.target ?? DEFAULT_ADVISE_TARGET;
  if (!(target > 0 && target <= 1)) throw new Error(`target must be in (0, 1], got ${target}`);

  const currentWeek = weekStartUtc(now.getTime());
  const weekStarts = Array.from({ length: weekCount }, (_, i) => currentWeek - (weekCount - i) * WEEK_MS);
  const weekIndex = new Map(weekStarts.map((w, i) => [w, i]));

  const byKey = new Map<string, UsagePeak[]>();
  for (const p of peaks) {
    const list = byKey.get(p.key) ?? [];
    list.push(p);
    byKey.set(p.key, list);
  }

  const rows: AccountUsageRow[] = accounts.map((account) => {
    const weekly: Array<number | null> = weekStarts.map(() => null);
    let thisWeek: number | null = null;
    let pace: number | null = null;
    let limitedWeeks = 0;
    for (const p of byKey.get(account.usageKey) ?? []) {
      const week = windowWeek(p);
      const idx = weekIndex.get(week);
      if (idx !== undefined) {
        weekly[idx] = Math.max(weekly[idx] ?? 0, p.peak);
        if (p.peak >= 100) limitedWeeks += 1;
      } else if (week === currentWeek) {
        thisWeek = Math.max(thisWeek ?? 0, p.peak);
        const elapsed = Date.parse(p.lastSeen) - (Date.parse(p.resetsAt) - WEEK_MS);
        if (elapsed >= DAY_MS) pace = Math.max(pace ?? 0, Math.min(100, (p.peak * WEEK_MS) / elapsed));
      }
    }
    return {
      name: account.name,
      id: account.id,
      paused: account.paused,
      isDefault: account.isDefault,
      peaks: weekly.map((v) => (v === null ? null : Math.round(v))),
      thisWeek: thisWeek === null ? null : Math.round(thisWeek),
      pace: pace === null ? null : Math.round(pace),
      limitedWeeks,
    };
  });

  const demand = weekStarts.map((_, i) => round2(rows.reduce((sum, r) => sum + (r.peaks[i] ?? 0), 0) / 100));
  const weeksWithData = weekStarts.filter((_, i) => rows.some((r) => r.peaks[i] !== null)).length;
  const current = (r: AccountUsageRow) => r.pace ?? r.thisWeek;
  const currentDemand = rows.some((r) => current(r) !== null)
    ? round2(rows.reduce((sum, r) => sum + (current(r) ?? 0), 0) / 100)
    : null;
  const candidates = [...(weeksWithData > 0 ? demand : []), ...(currentDemand === null ? [] : [currentDemand])];
  const peakDemand = candidates.length > 0 ? Math.max(...candidates) : null;

  const active = rows.filter((r) => !r.paused);
  const paused = rows.filter((r) => r.paused);
  const hasReading = (r: AccountUsageRow) => r.peaks.some((v) => v !== null) || r.thisWeek !== null;
  const measured = active.filter(hasReading).length;
  const coverage = { measured, total: active.length };
  const weeksLabel = weekStarts.map((w) => new Date(w).toISOString().slice(0, 10));

  if (peakDemand === null) {
    return {
      weeks: weeksLabel, rows, demand, currentDemand, peakDemand, target, coverage,
      advice: {
        keep: active.length, pause: [], resume: [], add: 0, confidence: 'none',
        reason: `No weekly usage recorded in the last ${weekCount} weeks yet; readings arrive as accounts run.`,
      },
    };
  }

  const limited = rows.some((r) => r.limitedWeeks > 0);
  let need = Math.max(1, Math.ceil(round2(peakDemand / target)));
  if (limited && need <= active.length) need = active.length + 1;

  const sumPeaks = (r: AccountUsageRow) => r.peaks.reduce<number>((s, v) => s + (v ?? 0), current(r) ?? 0);
  let pause: string[] = [];
  let resume: string[] = [];
  let add = 0;
  if (need < active.length) {
    pause = active
      .filter((r) => !r.isDefault)
      .sort((a, b) => sumPeaks(a) - sumPeaks(b) || a.name.localeCompare(b.name))
      .slice(0, active.length - need)
      .map((r) => r.name);
  } else if (need > active.length) {
    const short = need - active.length;
    resume = paused
      .sort((a, b) => sumPeaks(b) - sumPeaks(a) || a.name.localeCompare(b.name))
      .slice(0, short)
      .map((r) => r.name);
    add = short - resume.length;
  }

  const confidence: AdviceConfidence = measured === active.length && weeksWithData >= Math.min(3, weekCount) ? 'high' : 'low';
  if (confidence === 'low') {
    pause = [];
    resume = [];
  }
  const unmeasured = active.filter((r) => !hasReading(r)).map((r) => r.name);
  const parts = [
    `Peak weekly demand ${peakDemand.toFixed(2)} account-weeks ÷ ${Math.round(target * 100)}% target = ${need}.`,
  ];
  if (limited) parts.push('An account hit its weekly limit, so the count adds one.');
  if (weeksWithData < weekCount) parts.push(`Only ${weeksWithData} of ${weekCount} weeks have readings.`);
  if (unmeasured.length > 0) parts.push(`No reading for ${unmeasured.join(', ')} (idle, or used only headless).`);
  if (confidence === 'low' && need !== active.length) {
    parts.push(`Accounts to ${need < active.length ? 'pause' : 'resume'} are named once every active account has readings in ${Math.min(3, weekCount)} of the last ${weekCount} weeks.`);
  }

  return {
    weeks: weeksLabel, rows, demand, currentDemand, peakDemand, target, coverage,
    advice: { keep: need, pause, resume, add, confidence, reason: parts.join(' ') },
  };
}

export interface CollectAdviceOptions extends AdviseOptions {
  userAgentsDir?: string;
  historyPath?: string;
}

/**
 * Gather the inputs for one harness on this box: its registered native
 * accounts, and the union of this box's weekly-peak ledger with every peer
 * ledger the usage-sync exchange stored under `devices/<peer>/`.
 */
export function collectAccountsAdvice(
  agent: AgentId,
  options: CollectAdviceOptions = {},
): AccountsAdvice & { harness: AgentId } {
  const meta = readMeta();
  const defaultRef = (meta.accounts?.defaults as Record<string, string> | undefined)?.[agent];
  const accounts: AdviseAccountInput[] = listNativeAccounts(meta)
    .filter((a) => a.agent === agent)
    .map((a) => ({
      name: a.name,
      id: a.id,
      usageKey: usageKeyForNativeIdentity(agent, a.identityKey),
      paused: !!a.pausedAt,
      isDefault: defaultRef === a.name || defaultRef === a.id,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const local = readUsageHistory(options.historyPath ?? getUsageHistoryPath());
  const peers = readFleetSharedDeviceStates(options.userAgentsDir).states
    .map((s) => parseUsagePeaks(s.usageHistory?.peaks));
  return { harness: agent, ...adviseAccounts(accounts, mergeUsagePeaks(local, ...peers), options) };
}

function pct(v: number | null): string {
  return v === null ? '—' : `${v}%`;
}

/** Plain-text table plus the recommendation, as `agents accounts usage` prints it. */
export function renderAccountsAdvice(result: AccountsAdvice & { harness: string }): string[] {
  const { harness, weeks, rows, demand, coverage, advice } = result;
  const lines: string[] = [];
  const pausedCount = rows.filter((r) => r.paused).length;
  lines.push(`${harness} · ${coverage.total} active${pausedCount ? `, ${pausedCount} paused` : ''} · last ${weeks.length} weeks · ${coverage.measured}/${coverage.total} measured`);
  if (rows.length === 0) {
    lines.push('', `No named ${harness} accounts. Add one: agents accounts add ${harness} <name>`);
    return lines;
  }
  const nameW = Math.max(8, ...rows.map((r) => r.name.length + (r.paused ? 9 : 0)));
  const cell = (s: string) => s.padStart(7);
  const nowCell = (r: AccountUsageRow) => r.thisWeek === null ? '—' : r.pace !== null && r.pace !== r.thisWeek ? `${r.thisWeek}→${r.pace}%` : `${r.thisWeek}%`;
  const header = ' '.repeat(nameW + 2) + weeks.map((w) => cell(w.slice(5))).join('') + '  this week';
  lines.push('', header);
  for (const r of rows) {
    const label = `${r.name}${r.paused ? ' (paused)' : ''}`.padEnd(nameW);
    lines.push(`  ${label}${r.peaks.map((v) => cell(pct(v))).join('')}  ${nowCell(r)}`);
  }
  const nowDemand = result.currentDemand === null ? '—' : result.currentDemand.toFixed(2);
  lines.push(`  ${'demand'.padEnd(nameW)}${demand.map((d) => cell(d.toFixed(2))).join('')}  ${nowDemand}  account-weeks`);
  lines.push('  this week: reading so far → projected to the full week');
  lines.push('');
  const { keep, pause, resume, add, confidence, reason } = advice;
  if (confidence === 'none') {
    lines.push(`No recommendation yet. ${reason}`);
    return lines;
  }
  const verdict = confidence === 'low'
    ? `Need about ${keep} of ${coverage.total} accounts`
    : pause.length > 0
    ? `Keep ${keep}, pause ${pause.length}: ${pause.join(', ')}`
    : resume.length > 0 || add > 0
      ? `Need ${keep}: ${[resume.length ? `resume ${resume.join(', ')}` : '', add ? `add ${add}` : ''].filter(Boolean).join(', ')}`
      : `Keep all ${keep}. The active accounts match demand.`;
  lines.push(`${verdict}${confidence === 'low' ? '  (low confidence)' : ''}`);
  lines.push(`  ${reason}`);
  if (pause.length > 0) lines.push(`  agents accounts pause ${pause.map((n) => `${harness}#${n}`).join(' ')}`);
  if (resume.length > 0) lines.push(`  agents accounts resume ${resume.map((n) => `${harness}#${n}`).join(' ')}`);
  return lines;
}

/** What changed advice looks like to the owner; null when there is nothing to say. */
export function accountsAdviceNotification(
  result: AccountsAdvice & { harness: string },
  lastNotified: string | null,
  now: Date = new Date(),
): { fingerprint: string; title: string; body: string; dedupKey: string } | null {
  const { harness, advice, coverage, peakDemand } = result;
  if (advice.confidence !== 'high') return null;
  if (advice.pause.length === 0 && advice.resume.length === 0 && advice.add === 0) return null;
  const fingerprint = [harness, advice.keep, [...advice.pause].sort().join(','), [...advice.resume].sort().join(','), advice.add].join('|');
  if (fingerprint === lastNotified) return null;
  const week = new Date(weekStartUtc(now.getTime())).toISOString().slice(0, 10);
  const demand = peakDemand === null ? '' : ` Peak weekly demand was ${peakDemand.toFixed(2)} account-weeks.`;
  let title: string;
  let action: string;
  if (advice.pause.length > 0) {
    title = `${harness}: ${advice.keep} of ${coverage.total} accounts cover your usage`;
    action = `Pause ${advice.pause.join(', ')}: agents accounts pause ${advice.pause.map((n) => `${harness}#${n}`).join(' ')}`;
  } else {
    title = `${harness}: you need ${advice.keep} accounts, ${coverage.total} are active`;
    action = [
      advice.resume.length ? `Resume ${advice.resume.join(', ')}: agents accounts resume ${advice.resume.map((n) => `${harness}#${n}`).join(' ')}` : '',
      advice.add ? `Add ${advice.add}: agents accounts add ${harness} <name>` : '',
    ].filter(Boolean).join('. ');
  }
  return {
    fingerprint,
    title,
    body: `${action}.${demand} Details: agents accounts usage ${harness}`,
    dedupKey: `accounts-advice:${harness}:${week}:${advice.keep}`,
  };
}
