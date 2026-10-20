import type { Command } from 'commander';
import chalk from 'chalk';
import type { FilterOptions, SessionEvent, SessionMeta } from '@phnx-labs/sessions-cli/reader';

import { setHelpSections } from '../lib/help.js';
import { interruptibleSpinner } from '../lib/spinner.js';
import { deriveShortId } from '../lib/text/short-id.js';
import type { CloudTask } from '../lib/cloud/types.js';
import type { TranscriptRenderOptions } from '../lib/session/presentation.js';

export interface CloudTranscriptsOptions extends TranscriptRenderOptions {
  limit?: string;
}

const DEFAULT_LIMIT = '50';

function cloudTaskSessionMeta(task: CloudTask): SessionMeta | null {
  if (task.agent !== 'claude' && task.agent !== 'codex' && task.agent !== 'opencode') return null;
  return {
    id: task.id,
    shortId: deriveShortId(task.id),
    agent: task.agent,
    timestamp: task.createdAt,
    project: task.repo,
    filePath: '',
    topic: task.prompt.split('\n')[0]?.slice(0, 120) || undefined,
    label: `[cloud/${task.status}]${task.branch ? ` ${task.branch}` : ''}`,
  };
}

async function runCloudTranscripts(query: string | undefined, options: CloudTranscriptsOptions): Promise<void> {
  const { getRushProvider } = await import('../lib/cloud/registry.js');
  const { buildFilterOptions, printSessionTable, resolveViewMode, renderSessionEvents } = await import('../lib/session/presentation.js');
  const rush = getRushProvider();

  let filterOpts: FilterOptions;
  try {
    filterOpts = buildFilterOptions(options);
  } catch (err: any) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }

  const mode = resolveViewMode(options, filterOpts);
  const spinner = options.json ? null : interruptibleSpinner('Loading cloud sessions...').start();

  let sessions: SessionMeta[];
  try {
    sessions = (await rush.list())
      .map(cloudTaskSessionMeta)
      .filter((s): s is SessionMeta => s !== null)
      .slice(0, parseInt(options.limit || DEFAULT_LIMIT, 10));
  } catch (err: any) {
    spinner?.stop();
    console.error(chalk.red(`Failed to list cloud sessions: ${err?.message || err}`));
    process.exit(1);
  }
  spinner?.stop();

  if (!query) {
    if (options.json) {
      process.stdout.write(JSON.stringify(sessions, null, 2) + '\n');
      return;
    }
    if (sessions.length === 0) {
      console.log(chalk.gray('No cloud sessions yet.'));
      return;
    }
    printSessionTable(sessions);
    return;
  }

  const matches = sessions.filter(
    (s) => s.id === query || s.shortId === query || s.id.startsWith(query),
  );
  if (matches.length === 0) {
    console.error(chalk.red(`No cloud session matching: ${query}`));
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(chalk.red(`Multiple cloud sessions match "${query}":`));
    for (const m of matches.slice(0, 10)) {
      console.error(chalk.cyan(`  ${m.shortId}  ${m.id}`));
    }
    process.exit(1);
  }

  const meta = matches[0];
  const fetchSpinner = options.json ? null : interruptibleSpinner('Fetching session...').start();
  let events: SessionEvent[];
  try {
    events = await rush.transcript({ id: meta.id, createdAt: meta.timestamp }, meta.agent);
  } catch (err: any) {
    fetchSpinner?.stop();
    console.error(chalk.red(`Failed to fetch session: ${err?.message || err}`));
    process.exit(1);
  }
  fetchSpinner?.stop();

  renderSessionEvents(meta, events, mode, filterOpts, options);
}

export function registerCloudTranscriptsCommand(cloud: Command): void {
  const cmd = cloud
    .command('transcripts [selector]')
    .description('List captured Rush Cloud run transcripts, or render one by id, short id, or id prefix.')
    .option('-n, --limit <n>', 'Maximum number of runs to list', DEFAULT_LIMIT)
    .option('--json', 'Output JSON (run list without a selector, event array for one run)')
    .option('--markdown', 'Render the transcript as markdown (user, assistant, thinking, tool calls)')
    .option('--no-redact', 'Disable default secret redaction in rendered output (--markdown and --json)')
    .option('--include <roles>', 'Only include these roles (comma-separated): user, assistant, thinking, tools')
    .option('--exclude <roles>', 'Exclude these roles (comma-separated): user, assistant, thinking, tools')
    .option('--first <n>', 'Keep only the first N turns (a turn starts at each genuine user message)')
    .option('--last <n>', 'Keep only the last N turns (a turn starts at each genuine user message)')
    .action(async (selector: string | undefined, options: CloudTranscriptsOptions) => {
      await runCloudTranscripts(selector, options);
    });

  setHelpSections(cmd, {
    examples: `
      # Captured runs, newest first
      agents cloud transcripts

      # One run's transcript as a summary, then as markdown
      agents cloud transcripts 3f2a9c1e
      agents cloud transcripts 3f2a9c1e --markdown

      # The last two turns of a run, tools only, as JSON
      agents cloud transcripts 3f2a9c1e --include tools --last 2 --json
    `,
    notes: `
      - Reads Rush Cloud runs with your Rush API key (RUSH_API_KEY and RUSH_ORG, from the bundle named in cloud.providers.rush.secretsBundle or the environment). A missing or rejected key, or an unmatched or ambiguous selector, exits 1; it never falls back to local sessions.
      - Every render fetches the run's transcript again from the developer API (\`GET /o/{org}/sessions/{id}/messages\`).
      - \`agents cloud list/status/logs\` cover the run jobs, not their transcripts.
    `,
  });
}
