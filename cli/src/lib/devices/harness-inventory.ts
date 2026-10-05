import chalk from 'chalk';

import {
  ALL_AGENT_IDS,
  accountDisplayLabel,
  getAccountInfo,
  type AccountInfo,
} from '../agents.js';
import type { AgentId } from '../types.js';
import {
  deriveUsageStatusFromSnapshot,
  liveUsageWindows,
  classifyUsageErrorKind,
  getUsageInfoByIdentity,
  getUsageLookupKey,
  usageErrorForDisplay,
  type UsageIdentityInput,
  type UsageSnapshot,
} from '../accounting/usage.js';
import { getVersionHomePath, listInstalledVersions } from '../installations/store.js';
import { readMeta } from '../state.js';
import { findNativeAccountByIdentity } from '../account-registry.js';
import { authCacheKey, readAuthHealthCache } from '../auth-health.js';
import { machineId } from '../machine-id.js';
import { fixFor, type AccountVerdict } from '../signin-badge.js';
import { harnessWorkerIsPerDevice } from '../harness-auth-capabilities.js';

export interface QuotaSummary {
  status: 'available' | 'rate_limited' | 'out_of_credits' | null;
  verdict: 'available' | 'rate_limited' | 'out_of_credits' | 'unavailable';
  usedPercent: number | null;
  stale: boolean;
  capturedAt: string | null;
  resetsAt: string | null;
  unavailableReason: string | null;
}

export interface HarnessRow {
  agent: AgentId;
  version: string;
  account: string | null;
  signedIn: boolean;
  quota: QuotaSummary;
  ready: boolean;
  reason?: string;
  verdict: AccountVerdict;
  fix: string | null;
  snapshot: UsageSnapshot | null;
  usageError: string | null;
}

export interface HostHarnessResult {
  host: string;
  rows: HarnessRow[];
  error?: string;
  skipped?: string;
}

interface AccountGroup {
  account: string | null;
  agents: AgentId[];
  installs: number;
  signedIn: boolean;
  quota: QuotaSummary;
  ready: boolean;
  reason?: string;
}

export function summarizeQuota(
  snapshot: UsageSnapshot | null | undefined,
  unavailableReason: string | null = null,
  accountStatus: AccountInfo['usageStatus'] = null,
): QuotaSummary {
  if (!snapshot || snapshot.windows.length === 0) {
    const marker = snapshot?.unavailable;
    let status = accountStatus;
    let reason = unavailableReason;
    if (marker?.reason === 'out_of_credits') {
      status = 'out_of_credits';
      reason = 'out of credits';
    } else if (
      marker?.reason === 'session_limit' &&
      (!marker.resetsAt || marker.resetsAt.getTime() > Date.now())
    ) {
      status = 'rate_limited';
      reason = 'session-limited';
    }
    return {
      status,
      verdict: status ?? 'unavailable',
      usedPercent: null,
      stale: false,
      capturedAt: snapshot?.capturedAt?.toISOString() ?? null,
      resetsAt: marker?.resetsAt?.toISOString() ?? null,
      unavailableReason: status ? null : (reason ?? 'usage unavailable'),
    };
  }
  const live = liveUsageWindows(snapshot);
  const blocking = live.filter((w) => w.key !== 'sonnet_week');
  const windows = blocking.length > 0 ? blocking : live;
  const derived = deriveUsageStatusFromSnapshot(snapshot);
  const status = accountStatus === 'out_of_credits' ? accountStatus : derived;
  let usedPercent = windows.length > 0
    ? Math.round(Math.max(...windows.map((w) => w.usedPercent)))
    : 0;
  if (status !== 'rate_limited' && usedPercent >= 100) usedPercent = 99;
  return {
    status,
    verdict: status ?? 'unavailable',
    usedPercent,
    stale: snapshot.source !== 'live',
    capturedAt: snapshot.capturedAt?.toISOString() ?? null,
    resetsAt: windows
      .map((window) => window.resetsAt)
      .filter((value): value is Date => value instanceof Date)
      .sort((a, b) => a.getTime() - b.getTime())[0]?.toISOString() ?? null,
    unavailableReason: null,
  };
}

export function summarizeObservedQuota(
  snapshot: UsageSnapshot | null | undefined,
  error: string | null | undefined,
  accountStatus: AccountInfo['usageStatus'] = null,
): { quota: QuotaSummary; unverified: boolean } {
  const displayError = usageErrorForDisplay(error);
  const unverified = classifyUsageErrorKind(error) === 'headless-scope'
    || /scope|permission/i.test(displayError ?? '');
  return {
    quota: unverified
      ? summarizeQuota(null, displayError, null)
      : summarizeQuota(snapshot, displayError, accountStatus),
    unverified,
  };
}

export function applyUsageHonesty(
  verdict: AccountVerdict,
  usage: QuotaSummary | null,
): { verdict: AccountVerdict; usage: QuotaSummary | null } {
  if (!usage) return { verdict, usage };
  const reason = usage.unavailableReason;
  const scopeUnknown = !!reason && (
    classifyUsageErrorKind(reason) === 'headless-scope'
    || /scope|permission|headless/i.test(reason)
  );
  if (scopeUnknown) {
    const stripped: QuotaSummary = {
      ...usage,
      status: null,
      verdict: 'unavailable',
      usedPercent: null,
    };
    if (verdict === 'live' || verdict === 'rate_limited') {
      return { verdict: 'unverified', usage: stripped };
    }
    return { verdict, usage: stripped };
  }
  if ((usage.status === 'rate_limited' || usage.status === 'out_of_credits') && (verdict === 'live' || verdict === 'unverified' || verdict === 'no_evidence')) {
    return { verdict: 'rate_limited', usage };
  }
  return { verdict, usage };
}

export function computeReady(
  signedIn: boolean,
  quota: QuotaSummary,
): { ready: boolean; reason?: string } {
  if (!signedIn) return { ready: false, reason: 'signed out' };
  if (quota.status === 'rate_limited') return { ready: false, reason: 'rate-limited' };
  if (quota.status === 'out_of_credits') return { ready: false, reason: 'out of credits' };
  return { ready: true };
}

export async function collectLocalHarnessInventory(opts?: {
  agents?: readonly AgentId[];
  refresh?: boolean;
}): Promise<HarnessRow[]> {
  const agentIds = opts?.agents ?? ALL_AGENT_IDS;

  interface Pending {
    agent: AgentId;
    version: string;
    info: AccountInfo | null;
  }
  const pending: Pending[] = [];
  const usageInputs: UsageIdentityInput[] = [];
  for (const agent of agentIds) {
    for (const version of listInstalledVersions(agent)) {
      const home = getVersionHomePath(agent, version);
      const info = await getAccountInfo(agent, home).catch(() => null);
      pending.push({ agent, version, info });
      if (info?.signedIn) {
        usageInputs.push({ agentId: agent, info, home, cliVersion: version });
      }
    }
  }

  const usageByKey = usageInputs.length
    ? (await getUsageInfoByIdentity(usageInputs, opts?.refresh ? { forceRefresh: true } : undefined)).usageByKey
    : new Map();

  const meta = readMeta();
  const authCache = readAuthHealthCache();
  const host = machineId();
  return pending.map(({ agent, version, info }) => {
    const key = getUsageLookupKey(info);
    const usage = key ? usageByKey.get(key) : undefined;
    const snapshot = usage?.snapshot ?? null;
    const observed = summarizeObservedQuota(snapshot, usage?.error, info?.usageStatus ?? null);
    const quota = observed.quota;
    const signedIn = !!info?.signedIn;
    const display = info ? accountDisplayLabel(info) || null : null;
    const saved = findNativeAccountByIdentity(meta, agent, info);
    const account = saved ? `${saved.name} · ${display || saved.identityLabel || saved.identityKey}` : display;
    const cachedVerdict = authCache[authCacheKey(host, agent, version)]?.verdict;
    const fromAuth: AccountVerdict = cachedVerdict === 'unconfigured' || !signedIn
      ? 'missing'
      : cachedVerdict === 'error' || !cachedVerdict
        ? 'unverified'
        : cachedVerdict;
    const honest = applyUsageHonesty(fromAuth, quota);
    const verdict = honest.verdict;
    const honestQuota = honest.usage ?? quota;
    const { ready, reason } = computeReady(signedIn, honestQuota);
    const provisioning = harnessWorkerIsPerDevice(agent) ? 'per-device' as const : 'portable' as const;
    return {
      agent,
      version,
      account,
      signedIn,
      quota: honestQuota,
      ready,
      reason,
      verdict,
      fix: fixFor({ agent, verdict, name: saved?.name, version, provisioning }),
      snapshot,
      usageError: usage?.error ?? null,
    };
  });
}

export function groupByAccount(rows: HarnessRow[]): AccountGroup[] {
  const order: string[] = [];
  const groups = new Map<string, HarnessRow[]>();
  for (const row of rows) {
    const key = row.account ?? '\0signed-out';
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(row);
  }

  return order.map((key) => {
    const members = groups.get(key)!;
    const account = members[0].account;
    const agents = [...new Set(members.map((m) => m.agent))].sort() as AgentId[];
    const signedIn = members.some((m) => m.signedIn);
    const withData = members.filter((m) => m.quota.status !== null);
    const rep =
      withData.find((m) => m.quota.status === 'out_of_credits') ??
      withData.find((m) => m.quota.status === 'rate_limited') ?? withData[0] ?? members[0];
    const quota = rep.quota;
    const { ready, reason } = computeReady(signedIn, quota);
    return {
      account,
      agents,
      installs: members.length,
      signedIn,
      quota,
      ready,
      reason,
    };
  });
}

export function formatQuota(quota: QuotaSummary): string {
  if (quota.status === 'out_of_credits') return 'no credits';
  if (quota.status === 'rate_limited') return 'limited';
  if (quota.usedPercent === null) return '—';
  return `${quota.usedPercent}%${quota.stale ? '*' : ''}`;
}


function cell(text: string, width: number, paint: (s: string) => string): string {
  return paint(text.padEnd(width));
}

function quotaPaint(quota: QuotaSummary): (s: string) => string {
  if (quota.status === 'rate_limited') return chalk.red;
  if (quota.usedPercent === null) return chalk.dim;
  return quota.usedPercent >= 80 ? chalk.yellow : chalk.green;
}

function readyCell(ready: boolean, reason: string | undefined, width: number): string {
  if (ready) return cell('ready', width, chalk.green);
  const label = reason ?? 'not ready';
  return cell(label, width, reason === 'signed out' ? chalk.gray : chalk.yellow);
}

function signedCell(signedIn: boolean): string {
  return signedIn ? chalk.green('yes') : chalk.gray('no ');
}

function hostNote(result: HostHarnessResult): string {
  if (result.skipped) return chalk.dim(`  ${result.skipped}`);
  if (result.error) return chalk.red(`  ${result.error}`);
  if (result.rows.length === 0) return chalk.dim('  no harnesses installed');
  return '';
}

function colWidth(values: string[], min: number): number {
  return Math.max(min, ...values.map((v) => v.length));
}

const QUOTA_W = 7;

export function renderHarnessMatrix(results: HostHarnessResult[]): string[] {
  const lines: string[] = [chalk.bold('Fleet harnesses')];
  const allRows = results.flatMap((r) => r.rows);
  const harnessW = colWidth(allRows.map((r) => `${r.agent}@${r.version}`), 10);
  const acctW = colWidth(allRows.map((r) => r.account ?? '—'), 6);

  for (const result of results) {
    lines.push(`  ${chalk.cyan(result.host)}${hostNote(result)}`);
    for (const row of result.rows) {
      const harness = cell(`${row.agent}@${row.version}`, harnessW, chalk.white);
      const account = cell(row.account ?? '—', acctW, chalk.dim);
      const quota = cell(formatQuota(row.quota), QUOTA_W, quotaPaint(row.quota));
      const ready = readyCell(row.ready, row.reason, 12);
      lines.push(`      ${harness}  ${account}  ${signedCell(row.signedIn)}  ${quota}  ${ready}`);
    }
  }
  lines.push('');
  lines.push(chalk.gray('  quota = highest window utilization (* = cached) · ready = signed in and not rate-limited'));
  return lines;
}

export function renderAccountsMatrix(results: HostHarnessResult[]): string[] {
  const lines: string[] = [chalk.bold('Fleet accounts')];
  const grouped = results.map((r) => ({ ...r, groups: groupByAccount(r.rows) }));
  const allGroups = grouped.flatMap((r) => r.groups);
  const acctW = colWidth(allGroups.map((g) => g.account ?? 'signed out'), 8);
  const agentsW = colWidth(allGroups.map((g) => g.agents.join(', ')), 8);

  for (const result of grouped) {
    lines.push(`  ${chalk.cyan(result.host)}${hostNote(result)}`);
    for (const group of result.groups) {
      const label = group.account ?? 'signed out';
      const account = cell(label, acctW, group.account ? chalk.dim : chalk.gray);
      const agents = cell(group.agents.join(', '), agentsW, chalk.dim);
      const quota = cell(formatQuota(group.quota), QUOTA_W, quotaPaint(group.quota));
      const ready = readyCell(group.ready, group.reason, 12);
      lines.push(`      ${account}  ${agents}  ${signedCell(group.signedIn)}  ${quota}  ${ready}`);
    }
  }
  lines.push('');
  lines.push(chalk.gray('  one row per account · agents = harnesses signed into it · ready = signed in and not rate-limited'));
  return lines;
}

interface AccountFleetMatrixRow {
  harness: AgentId;
  name: string | null;
  identityLabel: string;
  devices: Array<{ device: string; verdict: AccountVerdict }>;
}

function fleetVerdictLabel(verdict: AccountVerdict): string {
  if (verdict === 'rate_limited') return 'LIMITED';
  return verdict.toUpperCase();
}

export function renderAccountFleetMatrix(
  rows: AccountFleetMatrixRow[],
  opts: { uncoveredDevices?: string[] } = {},
): string[] {
  const devices = [...new Set(rows.flatMap((row) => row.devices.map((device) => device.device)))].sort();
  const accountLabels = rows.map((row) => `${row.harness}#${row.name ?? 'unnamed'} ${row.identityLabel}`);
  const accountW = colWidth(accountLabels, 16);
  const deviceWidths = new Map(devices.map((device) => [
    device,
    colWidth([
      device,
      ...rows.map((row) => fleetVerdictLabel(row.devices.find((item) => item.device === device)?.verdict ?? 'missing')),
    ], 7),
  ]));
  const lines = [chalk.bold('Fleet accounts')];
  if (rows.length === 0) {
    lines.push(chalk.gray('  no accounts'));
  } else {
    lines.push(
      `  ${'ACCOUNT'.padEnd(accountW)}  `
      + devices.map((device) => device.padEnd(deviceWidths.get(device)!)).join('  '),
    );
    for (const [index, row] of rows.entries()) {
      const label = accountLabels[index].padEnd(accountW);
      const cells = devices.map((device) => {
        const verdict = row.devices.find((item) => item.device === device)?.verdict ?? 'missing';
        const plain = fleetVerdictLabel(verdict).padEnd(deviceWidths.get(device)!);
        if (verdict === 'live') return chalk.green(plain);
        if (verdict === 'revoked' || verdict === 'expired' || verdict === 'missing') return chalk.red(plain);
        if (verdict === 'rate_limited') return chalk.yellow(plain);
        return chalk.gray(plain);
      });
      lines.push(`  ${chalk.cyan(label)}  ${cells.join('  ')}`);
    }
  }
  const uncovered = (opts.uncoveredDevices ?? []).filter((device) => !devices.includes(device));
  if (uncovered.length > 0) {
    lines.push(chalk.gray(
      `  ${uncovered.join(', ')}: daemon-state carries no account verdicts (older release)`,
    ));
  }
  return lines;
}
