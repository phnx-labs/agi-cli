/**
 * Interactive browser task picker with preview.
 *
 * Powers the fuzzy-searchable task list shown by `agents browser status` in a TTY.
 * Shows task name, profile, domains, and tab count; preview pane shows full tab list.
 */
import chalk from 'chalk';
import { truncate, humanDuration } from '../lib/format.js';
import type { ProfileStatus, TaskStatus } from '../lib/browser/types.js';
import { itemPicker } from '../lib/picker.js';

export interface BrowserTask {
  task: TaskStatus;
  profile: ProfileStatus;
}

interface PickedBrowserTask {
  task: BrowserTask;
  action: 'view' | 'stop';
}

const DOT = chalk.gray(' · ');

function formatAge(ms: number): string {
  return humanDuration(Date.now() - ms) + ' ago';
}

/** Build the preview pane for a browser task. */
function buildBrowserPreview(item: BrowserTask): string {
  const { task, profile } = item;
  const lines: string[] = [];

  // Line 1: Task name (ID: xxx)
  lines.push(chalk.bold.white(`Task: ${task.name}`) + chalk.gray(` (${task.id})`));

  // Line 2: Profile info
  const profileParts: string[] = [chalk.cyan(profile.name)];
  if (profile.port) profileParts.push(`port ${profile.port}`);
  if (profile.pid) profileParts.push(`pid ${profile.pid}`);
  lines.push(chalk.gray('Profile: ') + profileParts.join(DOT));

  // Line 3: Timing
  const started = formatAge(task.createdAt);
  const duration = humanDuration(Date.now() - task.createdAt);
  lines.push(chalk.gray('Started: ') + chalk.white(started) + DOT + chalk.gray('Duration: ') + chalk.white(duration));

  // Blank line
  lines.push('');

  // Tabs section
  if (task.tabs && task.tabs.length > 0) {
    lines.push(chalk.gray('Tabs:'));
    const termWidth = process.stdout.columns || 80;
    const urlMax = Math.max(30, termWidth - 16);

    for (const tab of task.tabs) {
      const marker = tab.current ? chalk.yellow('*') : ' ';
      const id = chalk.gray(tab.id);
      const url = truncate(tab.url, urlMax);
      lines.push(`  ${id} ${marker} ${chalk.white(url)}`);
    }
  } else {
    lines.push(chalk.gray('No tabs open'));
  }

  return lines.join('\n');
}

/** Build the list label for a browser task. */
function buildBrowserLabel(item: BrowserTask, query: string): string {
  const { task, profile } = item;
  const termWidth = process.stdout.columns || 80;

  // Format: name profile tabs domains age
  const name = task.name.padEnd(20);
  const profileName = profile.name.padEnd(12);
  const tabs = `${task.tabCount} tab${task.tabCount === 1 ? '' : 's'}`.padEnd(8);
  const age = formatAge(task.createdAt);

  // Domains - fill remaining space
  const fixedWidth = 20 + 12 + 8 + 10; // name + profile + tabs + age
  const domainsWidth = Math.max(10, termWidth - fixedWidth - 4);
  const domains = task.domains?.length
    ? truncate(task.domains.join(', '), domainsWidth)
    : chalk.gray('no sites');

  // Highlight query matches
  let label = `${name}${chalk.cyan(profileName)}${tabs}${domains.padEnd(domainsWidth)}${chalk.gray(age)}`;

  if (query) {
    const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    label = label.replace(re, chalk.yellow.bold('$1'));
  }

  return label;
}

interface BrowserPickerConfig {
  message: string;
  tasks: BrowserTask[];
  pageSize?: number;
  initialSearch?: string;
}

/** Show an interactive browser task picker. */
export async function browserTaskPicker(config: BrowserPickerConfig): Promise<PickedBrowserTask | null> {
  const picked = await itemPicker<BrowserTask>({
    message: config.message,
    items: config.tasks,
    filter: (query) => {
      if (!query) return config.tasks;
      const q = query.toLowerCase();
      return config.tasks.filter((t) =>
        t.task.name.toLowerCase().includes(q) ||
        t.profile.name.toLowerCase().includes(q) ||
        t.task.domains?.some((d) => d.toLowerCase().includes(q))
      );
    },
    labelFor: buildBrowserLabel,
    buildPreview: buildBrowserPreview,
    shortIdFor: (t) => t.task.name,
    pageSize: config.pageSize ?? 10,
    initialSearch: config.initialSearch,
    emptyMessage: 'No browser tasks running.',
    enterHint: 'view tabs',
  });
  if (!picked) return null;
  return { task: picked.item, action: 'view' };
}
