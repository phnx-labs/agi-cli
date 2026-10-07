import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ActiveSession } from '../session/active.js';
import type { DetectedPr } from '@phnx-labs/sessions-cli/reader';
import type { PrCheckItem, SessionPr } from '../session/active.js';
import type { GhExec } from '../github/pr-mergeable.js';
import type { PullRequestAttentionSignal } from './attention.js';

const execFileAsync = promisify(execFile);
export const PR_STATUS_TTL_MS = 45_000;
const PR_STATUS_FIELDS = 'number,title,headRefOid,state,isDraft,reviewDecision,mergeable,statusCheckRollup';
export const MAX_PR_CHECK_ITEMS = 30;
const FAILED_VERDICTS = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
const PENDING_VERDICTS = ['PENDING', 'EXPECTED', 'STALE'];

export interface PullRequestStatus extends PullRequestAttentionSignal {
  headRefOid?: string;
  statusCheckRollup?: unknown[];
}

interface CacheEntry { expiresAt: number; value?: PullRequestStatus }
const cache = new Map<string, CacheEntry>();

function needsHuman(value: Omit<PullRequestStatus, 'needsHuman'>): boolean {
  if (value.state !== 'OPEN' || value.isDraft) return false;
  const checks = value.statusCheckRollup ?? [];
  const checksSettled = checks.every((check) => {
    const row = check as { conclusion?: string; status?: string };
    return row.conclusion === 'SUCCESS' || row.conclusion === 'NEUTRAL' || row.status === 'COMPLETED';
  });
  return value.reviewDecision !== 'APPROVED' || (value.mergeable === 'MERGEABLE' && checksSettled);
}

export const PR_STATUS_DEFAULT_TIMEOUT_MS = 15_000;

export async function readPullRequestStatus(
  session: ActiveSession,
  options: { nowMs?: number; ttlMs?: number; timeoutMs?: number; gh?: GhExec } = {},
): Promise<PullRequestStatus | undefined> {
  const ref = session.pr?.url ?? session.pr?.number;
  if (!ref || !session.cwd) return undefined;
  const key = `${session.cwd}\0${String(ref)}`;
  const now = options.nowMs ?? Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  const cwd = session.cwd;
  const timeout = options.timeoutMs ?? PR_STATUS_DEFAULT_TIMEOUT_MS;
  const gh: GhExec = options.gh ?? (async (args) =>
    (await execFileAsync('gh', args, { cwd, timeout, maxBuffer: 1024 * 1024 })).stdout);
  try {
    const stdout = await gh(['pr', 'view', String(ref), '--json', PR_STATUS_FIELDS]);
    const raw = JSON.parse(stdout) as Omit<PullRequestStatus, 'needsHuman'>;
    const value: PullRequestStatus = { ...raw, url: session.pr?.url, needsHuman: needsHuman(raw) };
    cache.set(key, { expiresAt: now + (options.ttlMs ?? PR_STATUS_TTL_MS), value });
    return value;
  } catch {
    cache.set(key, { expiresAt: now + (options.ttlMs ?? PR_STATUS_TTL_MS) });
    return undefined;
  }
}

export function resetPullRequestStatusCache(): void { cache.clear(); }

export function checksVerdict(rollup?: unknown[]): DetectedPr['checks'] {
  if (!rollup || rollup.length === 0) return undefined;
  let pending = false;
  for (const check of rollup) {
    const row = check as { conclusion?: string; status?: string; state?: string };
    const verdict = (row.conclusion || row.state || '').toUpperCase();
    if (FAILED_VERDICTS.includes(verdict)) return 'failing';
    if (verdict === '' ? (row.status ?? '').toUpperCase() !== 'COMPLETED' : PENDING_VERDICTS.includes(verdict)) pending = true;
  }
  return pending ? 'pending' : 'passing';
}

interface RollupEntry {
  name?: string; context?: string;
  conclusion?: string; state?: string; status?: string;
  detailsUrl?: string; targetUrl?: string;
  startedAt?: string; completedAt?: string;
}

function checkItemState(row: RollupEntry): PrCheckItem['state'] {
  const verdict = (row.conclusion || row.state || '').toUpperCase();
  if (FAILED_VERDICTS.includes(verdict)) return 'failed';
  if (verdict === 'SKIPPED' || verdict === 'NEUTRAL') return 'skipped';
  if (verdict === '' ? (row.status ?? '').toUpperCase() !== 'COMPLETED' : PENDING_VERDICTS.includes(verdict)) return 'running';
  return 'passed';
}

export function checkItemsFrom(rollup?: unknown[]): PrCheckItem[] | undefined {
  if (!rollup || rollup.length === 0) return undefined;
  const byName = new Map<string, { item: PrCheckItem; atMs: number }>();
  for (const check of rollup) {
    const row = (check ?? {}) as RollupEntry;
    const name = row.name || row.context;
    if (!name) continue;
    const atMs = Date.parse(row.completedAt || row.startedAt || '');
    const at = Number.isFinite(atMs) && atMs > 0 ? atMs : -Infinity;
    const previous = byName.get(name);
    if (previous && previous.atMs > at) continue;
    const url = row.detailsUrl || row.targetUrl;
    const item: PrCheckItem = { name, state: checkItemState(row), ...(url ? { url } : {}) };
    byName.set(name, { item, atMs: at });
  }
  const all = [...byName.values()].map((entry) => entry.item);
  const rank = (item: PrCheckItem) => item.state === 'failed' ? 0 : item.state === 'running' ? 1 : 2;
  const kept = new Set([...all].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_PR_CHECK_ITEMS));
  const items = all.filter((item) => kept.has(item));
  return items.length ? items : undefined;
}

export function withPullRequestStatus<T extends { pr?: SessionPr }>(row: T, status?: PullRequestStatus): T {
  if (!row.pr || !status) return row;
  const checkItems = checkItemsFrom(status.statusCheckRollup);
  const pr: SessionPr = {
    ...row.pr,
    ...(status.title ? { title: status.title } : {}),
    ...(status.headRefOid ? { headSha: status.headRefOid } : {}),
    ...(checkItems ? { checkItems } : {}),
    ...(status.state !== undefined ? { state: status.state } : {}),
    ...(status.isDraft !== undefined ? { isDraft: status.isDraft } : {}),
    ...(status.reviewDecision !== undefined ? { reviewDecision: status.reviewDecision } : {}),
    ...(status.mergeable !== undefined ? { mergeable: status.mergeable } : {}),
  };
  const checks = checksVerdict(status.statusCheckRollup);
  if (checks) pr.checks = checks;
  return { ...row, pr };
}
