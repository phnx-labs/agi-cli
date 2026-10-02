/** Render selected normalized session transcripts as redacted Markdown documents. */
import * as fs from 'fs';
import { stripVTControlCharacters } from 'node:util';
import chalk from 'chalk';
import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';
import { knownSecretValuesFromEnv, redactSecrets } from '../lib/redact.js';
import { discoverSessions } from '../lib/session/discover.js';
import { parseSession } from '@phnx-labs/sessions-cli/reader';
import { extractSessionTopic, isSyntheticUserMessage } from '@phnx-labs/sessions-cli/reader';
import { renderConversationMarkdown } from '@phnx-labs/sessions-cli/reader';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { buildPreview } from './sessions-picker.js';
import { parseAgentFilter } from './sessions.js';
import { selectSessions } from './sessions-export.js';

export const MARKDOWN_RENDER_AGENTS = [
  'claude',
  'codex',
  'antigravity',
  'opencode',
  'grok',
  'rush',
  'hermes',
  'kimi',
  'droid',
  'cursor',
] as const;
export type ReasoningMode = 'omit' | 'fold' | 'include';

interface RenderGlobals {
  all?: boolean;
  since?: string;
  limit?: string;
  agent?: string;
  redact?: boolean;
  json?: boolean;
}

interface RenderOptions {
  format: string;
  output?: string;
  reasoning: string;
}

function parseReasoning(value: string): ReasoningMode {
  if (value === 'omit' || value === 'fold' || value === 'include') return value;
  throw new Error(`Unknown reasoning mode "${value}". Expected omit, fold, or include.`);
}

function quotePreview(preview: string): string {
  return preview.split('\n').map((line) => `> ${line}`).join('\n');
}

/** Build one shareable Markdown document from the canonical preview and event model. */
export function renderSessionMarkdownDocument(
  session: SessionMeta,
  options: {
    redact?: boolean;
    reasoning?: ReasoningMode;
    knownSecrets?: readonly string[];
    maxToolOutputChars?: number;
  } = {},
): string {
  if (!(MARKDOWN_RENDER_AGENTS as readonly string[]).includes(session.agent)) {
    throw new Error(
      `Cannot render ${session.agent} session ${session.shortId || session.id}: Markdown rendering supports ${MARKDOWN_RENDER_AGENTS.join(', ')}.`,
    );
  }
  // Preserve normalized tool output here so the Markdown renderer owns the
  // visible cap and can report exactly how much it omitted.
  const events = parseSession(session.filePath, session.agent, { maxToolOutputChars: Infinity });
  if (events.length === 0) {
    throw new Error(`Cannot render ${session.agent} session ${session.shortId || session.id}: transcript produced no normalized events.`);
  }
  const shouldRedact = options.redact !== false;
  const sanitize = (text: string): string => shouldRedact ? redactSecrets(text, options.knownSecrets) : text;
  const preview = sanitize(stripVTControlCharacters(buildPreview(session)));
  const shareEvents = events.filter((event) => !(event.type === 'message' && event._synthetic));
  const firstPrompt = shareEvents.find((event) => event.type === 'message' && event.role === 'user')?.content;
  const title = sanitize(
    session.label || (firstPrompt ? extractSessionTopic(firstPrompt) : undefined) ||
    (session.topic && !isSyntheticUserMessage(session.topic) ? session.topic : undefined) ||
    `${session.agent} session ${session.shortId || session.id}`,
  );
  const conversation = renderConversationMarkdown(shareEvents, {
    redact: shouldRedact,
    knownSecrets: options.knownSecrets,
    reasoning: options.reasoning ?? 'omit',
    maxToolOutputChars: options.maxToolOutputChars,
  });
  return `# ${title}\n\n## Session preview\n\n${quotePreview(preview)}\n\n## Conversation\n\n${conversation}\n`;
}

export function registerSessionsRenderCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('render <selectors...>')
    .description('Render one or more sessions as readable, redacted Markdown for review or sharing.')
    .option('--format <format>', 'Output format (md or markdown)', 'md')
    .option('-o, --output <path>', 'Write the rendered document to a file instead of stdout')
    .option('--reasoning <mode>', 'Reasoning visibility: omit, fold, or include', 'omit');

  setHelpSections(cmd, {
    examples: `# Render one redacted session for a confidential gist
agents sessions render a1b2c3d4 -o session.md

# Combine several sessions into one Markdown document
agents sessions render a1b2c3d4 d4c3b2a1 -o delivery-sessions.md

# Keep reasoning locally in collapsible sections and opt out of redaction
agents sessions render a1b2c3d4 --reasoning fold --no-redact`,
    notes: `Markdown is redacted by default, including credential-shaped values and local home paths.
The preview at the top is the same preview shown by 'agents sessions'. Tool output is truncated
with an explicit note. Use --no-redact only for local output that will not be shared.`,
  });

  cmd.action(async (selectors: string[], options: RenderOptions, command: Command) => {
    const globals = command.optsWithGlobals() as RenderGlobals;
    if (!['md', 'markdown'].includes(options.format.toLowerCase())) {
      throw new Error(`Unknown format "${options.format}". Expected md or markdown.`);
    }
    const reasoning = parseReasoning(options.reasoning);
    const limit = Math.max(1, Number.parseInt(globals.limit || '100', 10) || 100);
    const agent = parseAgentFilter(globals.agent).agent;
    const sessions = selectSessions(await discoverSessions({
      all: globals.all !== false,
      since: globals.since,
      limit,
      agent: agent ?? undefined,
    }), selectors);
    if (sessions.length === 0) {
      process.stderr.write(chalk.yellow('No sessions matched the selection.\n'));
      process.exitCode = 1;
      return;
    }
    const knownSecrets = globals.redact === false ? undefined : knownSecretValuesFromEnv();
    const rendered = sessions.map((session) => ({
      id: session.id,
      agent: session.agent,
      markdown: renderSessionMarkdownDocument(session, {
        redact: globals.redact !== false,
        reasoning,
        knownSecrets,
      }),
    }));
    const markdown = rendered.map((item) => item.markdown.trimEnd()).join('\n\n---\n\n') + '\n';
    if (options.output) fs.writeFileSync(options.output, markdown, { mode: 0o600 });
    if (globals.json) {
      process.stdout.write(JSON.stringify({ redacted: globals.redact !== false, reasoning, sessions: rendered }, null, 2) + '\n');
    } else if (!options.output) {
      process.stdout.write(markdown);
    } else {
      process.stderr.write(chalk.green(`Rendered ${rendered.length} session${rendered.length === 1 ? '' : 's'} to ${options.output}\n`));
    }
  });
}
