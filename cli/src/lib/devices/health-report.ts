import chalk from 'chalk';
import { padToWidth, stringWidth, terminalWidth, truncateToWidth } from '../text/width.js';
import { fmtBytes, headroom, type DeviceStats } from './health.js';
import { formatCheckedAge, type HostAuthSummary } from '../auth-health.js';
import type { OnlineState } from './reachability.js';
import { compareFleetInventories, type FleetInventory } from './fleet-divergence.js';
import type { FleetAgentCounts } from '../fleet-status.js';

export interface FleetCliStatus {
  installed: boolean;
  path: string | null;
  error: string | null;
}

export interface FleetSyncStatus {
  agent: string;
  version: string;
  status: 'fresh' | 'stale' | 'never-synced';
  isDefault: boolean;
  divergence?: string[];
}

export interface FleetOrphanStatus {
  agent: string;
  version: string;
  commands: number;
  skills: number;
  hooks: number;
}

export interface FleetHealthRow {
  name: string;
  platform?: string;
  version?: string | null;
  stats?: DeviceStats;
  error?: string;
  skipped?: string;
  clis: Record<string, FleetCliStatus>;
  sync: FleetSyncStatus[];
  orphans: FleetOrphanStatus[];
  auth?: HostAuthSummary;
  online?: OnlineState;
  lastSeen?: string;
  inventory?: FleetInventory;
  agents?: FleetAgentCounts;
}

interface FleetWarning {
  kind: 'unreachable' | 'drift' | 'cli' | 'version-skew' | 'divergence';
  devices: string[];
  message: string;
}

export interface FleetHealthReport {
  generatedAt: string;
  devices: FleetHealthRow[];
  warnings: FleetWarning[];
  hasWarnings: boolean;
  hasDrift: boolean;
}

function driftRows(row: FleetHealthRow): FleetSyncStatus[] {
  return row.sync.filter((s) => s.status !== 'fresh');
}

function installedCliCount(row: FleetHealthRow): { installed: number; total: number } {
  const statuses = Object.values(row.clis);
  return {
    installed: statuses.filter((s) => s.installed).length,
    total: statuses.length,
  };
}

export function buildFleetHealthReport(
  rows: FleetHealthRow[],
  now = new Date(),
  opts: { self?: string } = {},
): FleetHealthReport {
  const warnings: FleetWarning[] = [];
  const unreachable = rows
    .filter((r) => r.error || r.skipped)
    .map((r) => r.name);
  if (unreachable.length > 0) {
    warnings.push({
      kind: 'unreachable',
      devices: unreachable,
      message: `${unreachable.length} device${unreachable.length === 1 ? '' : 's'} unreachable or skipped`,
    });
  }

  const drifted = rows.filter((r) => driftRows(r).length > 0).map((r) => r.name);
  if (drifted.length > 0) {
    warnings.push({
      kind: 'drift',
      devices: drifted,
      message: `${drifted.length} device${drifted.length === 1 ? '' : 's'} have sync drift`,
    });
  }

  const cliIssues = rows
    .filter((r) => {
      const counts = installedCliCount(r);
      return counts.total > 0 && counts.installed < counts.total;
    })
    .map((r) => r.name);
  if (cliIssues.length > 0) {
    warnings.push({
      kind: 'cli',
      devices: cliIssues,
      message: `${cliIssues.length} device${cliIssues.length === 1 ? ' is' : 's are'} missing one or more agent CLIs`,
    });
  }

  const versions = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.version) continue;
    const list = versions.get(row.version) ?? [];
    list.push(row.name);
    versions.set(row.version, list);
  }
  if (versions.size > 1) {
    warnings.push({
      kind: 'version-skew',
      devices: rows.filter((r) => r.version).map((r) => r.name),
      message: `agents-cli version skew: ${Array.from(versions.keys()).sort().join(', ')}`,
    });
  }

  if (opts.self && rows.some((r) => r.inventory)) {
    const divergence = compareFleetInventories(
      rows.map((r) => ({ name: r.name, inventory: r.inventory ?? null })),
      opts.self,
    );
    const byDevice = new Map<string, number>();
    for (const d of divergence.divergences) byDevice.set(d.device, (byDevice.get(d.device) ?? 0) + 1);
    for (const device of Array.from(byDevice.keys()).sort()) {
      const n = byDevice.get(device)!;
      warnings.push({
        kind: 'divergence',
        devices: [device],
        message: `${device} diverges from ${opts.self} (${n} resource/version/repo gap${n === 1 ? '' : 's'})`,
      });
    }
  }

  return {
    generatedAt: now.toISOString(),
    devices: rows,
    warnings,
    hasWarnings: warnings.length > 0,
    hasDrift: drifted.length > 0 || unreachable.length > 0,
  };
}

function statusGlyph(row: FleetHealthRow): string {
  if (row.error || row.skipped) return chalk.red('○');
  if (driftRows(row).length > 0) return chalk.yellow('◐');
  return chalk.green('●');
}

function headroomLabel(row: FleetHealthRow): string {
  const h = headroom(row.stats);
  switch (h) {
    case 'idle':
      return chalk.green('idle');
    case 'light':
      return chalk.green('light');
    case 'busy':
      return chalk.yellow('busy');
    case 'loaded':
      return chalk.red('loaded');
    case 'unknown':
      return chalk.gray('unknown');
  }
}

function driftLabel(row: FleetHealthRow): string {
  if (row.error) return chalk.red('probe failed');
  if (row.skipped) return chalk.gray(row.skipped);
  const drift = driftRows(row);
  if (drift.length === 0) return chalk.green('fresh');
  const stale = drift.filter((r) => r.status === 'stale').length;
  const cold = drift.filter((r) => r.status === 'never-synced').length;
  const parts: string[] = [];
  if (stale) parts.push(`${stale} stale`);
  if (cold) parts.push(`${cold} cold`);
  return chalk.yellow(parts.join(' · '));
}

function cliLabel(row: FleetHealthRow): string {
  if (row.error || row.skipped) return chalk.gray('-');
  const { installed, total } = installedCliCount(row);
  if (total === 0) return chalk.gray('none');
  return installed === total ? chalk.green(`${installed}/${total}`) : chalk.yellow(`${installed}/${total}`);
}

function loadLabel(stats: DeviceStats | undefined): string {
  if (!stats?.reachable) return chalk.gray('-');
  const load = stats.loadPercent === undefined ? '-' : `${Math.round(stats.loadPercent)}%`;
  const mem = stats.memPercent === undefined ? '-' : `${Math.round(stats.memPercent)}%`;
  return `${load}/${mem}`;
}

function authLabel(row: FleetHealthRow): string {
  if (row.error || row.skipped) return chalk.gray('-');
  const s = row.auth;
  if (!s || s.total === 0) return chalk.gray('—');
  const parts: string[] = [];
  if (s.live > 0) parts.push(chalk.green(`●${s.live}`));
  if (s.present > 0) parts.push(chalk.gray(`·${s.present}`));
  if (s.degraded > 0) parts.push(chalk.yellow(`◐${s.degraded}`));
  if (s.revoked > 0) parts.push(chalk.red(`○${s.revoked}`));
  return parts.length > 0 ? parts.join(' ') : chalk.gray('—');
}

function oldestAcross(rows: FleetHealthRow[], pick: (r: FleetHealthRow) => number | null | undefined): number | null {
  let oldest: number | null = null;
  for (const row of rows) {
    const t = pick(row);
    if (t == null) continue;
    if (oldest === null || t < oldest) oldest = t;
  }
  return oldest;
}

export function renderFleetWarnings(report: FleetHealthReport): string[] {
  if (report.warnings.length === 0) return [chalk.green('Fleet warnings: none')];
  return [
    chalk.bold(`Fleet warnings (${report.warnings.length})`),
    ...report.warnings.map((w) => `  ${chalk.yellow(w.kind.padEnd(12))} ${w.message} ${chalk.gray(`(${w.devices.join(', ')})`)}`),
  ];
}

export function renderFleetMatrix(report: FleetHealthReport): string[] {
  if (report.devices.length === 0) return [chalk.gray('No registered devices. Run `agents devices` to register some.')];
  const nameW = Math.min(
    22,
    Math.max(6, ...report.devices.map((r) => r.name.length)),
  );
  const versionW = Math.min(
    14,
    Math.max(7, ...report.devices.map((r) => (r.version ?? '-').length)),
  );
  const authW = Math.max(9, ...report.devices.map((r) => stringWidth(authLabel(r))));
  const width = terminalWidth();
  const fixed = 4 + nameW + 2 + 8 + 2 + 9 + 2 + 9 + 2 + 9 + 2 + authW + 2 + versionW + 2 + 9;
  const noteW = Math.max(12, width - fixed);
  const lines = [
    chalk.bold('Fleet status'),
    chalk.gray(
      `    ${padToWidth('Device', nameW)}  ${padToWidth('OS', 8)}  ${padToWidth('Health', 9)}  ${padToWidth('Sync', 9)}  ${padToWidth('CLI', 9)}  ${padToWidth('Auth', authW)}  ${padToWidth('Version', versionW)}  ${padToWidth('Load/Mem', 9)}  Note`,
    ),
  ];
  for (const row of report.devices) {
    const note = row.error ?? row.skipped ?? (row.orphans.length > 0 ? `${row.orphans.length} orphaned version${row.orphans.length === 1 ? '' : 's'}` : '');
    lines.push(
      `  ${statusGlyph(row)} ${padToWidth(truncateToWidth(row.name, nameW), nameW)}  ` +
      `${padToWidth(truncateToWidth(row.platform ?? '-', 8), 8)}  ` +
      `${padToWidth(headroomLabel(row), 9)}  ` +
      `${padToWidth(driftLabel(row), 9)}  ` +
      `${padToWidth(cliLabel(row), 9)}  ` +
      `${padToWidth(authLabel(row), authW)}  ` +
      `${padToWidth(truncateToWidth(row.version ?? '-', versionW), versionW)}  ` +
      `${padToWidth(loadLabel(row.stats), 9)}  ` +
      chalk.gray(truncateToWidth(note || `free ${fmtBytes(row.stats?.memFreeBytes)}`, noteW)),
    );
  }
  lines.push(chalk.gray('  ● fresh · ◐ drift · ○ unreachable/skipped · Auth ●live ·present ◐degraded ○revoked'));
  const foot = freshnessFooter(report.devices);
  if (foot) lines.push(chalk.gray(foot));
  return lines;
}

export function freshnessFooter(rows: FleetHealthRow[], now: number = Date.now()): string | null {
  const oldestStats = oldestAcross(rows, (r) => r.stats?.fetchedAt);
  const oldestAuth = oldestAcross(rows, (r) => r.auth?.oldestCheckedAt);
  const parts: string[] = [];
  if (oldestStats != null) parts.push(`stats ${formatCheckedAge(oldestStats, now)}`);
  if (oldestAuth != null) parts.push(`auth ${formatCheckedAge(oldestAuth, now)}`);
  if (parts.length === 0) return null;
  return `  updated ${parts.join(' · ')} — pass --refresh (--live) for a live probe`;
}


export function shortVersion(version: string | null | undefined): string {
  if (!version) return '—';
  const m = version.match(/-dev\b/);
  if (m) return /dirty/.test(version) ? 'dev-dirty' : 'dev';
  return version;
}

export function platformGroupLabel(platform: string | undefined): 'macOS' | 'Linux' | 'Windows' | 'Other' {
  const p = (platform ?? '').toLowerCase();
  if (p === 'macos' || p === 'darwin') return 'macOS';
  if (p === 'linux') return 'Linux';
  if (p.startsWith('win')) return 'Windows';
  return 'Other';
}

const GROUP_ORDER: Array<'macOS' | 'Linux' | 'Windows' | 'Other'> = ['macOS', 'Linux', 'Windows', 'Other'];

function activeDriftRows(row: FleetHealthRow): FleetSyncStatus[] {
  return row.sync.filter((s) => s.isDefault && s.status !== 'fresh');
}

function isOffline(row: FleetHealthRow): boolean {
  if (row.online) return row.online !== 'online';
  return Boolean(row.error || row.skipped);
}

function isGenuinelyOffline(row: FleetHealthRow): boolean {
  return row.online === 'offline' || (!row.online && Boolean(row.error || row.skipped));
}

function starkCliGap(row: FleetHealthRow): { installed: number; total: number } | null {
  const { installed, total } = installedCliCount(row);
  return total > 0 && installed * 3 < total ? { installed, total } : null;
}

interface FleetAttentionItem {
  glyph: 'offline' | 'warn';
  subject: string;
  detail: string;
  fix: string;
}

export function buildFleetAttentionItems(report: FleetHealthReport, now: number = Date.now()): FleetAttentionItem[] {
  const items: FleetAttentionItem[] = [];
  for (const row of report.devices) {
    if (!isGenuinelyOffline(row)) continue;
    const seen = row.lastSeen ? ` · last seen ${formatCheckedAge(Date.parse(row.lastSeen), now)}` : '';
    items.push({ glyph: 'offline', subject: row.name, detail: `offline${seen}`, fix: 'check the box' });
  }
  for (const row of report.devices) {
    if (isOffline(row)) continue;
    const reasons: string[] = [];
    if (activeDriftRows(row).length > 0) reasons.push('config drift');
    const stark = starkCliGap(row);
    if (stark) reasons.push(`only ${stark.installed} of ${stark.total} agent CLIs installed`);
    if (reasons.length > 0) {
      items.push({ glyph: 'warn', subject: row.name, detail: reasons.join(' · '), fix: `agents fleet apply --device ${row.name}` });
    }
  }
  const skew = report.warnings.find((w) => w.kind === 'version-skew');
  if (skew) {
    const counts = new Map<string, number>();
    for (const row of report.devices) {
      if (!row.version) continue;
      const v = shortVersion(row.version);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const summary = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([v, n]) => `${n}× ${v}`)
      .join(' · ');
    items.push({ glyph: 'warn', subject: 'version skew', detail: summary, fix: 'agents upgrade --fleet' });
  }
  for (const w of report.warnings) {
    if (w.kind !== 'divergence') continue;
    items.push({
      glyph: 'warn',
      subject: w.devices[0] ?? 'fleet',
      detail: w.message.replace(`${w.devices[0]} `, ''),
      fix: `agents fleet apply --device ${w.devices[0] ?? ''}`.trim(),
    });
  }
  return items;
}

function alignRight(left: string, right: string, width: number): string {
  const gap = width - stringWidth(left) - stringWidth(right);
  return gap > 1 ? `${left}${' '.repeat(gap)}${right}` : `${left}  ${right}`;
}

function headroomWord(row: FleetHealthRow): string {
  if (isOffline(row)) return chalk.gray(row.online === 'unknown' ? 'unknown' : 'offline');
  return headroomLabel(row);
}

function loadMemCell(row: FleetHealthRow): string {
  if (isOffline(row) || !row.stats?.reachable) return chalk.gray('—');
  const load = row.stats.loadPercent === undefined ? '—' : `${Math.round(row.stats.loadPercent)}%`;
  const mem = row.stats.memPercent === undefined ? '—' : `${Math.round(row.stats.memPercent)}%`;
  return `${load} / ${mem}`;
}

function versionCell(row: FleetHealthRow): string {
  if (isOffline(row)) return chalk.gray('—');
  return shortVersion(row.version);
}

export function renderFleetSummary(
  report: FleetHealthReport,
  opts: { self?: string; now?: number } = {},
): string[] {
  const now = opts.now ?? Date.now();
  const width = terminalWidth();
  const rows = report.devices;
  if (rows.length === 0) return [chalk.gray('No registered devices. Run `agents devices` to register some.')];

  const online = rows.filter((r) => !isOffline(r)).length;
  const offline = rows.length - online;
  const oldestStats = oldestAcross(rows, (r) => r.stats?.fetchedAt);
  const cachedAge = oldestStats != null ? `cached ${formatCheckedAge(oldestStats, now)}` : null;
  const rollupRight = [opts.self, cachedAge].filter(Boolean).join(' · ');
  const rollupLeft = `${chalk.bold('Fleet')}   ${chalk.green('●')} ${online} online   ${chalk.gray('○')} ${offline} offline`;
  const lines: string[] = [rollupRight ? alignRight(rollupLeft, chalk.gray(rollupRight), width) : rollupLeft, ''];

  const items = buildFleetAttentionItems(report, now);
  if (items.length === 0) {
    lines.push(chalk.green('Everything looks healthy.'), '');
  } else {
    lines.push(chalk.bold(`NEEDS ATTENTION (${items.length})`));
    const subjW = Math.max(...items.map((i) => i.subject.length));
    const detailW = Math.max(...items.map((i) => stringWidth(i.detail)));
    for (const it of items) {
      const glyph = it.glyph === 'offline' ? chalk.gray('○') : chalk.yellow('⚠');
      const subject = it.glyph === 'offline' ? chalk.gray(it.subject) : it.subject;
      lines.push(
        `  ${glyph}  ${padToWidth(subject, subjW)}   ${padToWidth(it.detail, detailW)}   ${chalk.cyan(`→ ${it.fix}`)}`,
      );
    }
    lines.push('');
  }

  const nameW = Math.min(18, Math.max(6, ...rows.map((r) => r.name.length)));
  const headW = Math.max(...rows.map((r) => stringWidth(headroomWord(r))));
  const loadW = Math.max(...rows.map((r) => stringWidth(loadMemCell(r))));
  const verW = Math.max(7, ...rows.map((r) => stringWidth(versionCell(r))));
  const grouped = new Map<string, FleetHealthRow[]>();
  for (const r of rows) {
    const g = platformGroupLabel(r.platform);
    (grouped.get(g) ?? grouped.set(g, []).get(g)!).push(r);
  }
  for (const group of GROUP_ORDER) {
    const members = grouped.get(group);
    if (!members || members.length === 0) continue;
    members.sort((a, b) =>
      (a.name === opts.self ? -1 : b.name === opts.self ? 1 : 0) || a.name.localeCompare(b.name),
    );
    lines.push(chalk.bold(group));
    for (const row of members) {
      const isSelf = row.name === opts.self;
      const prefix = isSelf ? chalk.cyan('▸') : ' ';
      const marks: string[] = [];
      if (!isOffline(row)) {
        const stark = starkCliGap(row);
        if (stark) marks.push(chalk.yellow(`⚠ CLIs ${stark.installed}/${stark.total}`));
      } else if (isGenuinelyOffline(row) && row.lastSeen) {
        marks.push(chalk.gray(`last seen ${formatCheckedAge(Date.parse(row.lastSeen), now)}`));
      }
      if (row.agents && row.agents.running > 0) {
        marks.push(chalk.cyan(`${row.agents.running} agent${row.agents.running === 1 ? '' : 's'}`));
      }
      if (isSelf) marks.push(chalk.cyan('← this machine'));
      const note = marks.length ? `   ${marks.join('   ')}` : '';
      lines.push(
        ` ${prefix} ${padToWidth(truncateToWidth(row.name, nameW), nameW)}  ` +
        `${padToWidth(headroomWord(row), headW)}  ` +
        `${padToWidth(loadMemCell(row), loadW)}  ` +
        `${padToWidth(versionCell(row), verW)}` +
        note,
      );
    }
    lines.push('');
  }

  const orphaned = rows.filter((r) => r.orphans.length > 0).length;
  if (orphaned > 0) {
    const subject = orphaned === 1 ? '1 device carries' : `${orphaned} devices carry`;
    lines.push(chalk.gray(`${subject} orphaned versions · run  ${chalk.cyan('agents prune')}  to reclaim disk`));
  }
  const freshBits = [
    cachedAge,
    'pass --live to re-probe auth + reachability',
    'pass --verbose for the auth/CLI/sync columns',
  ].filter(Boolean);
  lines.push(chalk.gray(freshBits.join(' · ')));
  return lines;
}
