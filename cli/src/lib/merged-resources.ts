/** The merged, first-wins DotAgents resource surface: every kind in one table with the winning
 * layer per row, shown by `agents view --merged` (ported from `agents resources`). Shows the
 * project > user > extras > system merge; a shared lib so `inspect` can reuse it. */

import * as path from 'path';
import chalk from 'chalk';
import { listResources, type ResolvedResource, type ResourceKind } from './resources.js';
import { terminalWidth, truncateToWidth, stringWidth } from './session/width.js';

const DRILLABLE_KINDS = [
  'skills',
  'commands',
  'mcp',
  'hooks',
  'rules',
  'plugins',
  'workflows',
  'subagents',
] as const;

type DrillableKind = typeof DRILLABLE_KINDS[number];

const KIND_LABELS: Record<DrillableKind, string> = {
  skills: 'Skills',
  commands: 'Commands',
  mcp: 'MCP',
  hooks: 'Hooks',
  rules: 'Rules',
  plugins: 'Plugins',
  workflows: 'Workflows',
  subagents: 'Subagents',
};

interface ResourceGroup {
  kind: DrillableKind;
  rows: ResolvedResource[];
}

export function renderMergedResources(): void {
  const groups: ResourceGroup[] = DRILLABLE_KINDS.map((kind) => ({
    kind,
    rows: listResources(kind as ResourceKind),
  }));
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);

  if (total === 0) {
    console.log(chalk.gray('No merged resources found.'));
    return;
  }

  console.log(chalk.bold(`Resources (${total} merged)`));
  for (const group of groups) {
    console.log();
    console.log(chalk.bold(`${KIND_LABELS[group.kind]} (${group.rows.length})`));
    if (group.rows.length === 0) {
      console.log(chalk.gray('  none'));
      continue;
    }
    for (const line of renderResourceRows(group.rows)) console.log(line);
  }
}

function renderResourceRows(rows: ResolvedResource[]): string[] {
  const nameW = Math.min(28, Math.max('Name'.length, ...rows.map((row) => stringWidth(row.name))));
  const layerW = Math.min(16, Math.max('Layer'.length, ...rows.map((row) => stringWidth(row.source))));
  const prefixW = 2 + nameW + 2 + layerW + 2;
  const pathW = Math.max(12, terminalWidth() - prefixW);

  const lines = [
    `  ${chalk.bold(pad(row('Name', nameW), nameW))}  ${chalk.bold(pad(row('Layer', layerW), layerW))}  ${chalk.bold('Path')}`,
    `  ${chalk.gray(`${'-'.repeat(nameW)}  ${'-'.repeat(layerW)}  ${'-'.repeat(Math.min(pathW, 40))}`)}`,
  ];

  for (const resource of rows) {
    lines.push(
      `  ${chalk.cyan(pad(truncateToWidth(resource.name, nameW), nameW))}  ${pad(resource.source, layerW)}  ${chalk.gray(truncateToWidth(formatPath(resource.path), pathW))}`,
    );
  }

  return lines;
}

function row(value: string, width: number): string {
  return truncateToWidth(value, width);
}

function pad(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - stringWidth(value)));
}

function formatPath(value: string): string {
  const home = process.env.HOME;
  if (home) {
    const rel = path.relative(home, value);
    if (rel === '') return '~';
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return `~/${rel}`;
  }
  return value;
}
