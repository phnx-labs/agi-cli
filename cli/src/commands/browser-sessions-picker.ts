/** Interactive, task-first `agents browser sessions` / `agents sessions --browser` view
 * (RUSH-2407), TTY path only: non-TTY, `--json`, `--open` and `--no-interactive` fall through to
 * the flat printer in `lib/browser/sessions-list.ts`. */
import { showFile } from '../lib/open-url.js';
import chalk from 'chalk';
import { itemPicker } from '../lib/picker.js';
import { isPromptCancelled } from './utils.js';
import { buildPreview } from './sessions-picker.js';
import { createSessionsPickerCommand } from './sessions-picker-factory.js';
import {
  runBrowserSessions,
  buildBrowserSessionRows,
  matchesBrowserSessionRow,
  formatBytes,
  type BrowserSessionRow,
  type BrowserArtifact,
  type ArtifactKind,
} from '../lib/browser/sessions-list.js';
import { formatRelativeTime } from '../lib/session/relative-time.js';
import { sessionHeadline } from '../lib/session/title.js';

interface BrowserSessionsCommandOpts {
  profile?: string;
  open?: string | boolean;
  json?: boolean;
  interactive?: boolean;
}

const KIND_LABEL: Record<ArtifactKind, string> = {
  screenshot: 'shots',
  pdf: 'pdf',
  recording: 'rec',
  download: 'dl',
};

function formatCounts(counts: Record<ArtifactKind, number>): string {
  const parts: string[] = [];
  for (const kind of Object.keys(KIND_LABEL) as ArtifactKind[]) {
    if (counts[kind] > 0) parts.push(`${KIND_LABEL[kind]} ${counts[kind]}`);
  }
  return parts.join(' · ') || '-';
}

function rowLinkSummary(row: BrowserSessionRow): string {
  if (row.kind === 'downloads') return '';
  if (row.linkStatus === 'linked' && row.linkedSession) {
    const s = row.linkedSession;
    return chalk.cyan(s.agent) + ' — ' + (sessionHeadline(s) || s.shortId);
  }
  if (row.linkStatus === 'unresolved') {
    return chalk.yellow(`owner ${row.owner ?? 'unknown'} (session not indexed here)`);
  }
  return chalk.gray('unlinked');
}

function formatRowLabel(row: BrowserSessionRow): string {
  const name = (row.kind === 'downloads' ? '[downloads]' : (row.task ?? '')).padEnd(30);
  const coloredName = row.kind === 'downloads' ? chalk.gray(name) : name;
  const age = formatRelativeTime(new Date(row.latestMtimeMs).toISOString());
  const counts = formatCounts(row.counts);
  return [
    coloredName,
    row.profile.padEnd(26),
    age.padEnd(11),
    counts.padEnd(18),
    rowLinkSummary(row),
  ].join(' ');
}

const PREVIEW_ARTIFACT_LIMIT = 12;

function buildRowPreview(row: BrowserSessionRow): string {
  const parts: string[] = [];
  if (row.kind === 'downloads') {
    parts.push(chalk.bold(`${row.profile} — downloads`));
  } else if (row.linkStatus === 'linked' && row.linkedSession) {
    parts.push(buildPreview(row.linkedSession));
  } else if (row.linkStatus === 'unresolved') {
    parts.push(chalk.yellow(
      `owner ${row.owner ?? 'unknown'} — launch ${row.launchId} has no indexed session on this machine.`
    ));
  } else {
    parts.push(chalk.gray(
      `Unlinked — no owning agent session is known for this task`
      + (row.owner ? ` (last known owner: ${row.owner}).` : '.')
    ));
  }

  parts.push('');
  parts.push(chalk.bold(`Captures (${row.artifacts.length})`));
  for (const a of row.artifacts.slice(0, PREVIEW_ARTIFACT_LIMIT)) {
    const age = formatRelativeTime(new Date(a.mtimeMs).toISOString());
    parts.push(`  ${age.padEnd(11)}  ${a.name.padEnd(30)}  ${formatBytes(a.bytes).padStart(8)}`);
  }
  const more = row.artifacts.length - PREVIEW_ARTIFACT_LIMIT;
  if (more > 0) parts.push(chalk.gray(`  … (${more} more)`));

  return parts.join('\n');
}

function formatArtifactLabel(a: BrowserArtifact): string {
  const age = formatRelativeTime(new Date(a.mtimeMs).toISOString());
  return `${age.padEnd(11)}  ${a.name.padEnd(34)}  ${formatBytes(a.bytes).padStart(8)}`;
}

async function openAndReport(a: BrowserArtifact): Promise<void> {
  console.log(a.path);
  if ((await showFile(a.path)).via === 'none') console.error(`Could not open ${a.path}`);
}

async function pickArtifact(row: BrowserSessionRow): Promise<BrowserArtifact | null> {
  try {
    const picked = await itemPicker<BrowserArtifact>({
      message: `Captures — ${row.task ?? 'downloads'} (${row.profile}):`,
      items: row.artifacts,
      filter: (query) => {
        const q = query.trim().toLowerCase();
        return q ? row.artifacts.filter((a) => a.name.toLowerCase().includes(q)) : row.artifacts;
      },
      labelFor: (a) => formatArtifactLabel(a),
      emptyMessage: 'No captures.',
      enterHint: 'open',
    });
    return picked?.item ?? null;
  } catch (err) {
    if (isPromptCancelled(err)) return null;
    throw err;
  }
}

const browserSessionsPicker = createSessionsPickerCommand<BrowserSessionRow, BrowserSessionsCommandOpts>({
  requireOpenUndefined: true,
  runFlat: (opts) => runBrowserSessions({ profile: opts.profile, open: opts.open, json: opts.json }),
  buildRows: (opts) => buildBrowserSessionRows(opts.profile),
  emptyMessage: (opts) => `No browser captures found${opts.profile ? ` for profile "${opts.profile}"` : ''}.`,
  message: 'Browser sessions:',
  matches: matchesBrowserSessionRow,
  labelFor: formatRowLabel,
  buildPreview: buildRowPreview,
  emptyFilterMessage: 'No browser sessions match.',
  enterHint: 'open capture',
  onOpen: async (row) => {
    if (row.artifacts.length === 0) {
      console.log('No captures in this task yet.');
      return;
    }
    if (row.artifacts.length === 1) {
      await openAndReport(row.artifacts[0]);
      return;
    }
    const artifact = await pickArtifact(row);
    if (artifact) await openAndReport(artifact);
  },
});

export function shouldOpenInteractiveBrowserSessions(opts: BrowserSessionsCommandOpts, isTTY: boolean): boolean {
  return browserSessionsPicker.shouldOpen(opts, isTTY);
}

/** Shared entry point for `agents browser sessions` and `agents sessions --browser`, so the
 * interactive routing decision lives in one place. */
export async function runBrowserSessionsCommand(opts: BrowserSessionsCommandOpts): Promise<void> {
  await browserSessionsPicker.run(opts);
}
