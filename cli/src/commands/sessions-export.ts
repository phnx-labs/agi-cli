/**
 * `agents sessions export` — bundle N selected sessions into a portable,
 * self-describing archive (RUSH-1710).
 *
 * The successor to background R2/CRDT sync for the durable-archive / hand-off
 * case: instead of an always-on merge daemon, the user explicitly bundles the
 * sessions they want to carry to an offline box or keep as an archive. The
 * bundle format + placement live in ../lib/session/bundle.ts; this command owns
 * only the SELECTION (which sessions) and the OUTPUT (file or stdout).
 *
 * Selection flags (`--since`, `-n/--limit`, `--all`, `-a/--agent`,
 * `--no-redact`) are inherited from the parent `sessions` command and read via
 * optsWithGlobals(), so they never shadow the parent's parsing; this command
 * adds only the export-specific flags (`-o/--output`, `--stdout`, `--encrypt`).
 *
 * Rendered markdown/json of a single session is already served by
 * `agents sessions <id> --markdown|--json`; export is specifically the portable,
 * re-importable BUNDLE, so it does not re-expose those render formats.
 */
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { discoverSessions, resolveSessionById, looksLikeSessionId } from '../lib/session/discover.js';
import { findSessionsById } from '../lib/session/db.js';
import { filterSessionsByQuery, parseAgentFilter } from './sessions.js';
import { listLocalTranscripts, objectKey, SYNC_AGENTS, type LocalTranscript } from '../lib/session/sync/agents.js';
import { machineId } from '../lib/machine-id.js';
import { getHistoryDir } from '../lib/state.js';
import { isSyncConfigured, loadR2Config } from '../lib/session/sync/config.js';
import {
  resolveSyncEncKey,
  generateSyncEncKey,
  isTranscriptEnvelope,
} from '../lib/session/sync/transcript-crypto.js';
import { R2Client } from '../lib/session/sync/r2.js';
import { resolveSessionsBackend } from '../lib/session/sync/backend.js';
import { SessionsHttpClient, type SessionsBackupClient } from '../lib/session/sync/net-client.js';
import { resolveManagedBackupKey } from '../lib/session/sync/managed-key.js';
import {
  buildRecord,
  makeHeader,
  mergeRecords,
  serializeBundle,
  writeBundleFile,
  specForAgent,
  type BundleHeader,
  type BundleRecord,
  type FileToExport,
} from '../lib/session/bundle.js';
import { knownSecretValuesFromEnv } from '../lib/redact.js';
import { pullBundlesFromHosts } from '../lib/session/remote-bundle.js';
import { setHelpSections } from '../lib/help.js';

/** Default cap when exporting a scope (not explicit ids) and the user gave no -n. */
const DEFAULT_LIMIT = 500;

export function registerSessionsExportCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('export [selectors...]')
    .description('Bundle sessions (by id, query, or the parent selection flags like --since/-a) into a portable archive.')
    .option('-o, --output <path>', 'Write the bundle to this file')
    .option('--stdout', 'Write the bundle to stdout (for piping into `sessions import -`)')
    .option('--encrypt', 'Seal each transcript body with AES-256-GCM before writing')
    .option('--to-r2', 'Back the selected sessions up off-box (managed Phoenix store when signed in; your own r2.backups bucket with --byo) instead of a local file')
    .option('--byo', 'With --to-r2: force your own r2.backups bucket instead of the managed Phoenix store');

  setHelpSections(cmd, {
    examples: `# Bundle the last week of sessions to a file
agents sessions export --since 7d -o week.bundle

# Bundle two specific sessions
agents sessions export 4f8a2b1c 9d3e7a55 -o pair.bundle

# Encrypt + pipe straight into another machine over SSH
agents sessions export --since 7d --stdout --encrypt | agents ssh boxB 'agents sessions import - --decrypt <key>'

# Back the last month up off-box (managed Phoenix store — no bucket to set up)
agents sessions export --since 30d --to-r2

# Or to your own r2.backups bucket (R2_SYNC_ENC_KEY keeps it zero-knowledge)
agents sessions export --since 30d --to-r2 --byo`,
    notes: `Selection uses the same flags as 'agents sessions' (--since, -n/--limit, --all,
-a/--agent, --no-redact). Bundles are self-describing NDJSON: a header line + one
line per transcript file. Secrets are redacted by default. Dir-shaped sessions
(Kimi) carry all their files. Restore with 'agents sessions import'.

--to-r2 backs each session up off-box, one encrypted object per transcript keyed
by machine/agent/session. When you are signed in ('agents auth login') it uploads
to the MANAGED Phoenix store — no Cloudflare or r2.backups bucket to set up — and
every body is sealed with a per-account key (mandatory; never plaintext). --byo
forces your own r2.backups bucket instead; with R2_SYNC_ENC_KEY, neither Phoenix
nor the storage provider can decrypt it. Restore with 'agents sessions import --from-r2'.`,
  });

  cmd.action(async (selectors: string[], _options: unknown, command: Command) => {
    await runExport(selectors, command);
  });
}

interface GlobalSelection {
  since?: string;
  limit?: string;
  all?: boolean;
  agent?: string;
  redact?: boolean;
  encrypt?: boolean;
  toR2?: boolean;
  byo?: boolean;
  output?: string;
  stdout?: boolean;
  host?: string[];
  claude?: boolean; codex?: boolean; kimi?: boolean; grok?: boolean; opencode?: boolean; antigravity?: boolean;
}

async function runExport(selectors: string[], command: Command): Promise<void> {
  const g = command.optsWithGlobals() as GlobalSelection;

  // --to-r2 preflight. MANAGED-FIRST: a signed-in user backs up to the managed
  // Phoenix store with no bucket to set up; --byo (or an unauthenticated user
  // with an r2.backups bundle) uses their own bucket. isSyncConfigured() is
  // consulted ONLY on the BYO path (it reads the keychain); the managed path
  // authenticates with the Phoenix session and skips it entirely.
  let sessionsClient: SessionsBackupClient | undefined;
  let managedClient: SessionsHttpClient | undefined;
  let managedBackupUserId: string | undefined;
  if (g.byo && !g.toR2) {
    process.stderr.write(chalk.red('--byo is only valid with --to-r2.\n'));
    process.exit(1);
  }
  if (g.toR2) {
    if (g.host && g.host.length > 0) {
      process.stderr.write(chalk.red("--to-r2 backs up THIS machine's sessions; it cannot be combined with --device.\n"));
      process.exit(1);
    }
    try {
      const backend = resolveSessionsBackend({ byo: g.byo });
      if (backend.kind === 'managed') {
        managedClient = new SessionsHttpClient({ baseUrl: backend.baseUrl, userId: backend.userId, token: backend.token });
        sessionsClient = managedClient;
        managedBackupUserId = backend.userId;
      } else {
        // Preserve the explicit BYO gate used by the on-demand backup path and
        // daemon sync cycle. resolveSessionsBackend already loaded the bundle,
        // so this is a cached, non-prompting verification.
        const gateErr = r2ExportGateError(g, isSyncConfigured());
        if (gateErr) throw new Error(gateErr);
        sessionsClient = new R2Client(backend.r2);
      }
    } catch (err) {
      process.stderr.write(chalk.red(`Session backup: ${(err as Error).message}\n`));
      process.exit(1);
    }
  }

  // --host: export sessions that live on remote peer(s) — run export there and
  // stream the bundle back over the existing SSH transport (RUSH-1712).
  if (g.host && g.host.length > 0) {
    await runRemoteExport(g, selectors, command);
    return;
  }

  if (g.toR2 && (g.output || g.stdout)) {
    process.stderr.write(chalk.yellow('Note: --to-r2 uploads to R2; -o/--stdout are ignored.\n'));
  }

  const explicitLimit = command.parent?.getOptionValueSource?.('limit') === 'cli';
  const limit = explicitLimit ? Math.max(1, parseInt(String(g.limit), 10) || DEFAULT_LIMIT) : DEFAULT_LIMIT;
  const agentFilter = parseAgentFilter(resolveAgentShorthand(g));

  // 1. Discover candidate sessions in scope.
  const metas = await discoverSessions({
    all: g.all !== false,
    agent: agentFilter.agent ?? undefined,
    since: g.since,
    limit,
  });

  // 2. Narrow to the selection (ids > query > everything-in-scope).
  const selected = selectSessions(metas, selectors);
  if (selected.length === 0) {
    process.stderr.write(chalk.yellow('No sessions matched the selection.\n'));
    process.exit(1);
  }
  if (!selectors.length && selected.length >= limit) {
    process.stderr.write(chalk.yellow(`Note: capped at ${limit} sessions. Raise -n to bundle more.\n`));
  }

  // 3. Resolve each selected session to its on-disk file(s).
  const index = buildLocalIndex();
  const self = machineId();
  const files: FileToExport[] = [];
  const skippedAgents = new Set<string>();
  for (const meta of selected) {
    const spec = specForAgent(meta.agent);
    if (!spec) { skippedAgents.add(meta.agent); continue; }
    const machine = meta.machine || self;
    const lt = index.get(`${meta.agent}:${meta.id}`);
    if (lt) {
      for (const f of lt.files) {
        files.push({ agent: meta.agent, machine, sessionId: meta.id, relKey: f.relKey, absPath: f.absPath, label: meta.label });
      }
    } else if (meta.filePath && fs.existsSync(meta.filePath)) {
      // Not in the live-home index (e.g. a mirror of another machine): fall back
      // to the single discovered file, deriving its subdir-relative key.
      const relKey = relKeyFromPath(meta.filePath, meta.agent, machine, spec.subdir);
      files.push({ agent: meta.agent, machine, sessionId: meta.id, relKey, absPath: meta.filePath, label: meta.label });
    }
  }
  if (skippedAgents.size > 0) {
    process.stderr.write(chalk.yellow(`Skipped agents with no portable format: ${[...skippedAgents].sort().join(', ')}.\n`));
  }
  if (files.length === 0) {
    process.stderr.write(chalk.red('Selected sessions have no exportable transcript files.\n'));
    process.exit(1);
  }

  // 4. Resolve encryption key (opt-in) + redaction (default on via parent --no-redact).
  //    A BYO R2 backup uses the fleet-shared R2_SYNC_ENC_KEY (an ephemeral key would
  //    be unrecoverable on a fresh box). A MANAGED backup resolves a per-account DEK
  //    that is MANDATORY and never null — the managed path never uploads plaintext —
  //    minting + escrowing one on first use so a fresh box recovers it with zero setup.
  let encryptKey: Buffer | null;
  if (g.toR2 && managedBackupUserId) {
    encryptKey = await resolveManagedBackupKey(managedClient!, managedBackupUserId);
  } else if (g.toR2) {
    encryptKey = resolveR2BackupKey();
  } else if (g.encrypt) {
    encryptKey = resolveExportKey();
  } else {
    encryptKey = null;
  }
  const redact = g.redact !== false;
  // Value-aware redaction: mask live credential values already in the
  // environment (e.g. an injected secrets bundle) verbatim, whatever their
  // format. Only meaningful when redacting.
  const knownSecrets = redact ? knownSecretValuesFromEnv() : undefined;

  // 5. Build records + header.
  const records: BundleRecord[] = [];
  for (const f of files) {
    try {
      records.push(buildRecord(f, { redact, encryptKey, knownSecrets }));
    } catch (err) {
      process.stderr.write(chalk.yellow(`Skipped ${f.agent}/${f.sessionId} (${f.relKey}): ${(err as Error).message}\n`));
    }
  }
  if (records.length === 0) {
    process.stderr.write(chalk.red('Nothing to export after reading files.\n'));
    process.exit(1);
  }
  const header = makeHeader({
    origin: self,
    exportedAt: new Date().toISOString(),
    encrypted: encryptKey !== null,
    redacted: redact,
    records,
  });
  if (g.toR2) {
    await uploadToR2(header, records, sessionsClient);
    return;
  }
  emitBundle(header, records, g);
}

/**
 * Upload each record to R2 as its own self-describing one-record bundle, keyed by
 * the surviving object layout (`sessions/<machine>/<agent>/<sessionId>.jsonl`, or
 * `.../<sessionId>/<relKey>` for dir-shaped agents). Each object is independently
 * a valid bundle, so `import --from-r2` restores it through the same parse/place
 * path as a local bundle. Fails loud on the first upload error (no silent
 * partial-success).
 */
/**
 * `--to-r2` preflight as a pure, unit-testable function: the impossible-combo +
 * not-configured gate. Returns the message to fail loud with, or null when the
 * export may proceed. Only meaningful when `g.toR2` is set (the caller gates on
 * that). Kept pure — no process.exit, no keychain read — so both the command and
 * its test drive the exact same decision.
 */
export function r2ExportGateError(
  g: Pick<GlobalSelection, 'toR2' | 'host'>,
  isConfigured: boolean,
): string | null {
  if (!g.toR2) return null;
  if (g.host && g.host.length > 0) {
    return "--to-r2 backs up THIS machine's sessions; it cannot be combined with --device.";
  }
  if (!isConfigured) {
    return (
      'R2 backup is not configured: the r2.backups secrets bundle is missing or locked.\n' +
      'Add it with: agents secrets add r2.backups R2_ACCOUNT_ID R2_BUCKET_NAME R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY\n' +
      '(optionally R2_SYNC_ENC_KEY for client-side encryption).'
    );
  }
  return null;
}

export async function uploadToR2(
  header: BundleHeader,
  records: BundleRecord[],
  resolvedClient?: SessionsBackupClient,
): Promise<void> {
  // The resolved client (managed HTTP or BYO R2) is passed in by the command.
  // The no-client overload preserves the original BYO-only signature for the
  // direct unit test (loadR2Config() from the r2.backups bundle).
  let client: SessionsBackupClient;
  if (resolvedClient) {
    client = resolvedClient;
  } else {
    try {
      client = new R2Client(loadR2Config());
    } catch (err) {
      process.stderr.write(chalk.red(`R2 backup: ${(err as Error).message}\n`));
      process.exit(1);
    }
  }
  const encryptionError = client.kind === 'managed'
    ? managedUploadEncryptionError(header, records)
    : null;
  if (encryptionError) {
    process.stderr.write(chalk.red(`${encryptionError}\n`));
    process.exit(1);
  }
  let uploaded = 0;
  for (const rec of records) {
    const recHeader = makeHeader({
      origin: header.origin,
      exportedAt: header.exportedAt,
      encrypted: rec.encrypted,
      redacted: header.redacted,
      records: [rec],
    });
    const key = r2KeyForRecord(rec);
    try {
      await client.put(key, serializeBundle(recHeader, [rec]), 'application/json');
    } catch (err) {
      process.stderr.write(chalk.red(`R2 backup failed at ${key}: ${(err as Error).message}\n`));
      process.exit(1);
    }
    uploaded++;
  }
  process.stderr.write(chalk.green(
    `Backed up ${header.sessions} session${header.sessions === 1 ? '' : 's'} ` +
    `(${uploaded} object${uploaded === 1 ? '' : 's'}${header.encrypted ? ', encrypted' : ', UNENCRYPTED'}) → ` +
    `${client.kind === 'managed' ? 'managed Phoenix store' : 'R2'}.\n`,
  ));
}

/** Fail-closed guard at the managed transport boundary, not only at record construction. */
export function managedUploadEncryptionError(
  header: BundleHeader,
  records: BundleRecord[],
): string | null {
  if (
    !header.encrypted ||
    records.some(record => !record.encrypted || !isTranscriptEnvelope(record.body))
  ) {
    return 'Managed session backups require AES-256-GCM envelopes; refusing to upload plaintext.';
  }
  return null;
}

/** R2 object key for one record — dir-shaped agents key by relKey, file-shaped by session. */
export function r2KeyForRecord(rec: BundleRecord): string {
  const spec = specForAgent(rec.agent);
  const relKey = spec?.dirShaped ? rec.relKey : undefined;
  return objectKey(rec.machine, rec.agent, rec.sessionId, relKey);
}

/**
 * Resolve the AES key for an R2 backup: the fleet-shared R2_SYNC_ENC_KEY from the
 * r2.backups bundle so any box on the bundle can restore. Unlike a local bundle,
 * an ephemeral key is useless here (it is never stored, so a fresh box could not
 * decrypt), so a missing key means the objects go up unencrypted (R2 server-side
 * encryption only) with a loud warning — never a silent weaker default.
 */
export function resolveR2BackupKey(): Buffer | null {
  const key = resolveSyncEncKey(loadR2Config());
  if (key) return key;
  process.stderr.write(chalk.yellow(
    'R2_SYNC_ENC_KEY is not set in the r2.backups bundle — objects are stored WITHOUT client-side\n' +
    'encryption (R2 server-side only). Add a shared key so backups are zero-knowledge:\n' +
    '  agents secrets add r2.backups R2_SYNC_ENC_KEY   # value: openssl rand -base64 32\n',
  ));
  return null;
}

/**
 * --host path: run `agents sessions export …` on each peer over SSH, stream the
 * bundles back, merge (dedup by origin machine) and emit one local bundle.
 * Encryption is not combined with a remote pull (each peer would seal under its
 * own key); the SSH transport already encrypts the stream in transit.
 */
async function runRemoteExport(g: GlobalSelection, selectors: string[], command: Command): Promise<void> {
  if (g.encrypt) {
    process.stderr.write(chalk.yellow('Note: --encrypt is ignored with --device (the SSH stream is already encrypted). Encrypt a local bundle instead.\n'));
  }
  const { bundles, errors } = await pullBundlesFromHosts(g.host!, forwardExportArgs(g, selectors, command));
  for (const e of errors) process.stderr.write(chalk.yellow(`  ${e}\n`));
  const records = mergeRecords(bundles.map(b => b.records));
  if (records.length === 0) {
    process.stderr.write(chalk.red('No sessions pulled from the given host(s).\n'));
    process.exit(1);
  }
  const header = makeHeader({
    origin: g.host!.join(','),
    exportedAt: new Date().toISOString(),
    encrypted: false,
    redacted: g.redact !== false,
    records,
  });
  emitBundle(header, records, g);
}

/** Reconstruct the export flags to forward to a peer's own `sessions export`. */
function forwardExportArgs(g: GlobalSelection, selectors: string[], command: Command): string[] {
  const args = [...selectors];
  if (g.since) args.push('--since', g.since);
  const agent = resolveAgentShorthand(g);
  if (agent) args.push('-a', agent);
  if (g.all !== false) args.push('--all');
  if (g.redact === false) args.push('--no-redact');
  if (command.parent?.getOptionValueSource?.('limit') === 'cli' && g.limit) args.push('-n', String(g.limit));
  return args;
}

/** Write the assembled bundle to stdout or a file. */
function emitBundle(header: BundleHeader, records: BundleRecord[], g: GlobalSelection): void {
  const wire = serializeBundle(header, records);
  if (g.stdout) {
    process.stdout.write(wire);
    return;
  }
  const outPath = g.output || defaultBundlePath();
  writeBundleFile(outPath, wire);
  process.stderr.write(chalk.green(
    `Exported ${header.sessions} session${header.sessions === 1 ? '' : 's'} ` +
    `(${header.count} file${header.count === 1 ? '' : 's'}${header.encrypted ? ', encrypted' : ''}${header.redacted ? ', redacted' : ''}) ` +
    `→ ${outPath}\n`,
  ));
}

/** Map the parent's agent shorthands (--claude, --codex, …) or -a/--agent to a filter string. */
function resolveAgentShorthand(g: GlobalSelection): string | undefined {
  if (g.agent) return g.agent;
  if (g.claude) return 'claude';
  if (g.codex) return 'codex';
  if (g.kimi) return 'kimi';
  if (g.grok) return 'grok';
  if (g.opencode) return 'opencode';
  if (g.antigravity) return 'antigravity';
  return undefined;
}

/** ids > query > everything-in-scope. Exported for the id-resolution test. */
export function selectSessions(metas: SessionMeta[], selectors: string[]): SessionMeta[] {
  if (selectors.length === 0) return metas;

  const byId: SessionMeta[] = [];
  const unmatched: string[] = [];
  for (const sel of selectors) {
    const trimmed = sel.trim();
    // Same reason as resolveSessionQuery: the discovered pool is a minority of
    // the index, so an id-shaped selector absent from it may still be indexed
    // here. Gate on looksLikeSessionId, not isCompleteSessionId, so a SHORT id
    // ("d3470b57") also resolves through the index instead of falling to content.
    const hits = resolveSessionById(metas, trimmed);
    const resolved = hits.length > 0 || !looksLikeSessionId(trimmed) ? hits : findSessionsById(trimmed);
    if (resolved.length > 0) byId.push(...resolved);
    else unmatched.push(trimmed);
  }
  if (byId.length > 0 && unmatched.length === 0) {
    const seen = new Set<string>();
    return byId.filter(s => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  }
  // A selector that is an id (complete OR a short hex id/prefix) and still missed
  // cannot be widened: the id is unique, so the text query below could only bundle
  // sessions that merely mention it. Bundling those would ship unrelated
  // transcripts to whoever receives the export, so select nothing and let the
  // caller report it — a short id like "d3470b57" must never content-search.
  const missingIds = unmatched.filter(looksLikeSessionId);
  if (missingIds.length > 0) {
    process.stderr.write(chalk.red(`No session with id ${missingIds.join(', ')} on this machine.\n`));
    return [];
  }
  // Any selector that isn't an id → treat the whole thing as a text query.
  return filterSessionsByQuery(metas, selectors.join(' '));
}

/** Build `${agent}:${sessionId}` → LocalTranscript across every sync agent (live home only). */
function buildLocalIndex(): Map<string, LocalTranscript> {
  const index = new Map<string, LocalTranscript>();
  for (const spec of SYNC_AGENTS) {
    for (const lt of listLocalTranscripts(spec)) {
      index.set(`${spec.id}:${lt.sessionId}`, lt);
    }
  }
  return index;
}

/** Derive the subdir-relative key for a mirror file path, else fall back to the basename. */
function relKeyFromPath(filePath: string, agent: string, machine: string, subdir: string): string {
  const prefix = path.join(getHistoryDir(), 'backups', agent, machine, subdir) + path.sep;
  if (filePath.startsWith(prefix)) return filePath.slice(prefix.length);
  return path.basename(filePath);
}

/**
 * Resolve the AES key for --encrypt: prefer the fleet-shared R2_SYNC_ENC_KEY (so
 * any machine on the sync bundle can decrypt), else mint an ephemeral key and
 * print it once — it is NOT stored in the bundle.
 */
function resolveExportKey(): Buffer {
  try {
    const key = resolveSyncEncKey(loadR2Config());
    if (key) return key;
  } catch {
    // sync bundle not configured — fall through to an ephemeral key
  }
  const b64 = generateSyncEncKey();
  process.stderr.write(chalk.yellow(
    `Bundle encrypted with a fresh key (not in the bundle). Decrypt with:\n` +
    `  agents sessions import <bundle> --decrypt ${b64}\n`,
  ));
  return Buffer.from(b64, 'base64');
}

/** Default output file when neither -o nor --stdout is given. */
function defaultBundlePath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return path.join(process.cwd(), `agents-sessions-${stamp}.bundle`);
}
