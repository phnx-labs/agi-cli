/**
 * `agents sessions --device <target>` — run the session query on a remote machine
 * over SSH and stream its output back. Session transcripts and the index DB live
 * on the machine that produced them (see `discover.ts`, all `os.homedir()`-rooted),
 * so instead of syncing the bytes here we invoke the *remote's own* `agents
 * sessions` against its already-built index and forward stdout verbatim.
 *
 * This is the live counterpart to `agents sessions sync` (R2/CRDT, eventual): no
 * upfront copy, always current, but the peer must be reachable. SSH access is the
 * only auth — if you can `ssh <host>`, you own the box (no identity layer by design).
 *
 * Cache-first (RUSH-2062) + offline degradation: every *successful* fetch is
 * cached to `~/.agents/.cache/remote-sessions/`, keyed by host + the exact query.
 * A later call with a *fresh* cache serves it without SSH (same daemon-warmed
 * shared-cache shape as `stats-cache.ts`) so a reachable host is not re-probed
 * on every menubar/CLI/watchdog tick. When the host is unreachable, any cache
 * (even stale) is replayed with a clearly labelled "showing cached results"
 * banner. The cache is a byproduct of fetches you already made — freely
 * deletable — so the fetch-don't-replicate model holds.
 *
 * Mirrors the transport already used by `agents secrets export --device`
 * (`src/commands/secrets.ts`): `ssh -o BatchMode=yes <host> bash -lc '<cmd>'`,
 * with `bash -lc` so the remote login PATH resolves `agents`.
 */
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import chalk from 'chalk';
import { getCacheDir } from '../../state.js';
import { SSH_OPTS, controlOpts, assertValidSshTarget } from '../../ssh-exec.js';
import { remoteShellFor, buildWindowsAgentsCommand } from '../../hosts/remote-cmd.js';
import { resolveRemoteOsSync } from '../../hosts/remote-os.js';
import { NO_FANOUT_ENV } from '../remote-active.js';
import { formatRelativeTime } from '../../text/relative-time.js';
import { terminalWidth } from '../../text/width.js';

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function buildForwardedArgs(argv: string[], hosts: Set<string> = new Set()): string[] {
  const args = argv.slice(2);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--device' || a === '--devices') {
      if (hosts.size > 0) {
        while (i + 1 < args.length && hosts.has(args[i + 1])) i++;
      } else {
        i++;
      }
      continue;
    }
    if (a.startsWith('--device=') || a.startsWith('--devices=')) continue;
    out.push(a);
  }
  return out;
}

export function ensureWholeIndex(forwardedArgs: string[]): string[] {
  return forwardedArgs.includes('--all') ? forwardedArgs : [...forwardedArgs, '--all'];
}

export function buildRemoteCommand(forwardedArgs: string[], columns?: number, os?: string): string {
  if (remoteShellFor(os) === 'powershell') {
    const env: Record<string, string> = { [NO_FANOUT_ENV]: '1' };
    if (columns && columns > 0) env.COLUMNS = String(columns);
    return buildWindowsAgentsCommand({ args: forwardedArgs, env });
  }
  const inner = ['agents', ...forwardedArgs].map(shellQuote).join(' ');
  const envPrefix = `${NO_FANOUT_ENV}=1` + (columns && columns > 0 ? ` COLUMNS=${columns}` : '');
  return `bash -lc ${shellQuote(`${envPrefix} ${inner}`)}`;
}


type SshOutcome = 'ok' | 'unreachable' | 'query-failed' | 'spawn-error';

export function classifySshFailure(res: { error?: Error | null; status: number | null }): SshOutcome {
  if (res.error) return 'spawn-error';
  if (res.status === 0) return 'ok';
  if (res.status === 255) return 'unreachable';
  return 'query-failed';
}

const REMOTE_CACHE_DIR = join(getCacheDir(), 'remote-sessions');

export const REMOTE_CACHE_MAX_AGE_MS = 15_000;

export function remoteCachePath(host: string, forwardedArgs: string[]): string {
  const hash = createHash('sha256').update(forwardedArgs.join('\u0000')).digest('hex').slice(0, 16);
  const safeHost = host.replace(/[^a-zA-Z0-9._@-]/g, '_');
  return join(REMOTE_CACHE_DIR, `${safeHost}__${hash}.txt`);
}

export function isRemoteCacheFresh(
  mtimeMs: number,
  nowMs: number,
  maxAgeMs: number = REMOTE_CACHE_MAX_AGE_MS,
): boolean {
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return false;
  return nowMs - mtimeMs <= maxAgeMs;
}

interface RemoteCacheHit {
  output: string;
  mtimeMs: number;
}

export function readRemoteCache(
  host: string,
  forwardedArgs: string[],
  opts: { maxAgeMs?: number; nowMs?: number } = {},
): RemoteCacheHit | null {
  try {
    const p = remoteCachePath(host, forwardedArgs);
    if (!existsSync(p)) return null;
    const mtimeMs = statSync(p).mtimeMs;
    if (opts.maxAgeMs !== undefined) {
      const now = opts.nowMs ?? Date.now();
      if (!isRemoteCacheFresh(mtimeMs, now, opts.maxAgeMs)) return null;
    }
    return { output: readFileSync(p, 'utf8'), mtimeMs };
  } catch {
    return null;
  }
}

export function formatStaleBanner(host: string, mtimeMs: number): string {
  const ago = formatRelativeTime(new Date(mtimeMs).toISOString());
  return chalk.yellow(`${host}: offline — showing cached results from ${ago}`);
}

export function formatUnreachable(host: string): string {
  return chalk.red(
    `${host}: unreachable over SSH (asleep, offline, or host key changed?) — ConnectTimeout 10s`,
  );
}

export function writeRemoteCache(host: string, forwardedArgs: string[], output: string): void {
  try {
    mkdirSync(REMOTE_CACHE_DIR, { recursive: true });
    writeFileSync(remoteCachePath(host, forwardedArgs), output);
  } catch {
  }
}

export function serveWarmRemoteCache(
  host: string,
  forwardedArgs: string[],
  opts: { maxAgeMs?: number; nowMs?: number } = {},
): boolean {
  const hit = readRemoteCache(host, forwardedArgs, {
    maxAgeMs: opts.maxAgeMs ?? REMOTE_CACHE_MAX_AGE_MS,
    nowMs: opts.nowMs,
  });
  if (!hit) return false;
  process.stdout.write(hit.output);
  return true;
}

export function replayRemoteCache(host: string, forwardedArgs: string[]): boolean {
  const hit = readRemoteCache(host, forwardedArgs);
  if (!hit) return false;
  process.stderr.write(formatStaleBanner(host, hit.mtimeMs) + '\n');
  process.stdout.write(hit.output);
  return true;
}

interface RunRemoteSessionsOptions {
  forceRefresh?: boolean;
  maxAgeMs?: number;
  nowMs?: number;
}

export function runRemoteSessions(
  hosts: string[],
  argv: string[] = process.argv,
  opts: RunRemoteSessionsOptions = {},
): void {
  for (const host of hosts) assertValidSshTarget(host);

  const forwarded = ensureWholeIndex(buildForwardedArgs(argv, new Set(hosts)));
  const cols = terminalWidth();
  const multi = hosts.length > 1;
  let failures = 0;
  const forceRefresh = opts.forceRefresh === true
    || process.env.AGENTS_SESSIONS_FORCE_REFRESH === '1';

  for (const host of hosts) {
    if (multi) process.stdout.write(chalk.cyan(`\n── ${host} ──\n`));

    if (!forceRefresh && serveWarmRemoteCache(host, forwarded, {
      maxAgeMs: opts.maxAgeMs,
      nowMs: opts.nowMs,
    })) {
      continue;
    }

    const remoteCmd = buildRemoteCommand(forwarded, cols, resolveRemoteOsSync(host));
    const res = spawnSync('ssh', [...SSH_OPTS, ...controlOpts(), host, remoteCmd], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });

    switch (classifySshFailure(res)) {
      case 'ok':
        process.stdout.write(res.stdout ?? '');
        if (res.stderr) process.stderr.write(res.stderr);
        writeRemoteCache(host, forwarded, res.stdout ?? '');
        break;

      case 'unreachable':
        if (!replayRemoteCache(host, forwarded)) {
          failures++;
          console.error(formatUnreachable(host));
        }
        break;

      case 'spawn-error':
        failures++;
        console.error(chalk.red(`${host}: ${res.error?.message ?? 'failed to launch ssh'}`));
        break;

      case 'query-failed':
        failures++;
        if (res.stdout) process.stdout.write(res.stdout);
        if (res.stderr) process.stderr.write(res.stderr);
        console.error(chalk.red(`${host}: remote query failed (exit ${res.status ?? 'signal'}).`));
        break;
    }
  }

  if (failures > 0) process.exitCode = 1;
}
