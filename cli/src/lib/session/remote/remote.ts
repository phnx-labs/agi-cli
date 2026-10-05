/** `agents sessions --device <target>`: run the query on the remote's own index over SSH, stdout
 * verbatim. Cache-first (RUSH-2062) in `~/.agents/.cache/remote-sessions/`: fresh hits skip SSH;
 * an unreachable host replays any cache with a 'showing cached results' banner. */
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

/** POSIX single-quote a string for the remote shell. Always wraps (unlike the bare-passthrough
 * variant in `ssh-exec.ts`) so each token inside `bash -lc '<cmd>'` has an unambiguous
 * boundary. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Strip `--device`/`-D` and its value from a raw `agents sessions` argv, forwarding everything
 * else unchanged. Handles `--device h`, `--device=h`, `-D h`, `-D=h` and `-Dh`. `argv` is the full
 * process argv; the sessions args begin at index 2. */
export function buildForwardedArgs(argv: string[], hosts: Set<string> = new Set()): string[] {
  const args = argv.slice(2);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--device' || a === '--devices') {
      // Commander's variadic `<target...>` accepts `--device a --device b` and `--device a b`, so
      // consume every consecutive known host to avoid leaking extra hosts into the remote argv.
      // With no host set, consume just the next token so the value never leaks.
      if (hosts.size > 0) {
        while (i + 1 < args.length && hosts.has(args[i + 1])) i++;
      } else {
        i++; // also consume the separate value token
      }
      continue;
    }
    if (a.startsWith('--device=') || a.startsWith('--devices=')) continue;
    out.push(a);
  }
  return out;
}

/** Force a forwarded listing to span the peer's whole index: the default is cwd-scoped and the
 * peer's SSH cwd is its home, so `--device box` looked empty. Only drops cwd narrowing; explicit
 * filters still apply. Idempotent. */
export function ensureWholeIndex(forwardedArgs: string[]): string[] {
  return forwardedArgs.includes('--all') ? forwardedArgs : [...forwardedArgs, '--all'];
}

/** Build the remote command string for `ssh <host> <cmd>`: args quoted for the inner login shell,
 * then the whole invocation quoted again for `bash -lc`. `os` selects PowerShell for Windows.
 * Terminal width rides as an env var. */
export function buildRemoteCommand(forwardedArgs: string[], columns?: number, os?: string): string {
  // `--device <box>` means that box's own sessions, so the peer must answer for itself; otherwise
  // it re-sweeps its fleet (including us) and prints a spurious `<this-machine>: unreachable`.
  // AGENTS_SESSIONS_LOCAL=1 pins it local, matching the JSON fan-out in `remote-list.ts`.
  if (remoteShellFor(os) === 'powershell') {
    const env: Record<string, string> = { [NO_FANOUT_ENV]: '1' };
    if (columns && columns > 0) env.COLUMNS = String(columns);
    return buildWindowsAgentsCommand({ args: forwardedArgs, env });
  }
  const inner = ['agents', ...forwardedArgs].map(shellQuote).join(' ');
  // Forward the caller's terminal width so the remote renders the table to the
  // local screen (over SSH the remote's own COLUMNS is unset/wrong). `VAR=val
  // cmd` scopes the env to that process — the remote's terminalWidth() reads it.
  const envPrefix = `${NO_FANOUT_ENV}=1` + (columns && columns > 0 ? ` COLUMNS=${columns}` : '');
  return `bash -lc ${shellQuote(`${envPrefix} ${inner}`)}`;
}


/** The four outcomes of one `ssh <host> agents sessions …` invocation. */
type SshOutcome = 'ok' | 'unreachable' | 'query-failed' | 'spawn-error';

/** Classify an ssh `spawnSync` result. Exit 255 is ssh's own connection-layer failure (host down,
 * timeout, refused, auth, changed host key); any other non-zero is the forwarded remote exit code.
 * 255 may fall back to cache; a forwarded failure must surface. */
export function classifySshFailure(res: { error?: Error | null; status: number | null }): SshOutcome {
  if (res.error) return 'spawn-error';
  if (res.status === 0) return 'ok';
  if (res.status === 255) return 'unreachable';
  return 'query-failed';
}

/** Root of the offline-replay cache (`~/.agents/.cache/remote-sessions/`). */
const REMOTE_CACHE_DIR = join(getCacheDir(), 'remote-sessions');

/** How long a successful remote fetch may be served without re-SSHing. Short on purpose so
 * listings stay near-live (RUSH-2062); matches the active-session snapshot window. */
export const REMOTE_CACHE_MAX_AGE_MS = 15_000;

/** Deterministic cache path for a (host, forwarded-args) pair. Args are hashed so distinct
 * queries cache independently; the host stays readable, sanitised for the filesystem. */
export function remoteCachePath(host: string, forwardedArgs: string[]): string {
  const hash = createHash('sha256').update(forwardedArgs.join('\u0000')).digest('hex').slice(0, 16);
  const safeHost = host.replace(/[^a-zA-Z0-9._@-]/g, '_');
  return join(REMOTE_CACHE_DIR, `${safeHost}__${hash}.txt`);
}

/** Pure freshness check for a remote-sessions cache entry. A reachable host skips SSH only
 * while true; the unreachable fallback ignores age. */
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

/** Read a cached remote fetch. With `maxAgeMs`, returns null for an older entry (reachable-host
 * path); omit it to accept any age (unreachable fallback). */
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

/** Banner shown above replayed cache rows when the peer is offline. */
export function formatStaleBanner(host: string, mtimeMs: number): string {
  const ago = formatRelativeTime(new Date(mtimeMs).toISOString());
  return chalk.yellow(`${host}: offline — showing cached results from ${ago}`);
}

/** Message shown when a host is unreachable and there is no cache to fall back to. */
export function formatUnreachable(host: string): string {
  return chalk.red(
    `${host}: unreachable over SSH (asleep, offline, or host key changed?) — ConnectTimeout 10s`,
  );
}

/** Persist a successful fetch for later cache-first / offline replay.
 * Best-effort: a cache write must never break the live query. Exported for tests. */
export function writeRemoteCache(host: string, forwardedArgs: string[], output: string): void {
  try {
    mkdirSync(REMOTE_CACHE_DIR, { recursive: true });
    writeFileSync(remoteCachePath(host, forwardedArgs), output);
  } catch {
    // ignore — caching is an optimisation, not a guarantee
  }
}

/** Serve a fresh cache entry for a reachable host (no banner); returns false when missing or stale
 * so the caller SSHes. RUSH-2062: previously a reachable host never skipped SSH even with a
 * just-written cache. */
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

/** Replay a cached fetch for an unreachable host (any age). Banner goes to
 * stderr (so a piped stdout stays exactly the cached rows); returns false when
 * nothing is cached for this exact (host, query). */
export function replayRemoteCache(host: string, forwardedArgs: string[]): boolean {
  const hit = readRemoteCache(host, forwardedArgs); // no maxAge — any age ok
  if (!hit) return false;
  process.stderr.write(formatStaleBanner(host, hit.mtimeMs) + '\n');
  process.stdout.write(hit.output);
  return true;
}

interface RunRemoteSessionsOptions {
  /** Skip warm cache and SSH every host (force-refresh). */
  forceRefresh?: boolean;
  /** Override freshness window for the warm path. */
  maxAgeMs?: number;
  /** Clock (tests). */
  nowMs?: number;
}

/** Run the current `agents sessions` invocation on remote machines over SSH (RUSH-2062 cache):
 * serve a fresh hit without SSH; `forceRefresh` always SSHes; unreachable falls back to any cache
 * with a stale banner. Sets `process.exitCode = 1` if any host went unanswered. */
export function runRemoteSessions(
  hosts: string[],
  argv: string[] = process.argv,
  opts: RunRemoteSessionsOptions = {},
): void {
  for (const host of hosts) assertValidSshTarget(host); // fail fast on any bad target

  const forwarded = ensureWholeIndex(buildForwardedArgs(argv, new Set(hosts)));
  const cols = terminalWidth();
  const multi = hosts.length > 1;
  let failures = 0;
  const forceRefresh = opts.forceRefresh === true
    || process.env.AGENTS_SESSIONS_FORCE_REFRESH === '1';

  for (const host of hosts) {
    if (multi) process.stdout.write(chalk.cyan(`\n── ${host} ──\n`));

    // Cache-first: a warm hit skips SSH entirely so reachable hosts share one
    // snapshot across menubar/CLI/watchdog instead of re-fanning every call.
    if (!forceRefresh && serveWarmRemoteCache(host, forwarded, {
      maxAgeMs: opts.maxAgeMs,
      nowMs: opts.nowMs,
    })) {
      continue;
    }

    // Per-host: a Windows peer needs a PowerShell command, POSIX peers `bash -lc`.
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
        // Served-from-cache counts as answered (degraded, but with data + a clear
        // banner), so it does not increment failures. No cache → a real failure.
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
        // The remote ran but its query exited non-zero — surface its own output
        // and exit code; never mask a genuine error with stale cache.
        failures++;
        if (res.stdout) process.stdout.write(res.stdout);
        if (res.stderr) process.stderr.write(res.stderr);
        console.error(chalk.red(`${host}: remote query failed (exit ${res.status ?? 'signal'}).`));
        break;
    }
  }

  if (failures > 0) process.exitCode = 1;
}
