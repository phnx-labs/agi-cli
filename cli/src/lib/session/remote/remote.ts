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

/**
 * POSIX single-quote a string for safe interpolation into a remote shell command.
 * Always wraps (unlike the bare-passthrough variant in `ssh-exec.ts`) — the
 * forwarded `agents` argv is embedded verbatim inside `bash -lc '<cmd>'`, so
 * every token is quoted to keep the command boundary unambiguous.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Strip the `--device`/`-D` flag (and its value) from a raw `agents sessions` argv,
 * leaving the args to forward to the remote unchanged. The remote runs the same
 * binary, so every other flag (`--since`, `--last`, `--json`, query, …) carries
 * over for free. Handles every form commander accepts: `--device h`, `--device=h`,
 * `-D h`, `-D=h`, and the glued short form `-Dh`.
 *
 * @param argv full process argv; the sessions args begin at index 2
 *             (`[runtime, script, 'sessions', ...]`).
 */
export function buildForwardedArgs(argv: string[], hosts: Set<string> = new Set()): string[] {
  const args = argv.slice(2);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--device' || a === '--devices') {
      // Commander's `<target...>` variadic accepts both `--device a --device b`
      // and `--device a b` — consume every consecutive token that is a known host
      // so the variadic form doesn't leak the extra hosts into the remote argv.
      // Fall back to consuming the single next token when we have no host set
      // (e.g. malformed input) so the flag value never leaks either way.
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

/**
 * Force a forwarded `agents sessions` listing to span the peer's WHOLE index.
 *
 * A remote listing runs in the peer's SSH-login cwd — its home dir — and the
 * default listing is silently cwd-scoped, so `sessions --device box` reads as
 * empty even when the box's index is full (`No sessions found for /home/<user>`).
 * Across SSH a peer's cwd is meaningless, so `--device` defaults to `--all`
 * (whole-index) scope. This only drops the *cwd* narrowing — an explicit path
 * query, `--project`, `--since`, or `--agent` filter still narrows on top, and
 * a query that looks like a path takes precedence over `--all` on the remote.
 * Idempotent: never adds a second `--all`.
 */
export function ensureWholeIndex(forwardedArgs: string[]): string[] {
  return forwardedArgs.includes('--all') ? forwardedArgs : [...forwardedArgs, '--all'];
}

/**
 * Build the single remote command string for `ssh <host> <cmd>`. Forwarded args
 * are quoted for the inner login shell, then the whole `agents …` invocation is
 * quoted again so it survives `bash -lc <...>`.
 *
 * `os` selects the remote shell: a Windows host gets a PowerShell invocation
 * (ssh lands in cmd.exe/PowerShell there, where `bash -lc` does not exist);
 * anything else — including unknown/absent — keeps the POSIX form unchanged.
 * The forwarded terminal width rides across as an env var either way so the
 * remote renders its table to the local screen.
 */
export function buildRemoteCommand(forwardedArgs: string[], columns?: number, os?: string): string {
  // `--device <box>` means "that box's own sessions" — so the peer must answer for
  // ITSELF and not re-sweep its fleet. Without this the remote `agents sessions`
  // fans back out to every device IT knows (including us), printing a spurious
  // `<this-machine>: unreachable`. AGENTS_SESSIONS_LOCAL=1 pins the peer local,
  // matching the JSON fan-out path (`remote-list.ts`).
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

/**
 * Classify an ssh `spawnSync` result. ssh(1) reserves exit 255 for its own
 * connection-layer failures (host down, timeout, refused, auth, changed host
 * key) — distinct from any other non-zero, which is the remote `agents sessions`
 * exit code forwarded back (the query ran but failed). The two must be handled
 * differently: 255 may fall back to cache, a forwarded failure must surface.
 */
export function classifySshFailure(res: { error?: Error | null; status: number | null }): SshOutcome {
  if (res.error) return 'spawn-error';
  if (res.status === 0) return 'ok';
  if (res.status === 255) return 'unreachable';
  return 'query-failed';
}

/** Root of the offline-replay cache (`~/.agents/.cache/remote-sessions/`). */
const REMOTE_CACHE_DIR = join(getCacheDir(), 'remote-sessions');

/**
 * How long a successful remote fetch may be served without re-SSHing.
 * Short on purpose: session listings must stay near-live (RUSH-2062). Match the
 * active-session snapshot window so surfaces share one freshness model.
 */
export const REMOTE_CACHE_MAX_AGE_MS = 15_000;

/**
 * Deterministic cache path for a (host, forwarded-args) pair. The forwarded args
 * are hashed so distinct queries cache independently; the host stays readable in
 * the filename (sanitised so `user@host` and aliases are filesystem-safe).
 */
export function remoteCachePath(host: string, forwardedArgs: string[]): string {
  const hash = createHash('sha256').update(forwardedArgs.join('\u0000')).digest('hex').slice(0, 16);
  const safeHost = host.replace(/[^a-zA-Z0-9._@-]/g, '_');
  return join(REMOTE_CACHE_DIR, `${safeHost}__${hash}.txt`);
}

/**
 * Pure freshness check for a remote-sessions cache entry. A reachable host
 * skips SSH only while this returns true; unreachable fallback ignores age.
 */
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

/**
 * Read a cached remote fetch. When `maxAgeMs` is set, returns null if the
 * entry is older than the window (cache-first path for reachable hosts).
 * Omit `maxAgeMs` to accept any age (unreachable fallback).
 */
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

/**
 * Serve a *fresh* cache entry for a reachable-host skip (no banner — the data
 * is still within the freshness window). Returns false when missing/stale so
 * the caller SSHes. RUSH-2062: without this, a reachable host never skipped SSH
 * even when the cache was just written.
 */
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

/**
 * Run the current `agents sessions` invocation on one or more remote machines over
 * SSH, writing each remote's output to the terminal.
 *
 * Cache policy (RUSH-2062):
 * - **Default:** serve a fresh cache hit without SSH; SSH only on miss/stale.
 * - **`forceRefresh`:** always SSH, then rewrite the cache.
 * - **Unreachable:** fall back to any cached output (with a stale banner).
 *
 * Sets `process.exitCode = 1` if any host could not be answered (live or cached).
 * Reads the invocation from `process.argv` (override via `argv` for testing).
 *
 * Output is captured rather than `stdio: 'inherit'`-streamed so it can be cached.
 * Session output is small and the remote returns quickly, so buffering is
 * imperceptible; `maxBuffer` is generous for the rare large `--markdown <id>` dump.
 */
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
