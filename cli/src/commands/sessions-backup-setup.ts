// `agents sessions backup-setup` — the OPERATOR command that provisions the
// managed session-backup endpoint (`sessions.agents-cli.sh`): the Cloudflare
// Worker + R2 bucket a signed-in user's `sessions export --to-r2` talks to with
// NO `r2.backups` bucket of their own. It is the deploy producer for that
// endpoint — first-party infrastructure, not a per-user step. The zero-knowledge
// `--byo` backup path uses the user's own R2 bucket directly and never touches
// this Worker, so there is nothing here for an ordinary user to run.
//
// Mirrors `agents traces setup`: the same `readCloudflareCreds` bundle plumbing,
// the same idempotent `deployWorker`/`createBucket` primitives. Provisioning is
// idempotent — re-running redeploys the current Worker template in place.

import type { Command } from 'commander';
import chalk from 'chalk';
import { DEFAULT_CF_BUNDLE, readCloudflareCreds } from '../lib/share/config.js';
import { PHOENIX_ID_BASE } from '../lib/identity/client.js';
import { provisionSessions } from '../lib/session/sync/provision.js';
import {
  DEFAULT_SESSIONS_BUCKET_NAME,
  DEFAULT_SESSIONS_DOMAIN,
  DEFAULT_SESSIONS_WORKER_NAME,
} from '../lib/session/sync/managed-config.js';
import { setHelpSections } from '../lib/help.js';

interface BackupSetupOptions {
  bundle: string;
  worker: string;
  bucket: string;
  account?: string;
  token?: string;
  domain: string;
}

export async function handleSessionsBackupSetup(opts: BackupSetupOptions): Promise<void> {
  const { input } = await import('@inquirer/prompts');
  const { apiToken, accountId: bundledAccountId } = readCloudflareCreds(opts.bundle, {
    apiToken: opts.token,
    accountId: opts.account,
  });
  const accountId = opts.account ?? bundledAccountId ?? await input({ message: 'Cloudflare account id' });
  if (!accountId) throw new Error('A Cloudflare account id is required.');

  const result = await provisionSessions({
    apiToken,
    accountId,
    workerName: opts.worker,
    bucketName: opts.bucket,
    domain: opts.domain,
    phoenixIdBase: PHOENIX_ID_BASE,
  });
  console.log(chalk.green(`Managed session-backup endpoint ready → ${chalk.bold(result.baseUrl)}`));
  console.log(chalk.dim('Signed-in users now back up with `agents sessions export --to-r2` — no r2.backups bucket.'));
}

const BACKUP_SETUP_EXAMPLES = `
  $ agents secrets exec cloudflare -- agents sessions backup-setup
  Provision the managed session-backup Worker + R2 bucket (creds from the bundle).

  $ agents sessions backup-setup --account <id> --domain sessions.example.com
  Provision against a private account service and custom domain.
`.trimStart();

export function registerSessionsBackupSetupCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('backup-setup')
    .description('(operator) Provision the managed session-backup Worker + R2 bucket — NOT a per-user step; signing in with `agents auth login` backs sessions up with zero setup')
    .option('--bundle <name>', 'secrets bundle holding the Cloudflare API token', DEFAULT_CF_BUNDLE)
    .option('--worker <name>', 'Worker name', DEFAULT_SESSIONS_WORKER_NAME)
    .option('--bucket <name>', 'R2 bucket name', DEFAULT_SESSIONS_BUCKET_NAME)
    .option('--account <id>', 'Cloudflare account id (else read from the bundle / prompt)')
    .option('--token <token>', 'Cloudflare API token (else read from the --bundle)')
    .option('--domain <host>', 'custom domain to map', DEFAULT_SESSIONS_DOMAIN)
    .action(async (opts: BackupSetupOptions) => {
      try {
        await handleSessionsBackupSetup(opts);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exitCode = 1;
      }
    });

  setHelpSections(cmd, { examples: BACKUP_SETUP_EXAMPLES });
}
