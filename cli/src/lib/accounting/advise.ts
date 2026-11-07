import { listNativeAccounts } from '../account-registry.js';
import { usageKeyForNativeIdentity } from '../agents.js';
import { readFleetSharedDeviceStates } from '../fleet-shared-state.js';
import { readMeta } from '../state.js';
import type { AgentId } from '../types.js';
import { exportClaudeUsageCacheRows } from './usage.js';
import {
  getUsageHistoryPath,
  mergeUsagePeaks,
  parseUsagePeaks,
  peaksFromCacheRows,
  readUsageHistory,
  type UsagePeak,
} from './usage-history.js';

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
  peaks: Array<number | null>;
  thisWeek: number | null;
  pace: number | null;
  limitedWeeks: number;
}

export type AdviceConfidence = 'high' | 'low' | 'none';

export interface AccountsAdvice {
  weeks: string[];
  rows: AccountUsageRow[];
  demand: number[];
  currentDemand: number | null;
  peakDemand: number | null;
  target: number;
  coverage: { measured: number; total: number };
  thresholds: { target: number; minCoverage: number; minMeasured: number; weeksNeeded: number; limitPercent: number };
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
export const MIN_ADVISE_COVERAGE = 0.75;
export const LIMIT_PERCENT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export function weekStartUtc(ms: number): number {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * DAY_MS;
}

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
      if (p.peak >= LIMIT_PERCENT) limitedWeeks += 1;
      if (Date.parse(p.resetsAt) > now.getTime()) {
        thisWeek = Math.max(thisWeek ?? 0, p.peak);
        const elapsed = Date.parse(p.lastSeen) - (Date.parse(p.resetsAt) - WEEK_MS);
        if (elapsed >= DAY_MS) pace = Math.max(pace ?? 0, Math.min(100, (p.peak * WEEK_MS) / elapsed));
        continue;
      }
      const idx = weekIndex.get(windowWeek(p));
      if (idx !== undefined) weekly[idx] = Math.max(weekly[idx] ?? 0, p.peak);
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

  const firstOfKey = new Set<number>();
  const seenKeys = new Set<string>();
  accounts.forEach((a, i) => {
    if (!seenKeys.has(a.usageKey)) { seenKeys.add(a.usageKey); firstOfKey.add(i); }
  });
  const counted = rows.filter((_, i) => firstOfKey.has(i));
  const demand = weekStarts.map((_, i) => round2(counted.reduce((sum, r) => sum + (r.peaks[i] ?? 0), 0) / 100));
  const weeksWithData = weekStarts.filter((_, i) => rows.some((r) => r.peaks[i] !== null)).length;
  const current = (r: AccountUsageRow) => r.pace ?? r.thisWeek;
  const currentDemand = counted.some((r) => current(r) !== null)
    ? round2(counted.reduce((sum, r) => sum + (current(r) ?? 0), 0) / 100)
    : null;
  const candidates = [...(weeksWithData > 0 ? demand : []), ...(currentDemand === null ? [] : [currentDemand])];
  const peakDemand = candidates.length > 0 ? Math.max(...candidates) : null;

  const active = rows.filter((r) => !r.paused);
  const paused = rows.filter((r) => r.paused);
  const hasReading = (r: AccountUsageRow) => r.peaks.some((v) => v !== null) || r.thisWeek !== null;
  const measured = active.filter(hasReading).length;
  const coverage = { measured, total: active.length };
  const weeksLabel = weekStarts.map((w) => new Date(w).toISOString().slice(0, 10));

  const minMeasured = Math.ceil(active.length * MIN_ADVISE_COVERAGE);
  const weeksNeeded = Math.min(3, weekCount);
  const thresholds = { target, minCoverage: MIN_ADVISE_COVERAGE, minMeasured, weeksNeeded, limitPercent: LIMIT_PERCENT };
  if (peakDemand === null || measured < minMeasured) {
    const unmeasured = active.filter((r) => !hasReading(r)).map((r) => r.name);
    const reason = peakDemand === null
      ? `No weekly usage recorded in the last ${weekCount} weeks yet; readings arrive as accounts run.`
      : `Only ${measured} of ${active.length} active accounts have a weekly reading; a seat count needs ${minMeasured}. `
        + `No reading for ${unmeasured.join(', ')}.`;
    return {
      weeks: weeksLabel, rows, demand, currentDemand, peakDemand, target, coverage, thresholds,
      advice: { keep: active.length, pause: [], resume: [], add: 0, confidence: 'none', reason },
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

  const thinHistory = active.filter((r) => r.peaks.filter((v) => v !== null).length < weeksNeeded).map((r) => r.name);
  const confidence: AdviceConfidence = thinHistory.length === 0 ? 'high' : 'low';
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
    parts.push(`Accounts to ${need < active.length ? 'pause' : 'resume'} are named once every active account has readings in ${weeksNeeded} of the last ${weekCount} weeks.`);
  }

  return {
    weeks: weeksLabel, rows, demand, currentDemand, peakDemand, target, coverage, thresholds,
    advice: { keep: need, pause, resume, add, confidence, reason: parts.join(' ') },
  };
}

export interface CollectAdviceOptions extends AdviseOptions {
  userAgentsDir?: string;
  historyPath?: string;
  cachePath?: string;
}

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
  const cached = peaksFromCacheRows(exportClaudeUsageCacheRows(options.cachePath));
  const peers = readFleetSharedDeviceStates(options.userAgentsDir).states.flatMap((s) => [
    parseUsagePeaks(s.usageHistory?.peaks),
    peaksFromCacheRows(s.usage?.rows ?? {}),
  ]);
  return { harness: agent, ...adviseAccounts(accounts, mergeUsagePeaks(local, cached, ...peers), options) };
}

function pct(v: number | null): string {
  return v === null ? '—' : `${v}%`;
}

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

export function accountsAdviceNotification(
  result: AccountsAdvice & { harness: string },
  lastNotified: string | null,
  now: Date = new Date(),
): { fingerprint: string; title: string; body: string; dedupKey: string } | null {
  const { harness, advice, coverage, peakDemand, thresholds } = result;
  const week = new Date(weekStartUtc(now.getTime())).toISOString().slice(0, 10);
  const demand = peakDemand === null ? '' : ` Peak weekly demand was ${peakDemand.toFixed(2)} account-weeks.`;
  if (advice.confidence === 'low') {
    if (advice.keep === coverage.total) return null;
    const fingerprint = [harness, 'low', advice.keep, coverage.total].join('|');
    if (fingerprint === lastNotified) return null;
    const title = advice.keep < coverage.total
      ? `${harness}: about ${advice.keep} of ${coverage.total} accounts cover your usage`
      : `${harness}: you may need ${advice.keep} accounts, ${coverage.total} are active`;
    return {
      fingerprint,
      title,
      body: `Which accounts to ${advice.keep < coverage.total ? 'pause' : 'resume'} is named once each has readings in ${thresholds.weeksNeeded} of the last ${result.weeks.length} weeks.${demand} Details: agents accounts usage ${harness}`,
      dedupKey: `accounts-advice:${harness}:${week}:low:${advice.keep}`,
    };
  }
  if (advice.confidence !== 'high') return null;
  if (advice.pause.length === 0 && advice.resume.length === 0 && advice.add === 0) return null;
  const fingerprint = [harness, advice.keep, [...advice.pause].sort().join(','), [...advice.resume].sort().join(','), advice.add].join('|');
  if (fingerprint === lastNotified) return null;
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
