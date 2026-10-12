
import type { Command } from 'commander';
import chalk from 'chalk';
import { DEFAULT_CF_BUNDLE, readCloudflareCreds } from '../lib/cloudflare/creds.js';
import { PHOENIX_ID_BASE } from '../lib/identity/client.js';
import { provisionSessions } from '../lib/session/sync/provision.js';
import {
  DEFAULT_SESSIONS_BUCKET_NAME,
  DEFAULT_SESSIONS_DOMAIN,
  DEFAULT_SESSIONS_WORKER_NAME,
} from '@phnx-labs/sessions-cli/backup';
import { setHelpSections } from '../lib/help.js';

interface BackupSetupOptions {
  bundle: string;
  worker: string;
  bucket: string;
  account?: string;
  token?: string;
  domain: string;
}

export async function handleSessionBackupSetup(opts: BackupSetupOptions): Promise<void> {
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
  console.log(chalk.dim('Signed-in users now back up with `sessions export --to-r2` — no r2.backups bucket.'));
}

const BACKUP_SETUP_EXAMPLES = `
  $ secrets exec cloudflare -- agents setup session-backup
  Provision the managed session-backup Worker + R2 bucket (creds from the bundle).

  $ agents setup session-backup --account <id> --domain sessions.example.com
  Provision against a private account service and custom domain.
`.trimStart();

export function registerSetupSessionBackupCommand(setupCmd: Command): void {
  const cmd = setupCmd
    .command('session-backup')
    .description('(operator) Provision the managed session-backup Worker + R2 bucket — NOT a per-user step; signing in with `agents auth login` backs sessions up with zero setup')
    .option('--bundle <name>', 'secrets bundle holding the Cloudflare API token', DEFAULT_CF_BUNDLE)
    .option('--worker <name>', 'Worker name', DEFAULT_SESSIONS_WORKER_NAME)
    .option('--bucket <name>', 'R2 bucket name', DEFAULT_SESSIONS_BUCKET_NAME)
    .option('--account <id>', 'Cloudflare account id (else read from the bundle / prompt)')
    .option('--token <token>', 'Cloudflare API token (else read from the --bundle)')
    .option('--domain <host>', 'custom domain to map', DEFAULT_SESSIONS_DOMAIN)
    .action(async (opts: BackupSetupOptions) => {
      try {
        await handleSessionBackupSetup(opts);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exitCode = 1;
      }
    });

  setHelpSections(cmd, { examples: BACKUP_SETUP_EXAMPLES });
}
