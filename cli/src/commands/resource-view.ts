/**
 * Shared resource list and detail view.
 *
 * Provides a reusable picker (TTY) / table (piped) presentation layer
 * for resource-type commands (plugins, subagents, skills, etc.). Each
 * resource supplies rows with sync targets; this module handles layout,
 * filtering, and paging.
 */

import chalk from 'chalk';
import { truncate, padVisible, termLink } from '../lib/format.js';
import type { AgentId } from '../lib/types.js';
import { agentLabel } from '../lib/agents.js';
import { itemPicker } from '../lib/picker.js';
import { isInteractiveTerminal, isPromptCancelled, printWithPager } from './utils.js';
import { terminalWidth, truncateToWidth, padToWidth, stringWidth, stripAnsi } from '../lib/session/width.js';

export type SyncStatus = 'synced' | 'stale' | 'missing';

export interface SyncTarget {
  agent: AgentId;
  version: string;
  isDefault?: boolean;
  status: SyncStatus;
}

export interface ResourceRow {
  name: string;
  description?: string;
  extra?: string; // small per-type metric (e.g., "3 rules", "http")
  extra2?: string; // optional secondary metric (e.g., marketplace name)
  targets: SyncTarget[];
  buildDetail: () => string;
}

interface ResourceViewOptions {
  resourcePlural: string;
  resourceSingular: string;
  extraLabel?: string;
  extra2Label?: string;
  rows: ResourceRow[];
  emptyMessage: string;
  centralPath?: string;
  /** When the user specified agent or agent@version, we scope per-agent. */
  filterAgent?: AgentId;
  filterVersion?: string;
  /** Emit machine-readable JSON instead of the picker/table (for agents/scripts). */
  json?: boolean;
  /**
   * Show the "Synced" column. Default true — the central-storage commands all
   * answer "which agent versions have this?". `agents inspect <repo>` does not:
   * there the repo IS the source, and empty `targets` would render the
   * misleading "no installed versions". Set false to drop the column entirely.
   */
  showSync?: boolean;
  /**
   * Cap for the Name column. Defaults to NAME_CAP (22), which suits the
   * central-storage commands. Kinds whose rows have no description — hooks are
   * all script names and no prose — want a wider cap, otherwise four pairs of
   * `00-agent-verify-work-complete…` truncate to the same string while the
   * empty Description column wastes the rest of the terminal.
   */
  nameCap?: number;
  /** Per-row OSC-8 link target, keyed by row name; makes names clickable. */
  linkFor?: (row: ResourceRow) => string | undefined;
}

/** Whether the Synced column renders for this view. */
function syncEnabled(opts: ResourceViewOptions): boolean {
  return opts.showSync !== false;
}

/** Display a resource list: interactive picker in TTY mode, plain table otherwise. */
export async function showResourceList(opts: ResourceViewOptions): Promise<void> {
  if (opts.json) {
    // Strip the non-serializable buildDetail thunk; emit the row metadata plus
    // each resource's per-agent-version sync targets. One shared JSON contract
    // for every resource `list` built on this helper.
    const rows = opts.rows.map(({ buildDetail, ...row }) => row);
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (opts.rows.length === 0) {
    console.log(chalk.gray(opts.emptyMessage));
    return;
  }

  if (!isInteractiveTerminal()) {
    printResourceTable(opts);
    return;
  }

  let picked;
  try {
    picked = await itemPicker<ResourceRow>({
      message: buildPickerMessage(opts),
      items: opts.rows,
      filter: (query) => filterRows(opts.rows, query),
      labelFor: (row) => formatPickerRow(row, opts),
      buildPreview: (row) => row.buildDetail(),
      // Row numbers say where each entry sits in the list while scrolling —
      // and read against the total when the caller prints one, as
      // `agents inspect` does with its "commands (12)" header.
      numbered: true,
      pageSize: 12,
      emptyMessage: `No matching ${opts.resourcePlural}.`,
      enterHint: 'view',
    });
  } catch (err) {
    if (isPromptCancelled(err)) return;
    throw err;
  }

  if (!picked) return;

  // Dump the full detail in a pager for inspection.
  const detail = picked.item.buildDetail();
  const lines = detail.split('\n');
  printWithPager(detail, lines.length);
}

/** Build the prompt message shown above the picker, including any scope label. */
function buildPickerMessage(opts: ResourceViewOptions): string {
  const scope = opts.filterVersion
    ? ` (${opts.filterAgent}@${opts.filterVersion})`
    : opts.filterAgent
      ? ` (${opts.filterAgent})`
      : '';
  return `Search ${opts.resourcePlural}${scope}:`;
}

/** Filter rows by a case-insensitive substring match on name or description. */
function filterRows(rows: ResourceRow[], query: string): ResourceRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) =>
    r.name.toLowerCase().includes(q) ||
    (r.description?.toLowerCase().includes(q) ?? false)
  );
}

/** Row label rendered inside the picker list. */
function formatPickerRow(row: ResourceRow, opts: ResourceViewOptions): string {
  // Link here, not in the wide table: that renders only when stdout is NOT a
  // TTY, and termLink is a no-op off-TTY — so a link there could never appear.
  // The picker is the TTY path, which is where the pre-picker list had one.
  const linkTarget = opts.linkFor?.(row);
  const padded = chalk.cyan(padVisible(row.name, opts.nameCap ?? 22));
  const name = linkTarget ? termLink(padded, linkTarget) : padded;
  const extra = opts.extraLabel
    ? chalk.gray(padVisible(row.extra ?? '-', 10))
    : '';
  const extra2 = opts.extra2Label
    ? chalk.gray(padVisible(row.extra2 ?? '-', 16))
    : '';
  const descRaw = row.description ? truncate(row.description, 40) : '';
  if (!syncEnabled(opts)) {
    // No sync column: give the reclaimed width back to the description.
    return `${name} ${extra}${extra2}${chalk.gray(row.description ? truncate(row.description, 84) : '')}`;
  }
  const desc = padVisible(chalk.gray(descRaw), 42);
  const sync = formatSyncSummary(row.targets, opts);
  return `${name} ${extra}${extra2}${desc} ${sync}`;
}

/** Max width for the Name column in the wide table. */
const NAME_CAP = 22;
/** Below this many columns of description budget, the list stacks into cards. */
const MIN_DESC_W = 24;

interface ResourceLayout {
  mode: 'table' | 'cards';
  nameW: number;
  extraW: number;
  extra2W: number;
  descW: number;
  syncW: number;
}

/**
 * Pure column arithmetic. Decides table vs. cards for the effective terminal
 * width and sizes the flexible Description column from whatever is left after the
 * fixed columns and a capped Sync column — so the table fits `cols` instead of
 * the old fixed 22+10+16+42+∞ layout that overflowed every narrow terminal.
 */
export function resourceLayout(
  cols: number,
  o: { hasExtra: boolean; hasExtra2: boolean; nameW: number; syncW: number },
): ResourceLayout {
  const extraW = o.hasExtra ? 10 : 0;
  const extra2W = o.hasExtra2 ? 16 : 0;
  // Cap Sync so a long "missing on …" tail can't starve the description.
  // syncW 0 means the caller dropped the column — keep it 0 rather than
  // floor it to 14, which would reserve width for a column we never draw.
  const syncW = o.syncW === 0 ? 0 : Math.min(o.syncW, Math.max(14, Math.floor(cols * 0.32)));
  const fixed =
    o.nameW + 1 + (extraW ? extraW + 1 : 0) + (extra2W ? extra2W + 1 : 0) + 1 + syncW;
  const descW = cols - fixed;
  return {
    mode: descW >= MIN_DESC_W ? 'table' : 'cards',
    nameW: o.nameW,
    extraW,
    extra2W,
    descW,
    syncW,
  };
}

/** Render resources (used when output is piped). Responsive: wide table or cards. */
function printResourceTable(opts: ResourceViewOptions): void {
  const cols = terminalWidth();
  const syncStrings = opts.rows.map((r) => formatSyncSummary(r.targets, opts));
  const nameW = Math.min(
    opts.nameCap ?? NAME_CAP,
    Math.max('Name'.length, ...opts.rows.map((r) => stringWidth(r.name))),
  );
  const syncMax = syncEnabled(opts)
    ? Math.max('Synced'.length, ...syncStrings.map((s) => stringWidth(s)))
    : 0;
  const layout = resourceLayout(cols, {
    hasExtra: Boolean(opts.extraLabel),
    hasExtra2: Boolean(opts.extra2Label),
    nameW,
    syncW: syncMax,
  });

  if (layout.mode === 'cards') {
    renderResourceCards(opts, cols, syncStrings);
  } else {
    renderResourceWideTable(opts, layout, syncStrings);
  }

  console.log();
  const summary: string[] = [
    `${opts.rows.length} ${opts.rows.length === 1 ? opts.resourceSingular : opts.resourcePlural}`,
  ];
  if (opts.centralPath) {
    summary.push(`central: ${opts.centralPath}`);
  }
  console.log(chalk.gray(summary.join(' · ')));
}

/** Wide aligned table: Name · [Extra] · [Extra2] · Description (flex) · Synced. */
function renderResourceWideTable(
  opts: ResourceViewOptions,
  L: ResourceLayout,
  syncStrings: string[],
): void {
  const cell = (text: string, width: number, color?: (s: string) => string): string => {
    const clipped = truncateToWidth(text, width);
    return padToWidth(color ? color(clipped) : clipped, width);
  };

  // Pass the colour as the third arg: cell() truncates the plain text first, then
  // colours the result. Pre-colouring here would be stripped by truncateToWidth.
  const headerParts = [cell('Name', L.nameW, chalk.bold)];
  if (L.extraW) headerParts.push(cell(opts.extraLabel ?? '', L.extraW, chalk.bold));
  if (L.extra2W) headerParts.push(cell(opts.extra2Label ?? '', L.extra2W, chalk.bold));
  headerParts.push(cell('Description', L.descW, chalk.bold));
  if (L.syncW) headerParts.push(chalk.bold('Synced'));
  console.log(headerParts.join(' ').trimEnd());

  const contentW =
    L.nameW + 1 + (L.extraW ? L.extraW + 1 : 0) + (L.extra2W ? L.extra2W + 1 : 0) + L.descW + (L.syncW ? 1 + L.syncW : 0);
  console.log(chalk.gray('─'.repeat(Math.min(contentW, terminalWidth()))));

  opts.rows.forEach((row, i) => {
    // No link here: this path renders only when stdout is not a TTY, where
    // termLink is a no-op. The picker (formatPickerRow) carries the link.
    const parts = [cell(row.name, L.nameW, chalk.cyan)];
    if (L.extraW) parts.push(cell(row.extra ?? '-', L.extraW));
    if (L.extra2W) parts.push(cell(row.extra2 ?? '-', L.extra2W));
    parts.push(cell(row.description ?? '-', L.descW, chalk.gray));
    if (L.syncW) {
      let sync = syncStrings[i] ?? '';
      if (stringWidth(sync) > L.syncW) sync = chalk.gray(truncateToWidth(sync, L.syncW));
      parts.push(sync);
    }
    console.log(parts.join(' ').trimEnd());
  });
}

/** Stacked cards for narrow terminals: name + meta on one line, description below. */
function renderResourceCards(
  opts: ResourceViewOptions,
  cols: number,
  syncStrings: string[],
): void {
  opts.rows.forEach((row, i) => {
    const meta = [row.extra, row.extra2, syncEnabled(opts) ? stripAnsi(syncStrings[i] ?? '') : '']
      .filter((s): s is string => Boolean(s && s.trim()))
      .join(' · ');
    const metaBudget = Math.max(8, cols - stringWidth(row.name) - 2);
    const line1 = meta
      ? `${chalk.cyan(row.name)}  ${chalk.gray(truncateToWidth(meta, metaBudget))}`
      : chalk.cyan(row.name);
    console.log(line1);
    if (row.description) {
      console.log(`    ${chalk.gray(truncateToWidth(row.description, cols - 4))}`);
    }
  });
}

/** Compact sync summary: "everywhere", "14 of 16 installs", or "not installed". */
function formatSyncSummary(targets: SyncTarget[], opts: ResourceViewOptions): string {
  if (targets.length === 0) {
    return chalk.gray('no installed versions');
  }

  const synced = targets.filter((t) => t.status === 'synced');
  const stale = targets.filter((t) => t.status === 'stale');
  const missing = targets.filter((t) => t.status === 'missing');

  // Narrow case: single-version scope gives a boolean answer.
  if (opts.filterVersion && targets.length === 1) {
    const t = targets[0];
    if (t.status === 'synced') return chalk.green('installed');
    if (t.status === 'stale') return chalk.yellow('stale');
    return chalk.red('missing');
  }

  const total = targets.length;
  const presentCount = synced.length + stale.length;
  const unit = total === 1 ? 'install' : 'installs';

  let core: string;
  if (presentCount === 0) {
    core = chalk.red('not installed');
  } else if (presentCount === total && stale.length === 0) {
    core = chalk.green('everywhere');
  } else {
    core = chalk.yellow(`${presentCount} of ${total} ${unit}`);
  }

  const parts = [core];

  if (stale.length > 0) {
    parts.push(chalk.yellow(`${stale.length} stale`));
  }

  // Hint which agents are missing when the spread is lopsided.
  if (missing.length > 0 && missing.length <= 2) {
    const missLabels = missing.map((t) => `${t.agent}@${t.version}`).join(', ');
    parts.push(chalk.gray(`missing on ${missLabels}`));
  }

  return parts.join(chalk.gray(' · '));
}

/** Build the sync targets section showing version pills grouped by agent. */
export function buildTargetsSection(targets: SyncTarget[]): string {
  if (targets.length === 0) return chalk.gray('  No capable agent versions installed.');

  // Group by agent
  const byAgent = new Map<AgentId, SyncTarget[]>();
  for (const t of targets) {
    const list = byAgent.get(t.agent) || [];
    list.push(t);
    byAgent.set(t.agent, list);
  }

  const lines: string[] = [];
  for (const [agent, list] of byAgent) {
    const label = agentLabel(agent);
    const pills = list.map((t) => formatVersionPill(t)).join(' ');
    lines.push(`  ${label}  ${pills}`);
  }
  return lines.join('\n');
}

/** Render a single version as a colored pill (green/yellow/strikethrough). */
function formatVersionPill(t: SyncTarget): string {
  const star = t.isDefault ? chalk.yellow('★ ') : '';
  const vtxt = `v${t.version}`;
  switch (t.status) {
    case 'synced':
      return star + chalk.green(vtxt);
    case 'stale':
      return star + chalk.yellow(`${vtxt} (stale)`);
    case 'missing':
      return star + chalk.gray.strikethrough(vtxt);
  }
}

/** Pad a string to a fixed width, accounting for ANSI escape codes in length calculation. */
