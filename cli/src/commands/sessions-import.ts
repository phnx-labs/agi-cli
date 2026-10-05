import * as fs from 'fs';
import chalk from 'chalk';
import type { Command } from 'commander';
import { isSyncConfigured, loadR2Config } from '../lib/session/sync/config.js';
import { isTranscriptEnvelope, resolveSyncEncKey } from '../lib/session/sync/transcript-crypto.js';
import { R2Client } from '../lib/session/sync/r2.js';
import { SESSIONS_PREFIX } from '../lib/session/sync/agents.js';
import { resolveSessionsBackend } from '../lib/session/sync/backend.js';
import { SessionsHttpClient, type SessionsBackupClient } from '../lib/session/sync/net-client.js';
import { resolveManagedBackupKey } from '../lib/session/sync/managed-key.js';
import {
  parseBundle,
  planImport,
  writeImport,
  mergeRecords,
  makeHeader,
  type BundleRecord,
  type ImportPlanItem,
  type ParsedBundle,
} from '../lib/session/bundle.js';
import { pullBundlesFromHosts } from '../lib/session/remote-bundle.js';
import { setHelpSections } from '../lib/help.js';

interface ImportOptions {
  dryRun?: boolean;
  overwrite?: boolean;
  decrypt?: string | boolean;
  fromHost?: string[];
  fromR2?: boolean;
  byo?: boolean;
  agent?: string;
}

export function registerSessionsImportCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('import [bundle]')
    .description('Restore an export bundle (file, - for stdin, or --from-host <h>) into the local session store, deduping against what you already have.')
    .option('--dry-run', 'Show what would be placed without writing anything')
    .option('--overwrite', 'Replace local files that differ from the bundle (default: keep local)')
    .option('--decrypt [key]', 'Decrypt an encrypted bundle (key optional if the r2.backups sync key is configured)')
    .option('--from-host <target...>', 'Pull sessions live from remote peer(s) over SSH instead of a file (repeatable)')
    .option('--from-r2', 'Restore session backups from the off-box store (managed Phoenix store when signed in; your own r2.backups bucket with --byo)')
    .option('--byo', 'With --from-r2: restore from your own r2.backups bucket instead of the managed Phoenix store');

  setHelpSections(cmd, {
    examples: `# Preview what a bundle would restore
agents sessions import week.bundle --dry-run

# Restore it
agents sessions import week.bundle

# Pull straight off another machine (one command, over SSH)
agents sessions import --from-host yosemite-s1 --since 7d

# Or the equivalent raw pipe
agents ssh boxB 'agents sessions export --since 7d --stdout' | agents sessions import -

# Restore everything backed up to R2 (e.g. on a fresh box)
agents sessions import --from-r2`,
    notes: `Sessions land under the cross-machine mirror keyed by their origin machine, so
they show up in 'agents sessions' tagged with that machine and never overwrite
your own local sessions. Byte-exact duplicates are skipped. --from-host reuses
the same SSH transport as the cross-machine listing (no R2, no daemon).

--from-r2 downloads every session backup from the off-box store and restores it
through the same placement. When signed in it restores from the MANAGED Phoenix
store and decrypts with your per-account key (recovered automatically, even on a
fresh box); --byo restores from your own r2.backups bucket with its shared
R2_SYNC_ENC_KEY (or pass --decrypt <key>). It is the inverse of
'sessions export --to-r2'.`,
  });

  cmd.action(async (bundlePath: string | undefined, options: ImportOptions, command: Command) => {
    const g = command.optsWithGlobals() as { agent?: string; since?: string; all?: boolean; limit?: string };
    await runImport(bundlePath, { ...options, agent: g.agent }, g, command);
  });
}

async function runImport(
  bundlePath: string | undefined,
  options: ImportOptions,
  g: { since?: string; all?: boolean; limit?: string },
  command: Command,
): Promise<void> {
  let bundle: ParsedBundle;
  let managedDecryptKey: Buffer | undefined;
  if (options.byo && !options.fromR2) {
    process.stderr.write(chalk.red('--byo is only valid with --from-r2.\n'));
    process.exit(1);
  }
  if (options.fromR2) {
    let client: SessionsBackupClient;
    let managedClient: SessionsHttpClient | undefined;
    let managedUserId: string | undefined;
    try {
      const backend = resolveSessionsBackend({ byo: options.byo });
      if (backend.kind === 'managed') {
        managedClient = new SessionsHttpClient({ baseUrl: backend.baseUrl, userId: backend.userId, token: backend.token });
        client = managedClient;
        managedUserId = backend.userId;
      } else {
        const gateErr = r2ImportGateError(true, isSyncConfigured());
        if (gateErr) throw new Error(gateErr);
        client = new R2Client(backend.r2);
      }
    } catch (err) {
      process.stderr.write(chalk.red(`R2 restore: ${(err as Error).message}\n`));
      process.exit(1);
    }
    bundle = await pullFromR2(client);
    if (managedUserId) {
      managedDecryptKey = await resolveManagedBackupKey(managedClient!, managedUserId);
    }
  } else if (options.fromHost && options.fromHost.length > 0) {
    bundle = await pullForImport(options.fromHost, bundlePath, g, command);
  } else {
    if (!bundlePath) {
      process.stderr.write(chalk.red('Provide a bundle path, - for stdin, or --from-host <host>.\n'));
      process.exit(1);
    }
    let text: string;
    try {
      text = bundlePath === '-' ? await readStdin() : fs.readFileSync(bundlePath, 'utf-8');
    } catch (err) {
      process.stderr.write(chalk.red(`Cannot read bundle: ${(err as Error).message}\n`));
      process.exit(1);
    }
    try {
      bundle = parseBundle(text);
    } catch (err) {
      process.stderr.write(chalk.red(`${(err as Error).message}\n`));
      process.exit(1);
    }
  }

  if (options.agent) {
    bundle = { header: bundle.header, records: bundle.records.filter(r => r.agent === options.agent) };
    if (bundle.records.length === 0) {
      process.stderr.write(chalk.yellow(`No records for agent '${options.agent}' in this bundle.\n`));
      process.exit(1);
    }
  }

  const decryptKey = bundle.header.encrypted
    ? (managedDecryptKey ?? resolveDecryptKey(options.decrypt))
    : null;

  let plan: ImportPlanItem[];
  try {
    plan = planImport(bundle, { decryptKey });
  } catch (err) {
    process.stderr.write(chalk.red(`${(err as Error).message}\n`));
    process.exit(1);
  }

  if (options.dryRun) {
    printDryRun(plan, bundle);
    return;
  }

  const res = writeImport(plan, { overwrite: options.overwrite === true, decryptKey });
  const parts: string[] = [];
  if (res.placed) parts.push(`${res.placed} placed`);
  if (res.overwritten) parts.push(`${res.overwritten} overwritten`);
  if (res.skipped) parts.push(`${res.skipped} duplicate${res.skipped === 1 ? '' : 's'} skipped`);
  if (res.conflicts) parts.push(chalk.yellow(`${res.conflicts} conflict${res.conflicts === 1 ? '' : 's'} kept local (use --overwrite)`));
  if (res.unknown) parts.push(chalk.yellow(`${res.unknown} unknown-agent skipped`));
  process.stderr.write(chalk.green(`Imported: ${parts.join(', ') || 'nothing to do'}.\n`));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

async function pullForImport(
  hosts: string[],
  selector: string | undefined,
  g: { since?: string; all?: boolean; limit?: string },
  command: Command,
): Promise<ParsedBundle> {
  const args: string[] = [];
  if (selector && selector !== '-') args.push(selector);
  if (g.since) args.push('--since', g.since);
  const agent = (command.optsWithGlobals() as { agent?: string }).agent;
  if (agent) args.push('-a', agent);
  if (g.all !== false) args.push('--all');
  if (command.parent?.getOptionValueSource?.('limit') === 'cli' && g.limit) args.push('-n', String(g.limit));

  const { bundles, errors } = await pullBundlesFromHosts(hosts, args);
  for (const e of errors) process.stderr.write(chalk.yellow(`  ${e}\n`));
  const records = mergeRecords(bundles.map(b => b.records));
  if (records.length === 0) {
    process.stderr.write(chalk.red('No sessions pulled from the given host(s).\n'));
    process.exit(1);
  }
  const header = makeHeader({
    origin: hosts.join(','),
    exportedAt: new Date().toISOString(),
    encrypted: false,
    redacted: bundles.some(b => b.header.redacted),
    records,
  });
  return { header, records };
}

export function r2ImportGateError(fromR2: boolean, isConfigured: boolean): string | null {
  if (fromR2 && !isConfigured) {
    return (
      'R2 restore is not configured: the r2.backups secrets bundle is missing or locked.\n' +
      'Add it with: agents secrets add r2.backups R2_ACCOUNT_ID R2_BUCKET_NAME R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY'
    );
  }
  return null;
}

export async function pullFromR2(resolvedClient?: SessionsBackupClient): Promise<ParsedBundle> {
  let client: SessionsBackupClient;
  let bucket: string;
  if (resolvedClient) {
    client = resolvedClient;
    bucket = resolvedClient.kind === 'managed' ? 'managed' : 'byo';
  } else {
    try {
      const cfg = loadR2Config();
      bucket = cfg.bucket;
      client = new R2Client(cfg);
    } catch (err) {
      process.stderr.write(chalk.red(`R2 restore: ${(err as Error).message}\n`));
      process.exit(1);
    }
  }

  let keys: string[];
  try {
    keys = client.kind === 'managed'
      ? await client.list()
      : await client.list(SESSIONS_PREFIX);
  } catch (err) {
    process.stderr.write(chalk.red(`R2 restore: listing failed: ${(err as Error).message}\n`));
    process.exit(1);
  }

  const records: BundleRecord[] = [];
  let encryptedAny = false;
  let redactedAll = true;
  let skipped = 0;
  for (const key of keys) {
    if (key.endsWith('/manifest.json')) continue;
    let body: string | null;
    try {
      body = await client.get(key);
    } catch (err) {
      process.stderr.write(chalk.red(`R2 restore: fetching ${key} failed: ${(err as Error).message}\n`));
      process.exit(1);
    }
    if (body === null) continue;
    let parsed: ParsedBundle;
    try {
      parsed = parseBundle(body);
    } catch {
      skipped++;
      continue;
    }
    if (client.kind === 'managed') {
      const plaintext = !parsed.header.encrypted
        || parsed.records.some(rec => !rec.encrypted || !isTranscriptEnvelope(rec.body));
      if (plaintext) {
        process.stderr.write(chalk.red(
          `R2 restore: managed backup ${key} is not encrypted — managed transcripts are always sealed; refusing to import plaintext.\n`,
        ));
        process.exit(1);
      }
    }
    records.push(...parsed.records);
    if (parsed.header.encrypted) encryptedAny = true;
    if (!parsed.header.redacted) redactedAll = false;
  }

  if (skipped > 0) {
    process.stderr.write(chalk.yellow(`Skipped ${skipped} object(s) under ${SESSIONS_PREFIX} that are not session bundles.\n`));
  }
  const deduped = mergeRecords([records]);
  if (deduped.length === 0) {
    process.stderr.write(chalk.red(
      bucket === 'managed'
        ? 'No session backups found in the managed store.\n'
        : `No session backups found in R2 bucket '${bucket}'.\n`,
    ));
    process.exit(1);
  }
  const header = makeHeader({
    origin: `r2:${bucket}`,
    exportedAt: new Date().toISOString(),
    encrypted: encryptedAny,
    redacted: redactedAll,
    records: deduped,
  });
  return { header, records: deduped };
}

function resolveDecryptKey(decrypt: string | boolean | undefined): Buffer {
  if (typeof decrypt === 'string' && decrypt.trim()) {
    const raw = decrypt.trim();
    const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      process.stderr.write(chalk.red(`--decrypt key must decode to 32 bytes (got ${key.length}).\n`));
      process.exit(1);
    }
    return key;
  }
  try {
    const key = resolveSyncEncKey(loadR2Config());
    if (key) return key;
  } catch {
  }
  process.stderr.write(chalk.red(
    'This bundle is encrypted but no key is available. Pass --decrypt <key>, ' +
    'or configure the r2.backups sync bundle so its shared key is used.\n',
  ));
  process.exit(1);
}

function printDryRun(plan: ImportPlanItem[], bundle: ParsedBundle): void {
  const bySession = new Map<string, { agent: string; machine: string; sessionId: string; statuses: Set<string>; files: number }>();
  for (const item of plan) {
    const key = `${item.record.agent}:${item.record.machine}:${item.record.sessionId}`;
    let row = bySession.get(key);
    if (!row) bySession.set(key, (row = { agent: item.record.agent, machine: item.record.machine, sessionId: item.record.sessionId, statuses: new Set(), files: 0 }));
    row.statuses.add(item.status);
    row.files++;
  }

  process.stdout.write(chalk.bold(`Bundle: ${bundle.header.sessions} session(s), ${bundle.header.count} file(s), origin ${bundle.header.origin}${bundle.header.encrypted ? ', encrypted' : ''}\n\n`));
  const header = `${pad('SESSION', 22)}${pad('AGENT', 10)}${pad('ORIGIN', 16)}${pad('FILES', 7)}STATUS`;
  process.stdout.write(chalk.dim(header) + '\n');
  for (const row of bySession.values()) {
    const status = aggregateStatus(row.statuses);
    process.stdout.write(
      pad(row.sessionId.slice(0, 20), 22) +
      pad(row.agent, 10) +
      pad(row.machine, 16) +
      pad(String(row.files), 7) +
      colorStatus(status) + '\n',
    );
  }
  process.stdout.write(chalk.dim('\n(dry run — nothing was written)\n'));
}

function aggregateStatus(statuses: Set<string>): string {
  if (statuses.has('conflict')) return 'conflict';
  if (statuses.has('unknown')) return 'unknown';
  if (statuses.has('new')) return statuses.has('dup') ? 'partial' : 'new';
  return 'dup';
}

function colorStatus(status: string): string {
  switch (status) {
    case 'new': return chalk.green(status);
    case 'dup': return chalk.dim(status);
    case 'partial': return chalk.cyan(status);
    case 'conflict': return chalk.yellow(status);
    case 'unknown': return chalk.red(status);
    default: return status;
  }
}

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w - 1) + ' ' : s + ' '.repeat(w - s.length);
}
