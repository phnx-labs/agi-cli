/**
 * `agents sessions share <id>` — publish one session transcript as a link.
 *
 * Renders the session locally — `renderSessionMarkdownDocument()` (redacted
 * transcript) and `renderSessionHtmlDocument()` (self-contained branded page) —
 * then publishes it through the standalone `artifacts` CLI (`artifacts share`),
 * the single home for artifact sharing since PHNX-3992. agents-cli holds no
 * share engine of its own; this command contributes the session-specific
 * rendering and redaction, and forwards the finished page to `artifacts share`.
 *
 * Unlisted by default, unlike `artifacts share` (public by default). A transcript
 * carries file paths, command output, error text, and whatever a tool printed —
 * strictly more than a plan does — so it does not belong in the public `/<user>`
 * gallery unless the operator asks for it with `--public`. The URL itself stays
 * world-readable: unlisted is a capability URL, not a secret.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';
import { knownSecretValuesFromEnv, redactEmails } from '../lib/redact.js';
import { discoverSessions } from '../lib/session/discover.js';
import { renderSessionHtmlDocument } from '../lib/session/share-html.js';
import type { SessionMeta } from '../lib/session/types.js';
import { resolveArtifactsBin, invocation, ArtifactsClientError } from '../lib/artifacts-client.js';
import { renderSessionMarkdownDocument, type ReasoningMode } from './sessions-render.js';
import { selectSessions } from './sessions-export.js';
import { parseAgentFilter } from './sessions.js';

interface ShareGlobals {
  all?: boolean;
  since?: string;
  limit?: string;
  agent?: string;
  redact?: boolean;
  json?: boolean;
}

interface ShareOptions {
  public?: boolean;
  slug?: string;
  label?: string;
  expire?: string;
  reasoning: string;
  force?: boolean;
  cover?: boolean;
}

/** The shape `artifacts share --json` prints (`formatSharePublishResult`). */
interface ArtifactsShareResult {
  url: string;
  slug?: string;
  label?: string;
  coverUrl?: string;
  expiresAt?: string | null;
  visibility?: string;
  unlisted?: boolean;
}

function parseReasoning(value: string): ReasoningMode {
  if (value === 'omit' || value === 'fold' || value === 'include') return value;
  throw new Error(`Unknown reasoning mode "${value}". Expected omit, fold, or include.`);
}

/** `session-<shortId>` — stable per session, so re-sharing updates the same URL. */
export function defaultSessionSlug(session: SessionMeta): string {
  return `session-${session.shortId || session.id}`;
}

/**
 * Build the `artifacts share` argv for a session publish.
 *
 * Extracted so the mapping is testable directly. The security-relevant default
 * is `--visibility unlisted` — it inverts `artifacts share`'s public default, and
 * a test that re-implements this mapping would still pass with it flipped.
 */
export function buildArtifactsShareArgs(
  session: SessionMeta,
  options: Pick<ShareOptions, 'public' | 'slug' | 'label' | 'expire' | 'force' | 'cover'>,
  file: string,
): string[] {
  const args = [
    'share',
    file,
    '--slug',
    options.slug ?? defaultSessionSlug(session),
    '--visibility',
    options.public === true ? 'public' : 'unlisted',
    '--meta',
    'kind=session',
    '--json',
  ];
  if (options.expire) args.push('--expire', options.expire);
  if (options.force === true) args.push('--force');
  if (options.cover === false) args.push('--no-cover');
  if (options.label) args.push('--label', options.label);
  return args;
}

export function registerSessionsShareCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('share <session>')
    .description('Publish one session as a redacted, self-contained web page and print the link.')
    .option('--public', 'List the page in your public share gallery (default: unlisted capability URL)')
    .option('--slug <slug>', 'URL slug under your namespace (default: session-<shortId>)')
    .option('--label <text>', 'Display title in the gallery and `artifacts share list`')
    .option('--expire <spec>', 'Auto-expire window: 30d, 12h, a date, or never (default: 30d)')
    .option('--reasoning <mode>', 'Reasoning visibility: omit, fold, or include', 'omit')
    .option('--force', 'Publish despite the sensitive-content scan flagging the transcript')
    .option('--no-cover', 'Skip generating the Open Graph preview image');

  setHelpSections(cmd, {
    examples: `# Share a session — prints an unlisted, redacted link
agents sessions share a1b2c3d4

# Put it in your public gallery at share.getrush.ai/<you>
agents sessions share a1b2c3d4 --public --label "How the retry bug got fixed"

# Keep the model's reasoning in collapsible sections
agents sessions share a1b2c3d4 --reasoning fold

# A link that does not decay
agents sessions share a1b2c3d4 --expire never`,
    notes: `Publishes through the standalone artifacts CLI — install it with
'npm i -g @phnx-labs/artifacts-cli'. Sign in with
'artifacts auth login' for the managed endpoint (zero Cloudflare setup), or configure
your own bucket with 'artifacts share setup' / 'artifacts share join <baseUrl>'.

Unlisted by default — the URL is world-readable but the page stays out of your public
gallery and out of 'artifacts share list'. Pass --public to list it.

Secrets are redacted and 'artifacts share' runs its own pre-publish scan on the page,
so a transcript carrying emails or credential-shaped strings is refused unless you pass
--force. --no-redact (the sessions-level flag) disables redaction and is a bad idea for
anything you publish.

Re-running with the same session updates the same URL and keeps the prior version
as a revision ('artifacts share revisions <slug>').

Manage published sessions with 'artifacts share list' and 'artifacts share delete <slug>'.`,
  });

  cmd.action(async (selector: string, options: ShareOptions, command: Command) => {
    const globals = command.optsWithGlobals() as ShareGlobals;
    const reasoning = parseReasoning(options.reasoning);
    const limit = Math.max(1, Number.parseInt(globals.limit || '100', 10) || 100);
    const agent = parseAgentFilter(globals.agent).agent;
    const sessions = selectSessions(await discoverSessions({
      all: globals.all !== false,
      since: globals.since,
      limit,
      agent: agent ?? undefined,
    }), [selector]);

    if (sessions.length === 0) {
      process.stderr.write(chalk.yellow(`No session matched "${selector}".\n`));
      process.exitCode = 1;
      return;
    }
    // One link per share: several sessions in one page would give the reader no
    // way to reference just the one that matters, and the slug could only name one.
    if (sessions.length > 1) {
      process.stderr.write(chalk.yellow(
        `"${selector}" matched ${sessions.length} sessions. Share one at a time — pass a full or unique session id.\n`,
      ));
      process.exitCode = 1;
      return;
    }

    const session = sessions[0];
    const redact = globals.redact !== false;
    const markdown = renderSessionMarkdownDocument(session, {
      redact,
      reasoning,
      knownSecrets: redact ? knownSecretValuesFromEnv() : undefined,
    });
    // Emails on top of what the renderer masks. Almost every real transcript
    // carries a few — git author addresses, `gh api user`, a pasted log — and
    // `artifacts share` refuses a body containing any (its own scan). Masking
    // them means the published page genuinely does not carry them; the
    // alternative, telling people to pass --force, trains everyone to bypass the
    // gate that also catches real credentials.
    //
    // Applied to the RENDERED PAGE, not the Markdown, so the text that is masked
    // is exactly the text the publish scan will see. Markdown escaping stands
    // between the two: `foo\@example.com` hides from the pattern in the Markdown
    // and reappears as a live address once marked drops the backslash.
    const page = renderSessionHtmlDocument(session, markdown, { redacted: redact });
    const html = redact ? redactEmails(page) : page;

    // A real file on disk is what `artifacts share` takes, and its OG capturer
    // opens it in a browser. 0600 + a per-run directory keeps the intermediate
    // off a world-readable /tmp path while it exists.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-session-share-'));
    const file = path.join(dir, `${defaultSessionSlug(session)}.html`);
    try {
      fs.writeFileSync(file, html, { mode: 0o600 });

      let bin: string;
      try {
        bin = resolveArtifactsBin();
      } catch (err) {
        if (err instanceof ArtifactsClientError) {
          process.stderr.write(chalk.red(err.message + '\n'));
          process.exitCode = 1;
          return;
        }
        throw err;
      }

      const { command: execCommand, prefix } = invocation(bin);
      const args = [...prefix, ...buildArtifactsShareArgs(session, options, file)];
      const proc = spawnSync(execCommand, args, { encoding: 'utf-8' });
      if (proc.error) throw proc.error;
      if (proc.status !== 0) {
        process.stderr.write(proc.stderr || chalk.red(`artifacts share exited ${proc.status ?? 'with no status'}\n`));
        process.exitCode = proc.status ?? 1;
        return;
      }

      let result: ArtifactsShareResult;
      try {
        result = JSON.parse(proc.stdout) as ArtifactsShareResult;
      } catch {
        // A 0 exit with non-JSON stdout (a version-skewed `artifacts` that
        // printed a banner before the JSON, or one predating `--json` here) must
        // fail loud with the bytes it actually returned, not an uncaught parse
        // stack trace — mirroring `secrets-client.ts`'s `parseResponse`.
        const preview = proc.stdout.trim().slice(0, 200);
        process.stderr.write(chalk.red(
          `artifacts share returned a non-JSON response${preview ? `: ${preview}` : ' (empty output)'}\n`,
        ));
        process.exitCode = 1;
        return;
      }
      if (globals.json) {
        process.stdout.write(JSON.stringify({
          session: session.id,
          agent: session.agent,
          redacted: redact,
          ...result,
        }, null, 2) + '\n');
        return;
      }
      process.stdout.write(`${result.url}\n`);
      const visibility = result.visibility ?? (result.unlisted ? 'unlisted' : options.public ? 'public' : 'unlisted');
      const bits = [visibility, redact ? 'redacted' : chalk.red('NOT redacted')];
      if (result.expiresAt) bits.push(`expires ${String(result.expiresAt).slice(0, 10)}`);
      process.stderr.write(chalk.dim(`${bits.join(' · ')}\n`));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
