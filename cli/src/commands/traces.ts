import chalk from 'chalk';
import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';
import { readSyncLedger, syncTraces, type SyncFailure } from '../lib/traces/sync.js';
import { managedTracesBaseUrl, resolveTracesBackend } from '../lib/traces/backend.js';
import { showUrl } from '../lib/open-url.js';
import { DEFAULT_CF_BUNDLE, readCloudflareCreds } from '../lib/cloudflare/creds.js';
import { PHOENIX_ID_BASE } from '../lib/identity/client.js';
import { DEFAULT_BUCKET_NAME, DEFAULT_WORKER_NAME } from '../lib/traces/config.js';
import { DEFAULT_TRACES_DOMAIN } from '../lib/traces/backend.js';
import { provisionTraces } from '../lib/traces/provision.js';

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const SYNC_EXAMPLES = `
  $ agents traces sync
  Push this device's derived, redacted trajectories to your Phoenix account.

  $ agents traces sync --limit 20
  Sync at most 20 sessions (useful for a first run on a large fleet device).

  $ agents traces sync --dry-run --out ./trace-preview
  Compute the shards from your real sessions.db and WRITE them locally — no
  Phoenix sign-in, no worker, no upload. Point a console at ./trace-preview to
  see your real trajectories before wiring the hosted path.
`.trimStart();

const SYNC_NOTES = `
  Reads from the local sessions.db, computes a derived SessionTrajectory (steps +
  gaps + stats, no raw transcript text), redacts secrets, and PUTs each to
  the agents-traces store.

  An incremental gate (traces-sync.json ledger) means re-runs only upload
  sessions whose file_mtime_ms changed since the last sync.

  On a real (non-dry-run) sync with the managed Phoenix backend, also
  fire-and-forget registers this session with Prix (api.prix.dev) so the
  console can serve live trajectories — a link failure never blocks sync.

  Sign in first with: agents auth login
`.trimStart();

const STATUS_EXAMPLES = `
  $ agents traces status
  Show what's been synced — session count and last sync time for this device.
`.trimStart();

const OPEN_EXAMPLES = `
  $ agents traces open
  Open the Phoenix Evals console for your account.
`.trimStart();

const SETUP_EXAMPLES = `
  $ agents traces setup
  Provision the private agents-traces Worker, R2 bucket, and managed domain.

  $ agents traces setup --account <id> --token <token>
  Provision non-interactively with explicit Cloudflare credentials.
`.trimStart();

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleSync(opts: { limit?: string; dryRun?: boolean; out?: string }): Promise<void> {
  const limit = opts.limit !== undefined ? parseInt(opts.limit, 10) : undefined;
  const dryRun = opts.dryRun === true;

  if (dryRun && !opts.out) {
    console.error(chalk.red('traces sync --dry-run requires --out <dir>'));
    process.exitCode = 1;
    return;
  }

  // A dry-run computes locally and needs no Phoenix backend; a real sync does.
  if (!dryRun) {
    try {
      resolveTracesBackend();
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
      return;
    }
  }

  console.log(chalk.dim(dryRun ? `Computing traces locally → ${opts.out}` : 'Syncing traces…'));

  let result;
  try {
    result = await syncTraces({ limit, dryRun, outDir: opts.out });
  } catch (err) {
    console.error(chalk.red(`Sync failed: ${(err as Error).message}`));
    process.exitCode = 1;
    return;
  }

  const parts: string[] = [];
  if (result.uploaded > 0) {
    parts.push(chalk.green(`${result.uploaded} ${dryRun ? 'written' : 'uploaded'}`));
  }
  if (result.skipped > 0) {
    parts.push(chalk.dim(`${result.skipped} skipped`));
  }
  if (result.errors > 0) {
    // Distinguish expected history (transcripts cleaned off disk) from genuine
    // failures that will be retried, so the operator knows which need attention.
    const detail: string[] = [];
    if (result.transcriptUnavailable > 0) {
      detail.push(`${result.transcriptUnavailable} transcripts no longer on disk`);
    }
    const retryable = result.parseFailed + result.uploadFailed;
    if (retryable > 0) {
      detail.push(`${retryable} parse/upload failures — will retry`);
    }
    parts.push(
      chalk.yellow(`${result.errors} errors`) +
        (detail.length ? chalk.dim(` (${detail.join(' · ')})`) : ''),
    );
  }
  if (parts.length === 0) {
    parts.push(chalk.dim('nothing new'));
  }

  console.log(parts.join(chalk.dim('  ·  ')));

  // The per-session data can upload cleanly while the aggregated console shard
  // fails to refresh (e.g. the sessions DB is locked by a running app). That used
  // to be silent, so the console sat stale with no signal here (PHNX-3401).
  if (result.indexError) {
    console.log(
      chalk.yellow('  ⚠ console index not refreshed') +
        chalk.dim(` (${result.indexError}) — dashboard may be stale; it will retry next sync`),
    );
  }
}

async function handleStatus(): Promise<void> {
  const ledger = readSyncLedger();

  if (!ledger.lastSyncMtime) {
    console.log(chalk.dim('No sync recorded on this device. Run: agents traces sync'));
    return;
  }

  const when = new Date(ledger.lastSyncMtime).toLocaleString();
  console.log(`Last sync: ${chalk.bold(when)}`);

  const failures = ledger.failures ?? [];
  if (failures.length > 0) {
    const byKind = new Map<string, SyncFailure[]>();
    for (const f of failures) {
      const list = byKind.get(f.kind) ?? [];
      list.push(f);
      byKind.set(f.kind, list);
    }
    console.log(chalk.yellow(`\n${failures.length} unresolved failure${failures.length === 1 ? '' : 's'}:`));
    for (const [kind, list] of byKind) {
      const retry = kind === 'transcript-unavailable' ? chalk.dim(' (not retried)') : chalk.dim(' (retried each sync)');
      console.log(`  ${chalk.bold(list.length)} ${kind}${retry}`);
      const example = list[0];
      if (example?.detail) {
        console.log(chalk.dim(`    e.g. ${example.id.slice(0, 8)} · ${example.detail}`));
      }
    }
  }

  console.log(chalk.dim('\nRun `agents traces sync` to push new sessions.'));
}

async function handleOpen(): Promise<void> {
  // M2 console — for now open the base URL which will route to the console once deployed.
  const url = managedTracesBaseUrl();
  console.log(chalk.dim(`Opening ${url}`));
  const outcome = await showUrl(url);
  if (outcome.via === 'none') {
    console.log(url);
  }
}

interface SetupOptions {
  bundle: string;
  worker: string;
  bucket: string;
  account?: string;
  token?: string;
  domain: string;
}

async function handleSetup(opts: SetupOptions): Promise<void> {
  const { input } = await import('@inquirer/prompts');
  const { apiToken, accountId: bundledAccountId } = readCloudflareCreds(opts.bundle, {
    apiToken: opts.token,
    accountId: opts.account,
  });
  const accountId = opts.account ?? bundledAccountId ?? await input({ message: 'Cloudflare account id' });
  if (!accountId) throw new Error('A Cloudflare account id is required.');

  const result = await provisionTraces({
    apiToken,
    accountId,
    workerName: opts.worker,
    bucketName: opts.bucket,
    domain: opts.domain,
    phoenixIdBase: PHOENIX_ID_BASE,
  });
  console.log(chalk.green(`Traces endpoint ready → ${chalk.bold(result.baseUrl)}`));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTracesCommands(program: Command): void {
  const tracesCmd = program
    .command('traces')
    .description("Sync this device's derived, redacted trajectories to your Phoenix account");

  const setupCmd = tracesCmd
    .command('setup')
    .description('(advanced) Provision a self-hosted Cloudflare Worker + R2 bucket for traces — NOT required; `agents auth login` syncs to the managed endpoint with zero setup')
    .option('--bundle <name>', 'secrets bundle holding the Cloudflare API token', DEFAULT_CF_BUNDLE)
    .option('--worker <name>', 'Worker name', DEFAULT_WORKER_NAME)
    .option('--bucket <name>', 'R2 bucket name', DEFAULT_BUCKET_NAME)
    .option('--account <id>', 'Cloudflare account id (else read from the bundle / prompt)')
    .option('--token <token>', 'Cloudflare API token (else read from the --bundle)')
    .option('--domain <host>', 'custom domain to map', DEFAULT_TRACES_DOMAIN)
    .action(async (opts: SetupOptions) => {
      try {
        await handleSetup(opts);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exitCode = 1;
      }
    });

  setHelpSections(setupCmd, { examples: SETUP_EXAMPLES });

  // sync
  const syncCmd = tracesCmd
    .command('sync')
    .description('Push derived, redacted trajectories (incremental)')
    .option('--limit <n>', 'Maximum number of sessions to sync in this run')
    .option('--dry-run', 'Compute the shards from real sessions.db and WRITE them locally (no auth, no upload)')
    .option('--out <dir>', 'Directory to write index.json + sessions/<id>.json (required with --dry-run)')
    .action(handleSync);

  setHelpSections(syncCmd, { examples: SYNC_EXAMPLES, notes: SYNC_NOTES });

  // status
  const statusCmd = tracesCmd
    .command('status')
    .description('Show last sync time for this device')
    .action(handleStatus);

  setHelpSections(statusCmd, { examples: STATUS_EXAMPLES });

  // open
  const openCmd = tracesCmd
    .command('open')
    .description('Open the Phoenix Evals console')
    .action(handleOpen);

  setHelpSections(openCmd, { examples: OPEN_EXAMPLES });
}
