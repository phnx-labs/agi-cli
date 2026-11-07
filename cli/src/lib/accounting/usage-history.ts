import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteFileSync, ensureLockTarget, withFileLock } from '../fs-atomic.js';
import { getCacheDir } from '../state.js';

/**
 * Weekly usage peaks per account, the history behind `agents accounts usage`.
 *
 * The usage cache keeps only the latest snapshot per account, so a window's
 * value is gone once it resets. This ledger keeps the highest `usedPercent`
 * seen for each `(usageKey, resetsAt)` weekly window. A peak is a max, so
 * merging ledgers from several boxes is order-free and idempotent.
 */
export interface UsagePeak {
  key: string;
  resetsAt: string;
  peak: number;
  firstSeen: string;
  lastSeen: string;
}

export interface UsageWindowSample {
  key: string;
  usedPercent: number;
  resetsAt: Date | string | null;
}

export const USAGE_HISTORY_RETAIN_DAYS = 180;
export const USAGE_HISTORY_PUBLISH_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export const USAGE_HISTORY_FILE = 'usage-history.json';

export function getUsageHistoryPath(): string {
  return path.join(getCacheDir(), USAGE_HISTORY_FILE);
}

/** The ledger lives beside the usage cache it is fed from. */
export function usageHistoryPathFor(cachePath: string): string {
  return path.join(path.dirname(cachePath), USAGE_HISTORY_FILE);
}

function peakId(p: Pick<UsagePeak, 'key' | 'resetsAt'>): string {
  return `${p.key}\u0000${p.resetsAt}`;
}

function isUsagePeak(value: unknown): value is UsagePeak {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.key === 'string' && v.key.length > 0
    && typeof v.resetsAt === 'string' && Number.isFinite(Date.parse(v.resetsAt))
    && typeof v.peak === 'number' && Number.isFinite(v.peak)
    && typeof v.firstSeen === 'string' && typeof v.lastSeen === 'string';
}

export function parseUsagePeaks(value: unknown): UsagePeak[] {
  return Array.isArray(value) ? value.filter(isUsagePeak) : [];
}

export function readUsageHistory(historyPath = getUsageHistoryPath()): UsagePeak[] {
  let raw: string;
  try {
    raw = fs.readFileSync(historyPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw) as { peaks?: unknown };
  return parseUsagePeaks(parsed?.peaks);
}

/** Max-merge: per window keep the highest peak, the earliest firstSeen and the latest lastSeen. */
export function mergeUsagePeaks(...sets: ReadonlyArray<readonly UsagePeak[]>): UsagePeak[] {
  const byId = new Map<string, UsagePeak>();
  for (const set of sets) {
    for (const p of set) {
      const id = peakId(p);
      const prior = byId.get(id);
      if (!prior) {
        byId.set(id, { ...p });
        continue;
      }
      byId.set(id, {
        key: p.key,
        resetsAt: p.resetsAt,
        peak: Math.max(prior.peak, p.peak),
        firstSeen: prior.firstSeen < p.firstSeen ? prior.firstSeen : p.firstSeen,
        lastSeen: prior.lastSeen > p.lastSeen ? prior.lastSeen : p.lastSeen,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.key.localeCompare(b.key) || a.resetsAt.localeCompare(b.resetsAt));
}

export function pruneUsagePeaks(peaks: readonly UsagePeak[], now: Date, days = USAGE_HISTORY_RETAIN_DAYS): UsagePeak[] {
  const floor = now.getTime() - days * DAY_MS;
  return peaks.filter((p) => Date.parse(p.resetsAt) >= floor);
}

/** Peaks from samples: only weekly windows with a known reset form a history row. */
export function peaksFromWindows(
  usageKey: string,
  windows: readonly UsageWindowSample[],
  seenAt: Date,
): UsagePeak[] {
  const seen = seenAt.toISOString();
  const out: UsagePeak[] = [];
  for (const w of windows) {
    if (w.key !== 'week' || w.resetsAt == null || !Number.isFinite(w.usedPercent)) continue;
    const resetsAt = new Date(w.resetsAt);
    if (!Number.isFinite(resetsAt.getTime())) continue;
    out.push({ key: usageKey, resetsAt: resetsAt.toISOString(), peak: w.usedPercent, firstSeen: seen, lastSeen: seen });
  }
  return out;
}

/**
 * Fold one snapshot's weekly window into the ledger. Called by every usage
 * cache writer, so a reading recorded anywhere (poll, status line, peer sync)
 * lands in the history too.
 */
export function recordUsagePeaks(
  usageKey: string,
  windows: readonly UsageWindowSample[],
  seenAt: Date = new Date(),
  historyPath = getUsageHistoryPath(),
): number {
  const incoming = peaksFromWindows(usageKey, windows, seenAt);
  if (incoming.length === 0) return 0;
  ensureLockTarget(historyPath, '');
  return withFileLock(historyPath, () => {
    // An unreadable ledger throws rather than being overwritten with one reading.
    const merged = pruneUsagePeaks(mergeUsagePeaks(readUsageHistory(historyPath), incoming), seenAt);
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    atomicWriteFileSync(historyPath, `${JSON.stringify({ v: 1, peaks: merged })}\n`, 'utf-8');
    return incoming.length;
  });
}

/** The slice of the local ledger a box publishes in its daemon-state envelope. */
export function usagePeaksForPublish(now: Date = new Date(), historyPath = getUsageHistoryPath()): UsagePeak[] {
  return pruneUsagePeaks(readUsageHistory(historyPath), now, USAGE_HISTORY_PUBLISH_DAYS);
}
