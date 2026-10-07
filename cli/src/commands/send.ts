import type { Command } from 'commander';
import chalk from 'chalk';
import { die } from '../lib/format.js';
import { setHelpSections } from '../lib/help.js';
import { readMeta } from '../lib/state.js';
import { sendMessage, isOwnerAlias, type ResolveSendInput } from '../lib/channels/send.js';
import type { TerminalSendOptions } from '../lib/channels/registry.js';
import { fireTraceSyncInBackground } from '../lib/run-trace-sync.js';

interface SendCliOpts {
  text?: string;
  channel?: string;
  to?: string;
  thread?: string;
  attach?: string[];
  attachment?: string[];
  url?: string[];
  from?: string;
  json?: boolean;
  dryRun?: boolean;
  pane?: string;
  socket?: string;
  enter?: boolean;
  combined?: boolean;
}

function mergeAttachments(opts: SendCliOpts): string[] | undefined {
  const list = [...(opts.attach ?? []), ...(opts.attachment ?? [])];
  return list.length ? list : undefined;
}

function terminalOptions(opts: SendCliOpts): TerminalSendOptions | undefined {
  const { pane, socket, enter, combined } = opts;
  if (pane === undefined && socket === undefined && enter !== false && !combined) return undefined;
  return { pane, socket, enter, combined };
}

function toInput(
  positionalText: string | undefined,
  opts: SendCliOpts,
): ResolveSendInput {
  return {
    text: opts.text,
    positionalText,
    to: opts.to,
    channel: opts.channel,
    thread: opts.thread,
    attachments: mergeAttachments(opts),
    urls: opts.url,
    from: opts.from,
    dryRun: opts.dryRun,
    terminal: terminalOptions(opts),
  };
}

async function runSend(
  positionalText: string | undefined,
  opts: SendCliOpts,
): Promise<void> {
  const meta = readMeta();
  const input = toInput(positionalText, opts);
  if (isOwnerAlias(opts.to)) fireTraceSyncInBackground({ disabled: Boolean(opts.dryRun) });

  const out = await sendMessage(input, meta);
  if ('error' in out) {
    die(out.error);
  }
  const { result, envelope } = out;

  if (opts.json) {
    console.log(
      JSON.stringify({
        ...result,
        text: envelope.text,
        dryRun: Boolean(envelope.dryRun),
      }),
    );
    if (!result.ok) process.exit(1);
    return;
  }
  if (!result.ok) {
    die(`send failed [${result.channel} → ${result.id}]: ${result.error ?? 'unknown error'}`);
  }
  const suffix = result.msgId ? chalk.dim(` (${result.msgId})`) : '';
  const dry = envelope.dryRun ? chalk.dim(' [dry-run]') : '';
  console.log(chalk.green(`Sent via ${result.channel} → ${result.id}`) + suffix + dry);
  if (result.error) console.error(chalk.yellow(`Partial delivery failure: ${result.error}`));
}

const SHARED_NOTES = `
  Planes (do not mix them up):
    send              - DELIVER a message to a recipient (this command)
    feed post         - RECORD progress / milestones (optional broadcast may call send)
    activity          - READ the activity stream (not a send path)
    message           - CONTROL a running agent through its mailbox
    send --channel session - type text + Enter into a running agent's terminal

  --to owner posts one notification to your account (agents auth login). The
  account's preferences, edited in the console Settings page, decide which of
  email, Slack and iMessage it reaches; quiet hours and dedup apply there. A box
  with no Phoenix session or worker device token fails loud instead. --to owner
  takes no --channel, --thread or --attach.

  --channel session resolves --to (a session id or unique prefix, the
  <shortid> of an ag-<agent>-<shortid> tmux name, or a %pane id) among the
  live sessions on this machine; add --device <name> for a session on
  another box. --attach, --thread and --from are refused on this channel.
  --device runs the whole send on that box, for every channel, not just session.

  The session channel types the text exactly as given: surrounding spaces and
  newlines are kept, and --text "" presses Enter alone. By default the text
  and Enter are two writes (what Ink TUIs such as Claude need); --combined
  fuses them, --no-enter types without submitting. --pane (with an optional
  --socket) addresses a tmux pane directly, without session lookup, and
  replaces --to. These four options are refused on every other channel.
`;

export function registerSendCommand(program: Command): void {
  const sendCmd = program
    .command('send [text]')
    .description(
      'Deliver a message through a channel provider (imessage, slack, desktop, mailbox, session, …). Prefer --text/--to flags.',
    )
    .option('--text <text>', 'message body (preferred over positional text)')
    .option('--to <target>', 'recipient id, or "owner" for your account\'s notification preferences')
    .option('--channel <name>', 'channel / provider (required unless --to owner)')
    .option('--thread <id>', 'channel thread id / timestamp')
    .option('--attach <path...>', 'local file attachment path (repeatable)')
    .option('--attachment <path...>', 'alias of --attach')
    .option('--url <url...>', 'link or remote media URL to include in the body (repeatable)')
    .option('--from <who>', 'sender label (mailbox)')
    .option('--pane <id>', 'session channel: tmux pane id to type into directly (e.g. %3), instead of --to')
    .option('--socket <path>', 'session channel: tmux socket the --pane lives on')
    .option('--no-enter', 'session channel: type the text without pressing Enter')
    .option('--combined', 'session channel: send text + Enter as one write')
    .option('--json', 'output JSON')
    .option('--dry-run', 'resolve + build but do not send');

  setHelpSections(sendCmd, {
    examples: `
      # Flag-first envelope (preferred)
      agents send --channel imessage --to "+18055550100" --text "PR #1803 is green"
      agents send --to owner --text "need a decision on the release"
      agents send --channel desktop --to local --text "deploy finished" --url https://example.com/pr/1
      agents send --channel mailbox --to <session-id> --text "peer note" --from orchestrator

      # Type into a running agent's terminal (find ids with: agents ps)
      agents send --channel session --to 4b2f1a9c --text "continue"
      agents send --channel session --to 4b2f1a9c --text "continue" --device yosemite-s0

      # Type into a known tmux pane, without pressing Enter
      agents send --channel session --pane %3 --socket /tmp/agents/tmux.sock --text "draft" --no-enter

      # Attach a local file (explicit channels only)
      agents send --channel slack --to "#eng" --text "screenshot" --attach ./out/cover.png

      # Legacy positional text still works
      agents send "hi" --channel desktop --to local

      # Dry-run (resolve provider, no delivery)
      agents send --to owner --text "probe" --dry-run --json
    `,
    notes: SHARED_NOTES,
  });

  sendCmd.action(async (text: string | undefined, opts: SendCliOpts) => {
    await runSend(text, opts);
  });
}
