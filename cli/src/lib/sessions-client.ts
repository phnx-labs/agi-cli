/**
 * sessions-client.ts — agents-cli's process client for the standalone
 * `sessions` CLI (PHNX-4012). This client never falls back itself: a missing
 * binary throws `SESSIONS_BIN_MISSING` (loud, DIST-1). The caller decides what
 * that means — the read fast-path in `index.ts` falls through to the in-repo
 * `lib/session` engine when the standalone is not installed (every worker and
 * CI runner, until @phnx-labs/sessions-cli is published), and takes the fast
 * path when it is.
 *
 * Bin resolution uses `findInPath`, which skips `~/.agents/.cache/shims`.
 * That skip is load-bearing: the leftover `sessions` alias shim execs
 * `agents sessions`, and resolving it would recurse (the 1.22.85 secrets
 * fork bomb with the names swapped — agi-cli#3532).
 */
import { spawnSync } from 'node:child_process';
import { findInPath } from './agent-spec/agents.js';
import { compareVersions } from './agent-spec/primitives.js';

const INSTALL_HINT = 'npm i -g @phnx-labs/sessions-cli';

/**
 * First `sessions` release that implements the metadata filters and sort
 * (`-p/--project`, `--since`, `--until`, `--sort`, the `@version` agent suffix,
 * and the harness shorthands). An older binary would treat these as FTS tokens,
 * so a box with `sessions` < this floor keeps them on the in-repo engine (which
 * implements the same filters) rather than mis-routing to a binary that can't.
 */
const SESSIONS_FILTERS_MIN_VERSION = '0.2.0';

export class SessionsClientError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'SessionsClientError';
  }
}

let cachedBin: string | undefined;

export function resolveSessionsBin(): string {
  if (cachedBin) return cachedBin;
  const explicit = process.env.SESSIONS_BIN?.trim();
  const resolved = explicit && explicit.length > 0 ? explicit : findInPath('sessions');
  if (!resolved) {
    throw new SessionsClientError(
      'SESSIONS_BIN_MISSING',
      'The standalone `sessions` CLI was not found. Install it with:\n' +
        `  ${INSTALL_HINT}\n` +
        'or point $SESSIONS_BIN at its executable.',
    );
  }
  cachedBin = resolved;
  return resolved;
}

export function invocation(bin: string): { command: string; prefix: string[] } {
  if (/\.[mc]?js$/.test(bin)) return { command: process.execPath, prefix: [bin] };
  return { command: bin, prefix: [] };
}

/**
 * Allowlist of what sessions-cli v1 actually implements. Anything else —
 * picker (no args), `--since`, `-D`, `--waiting`, `render`, `stats`,
 * lifecycle verbs — stays on the in-repo engine. A denylist leaked those
 * through `allowUnknownOption()` as FTS tokens (PR review on #3554).
 */
const READ_FLAGS = new Set([
  '--json',
  '--local',
  '--no-interactive',
]);

/**
 * Boolean harness-shorthand flags added in 0.2.0 (`--claude` = `--agent claude`).
 * Recognized as read flags only when the resolved binary supports filters.
 */
const FILTER_BOOL_FLAGS = new Set([
  '--claude',
  '--codex',
  '--kimi',
  '--antigravity',
  '--grok',
  '--opencode',
]);

/**
 * Value-taking filter flags added in 0.2.0 (each consumes the next argv token,
 * or is written `--flag=value`). `--agent`/`--limit` are NOT here — they are the
 * 0.1.x base set handled unconditionally below.
 */
const FILTER_VALUE_FLAGS = new Set([
  '--project',
  '--since',
  '--until',
  '--sort',
]);

/** True if any 0.2.0-only filter flag is present — the only case that needs the version probe. */
export function usesFilterFlags(args: string[]): boolean {
  return args.some((arg) => {
    if (arg === '-p' || arg === '-a') return true;
    if (FILTER_BOOL_FLAGS.has(arg)) return true;
    for (const vf of FILTER_VALUE_FLAGS) {
      if (arg === vf || arg.startsWith(`${vf}=`)) return true;
    }
    return false;
  });
}

let cachedFilterSupport: boolean | undefined;

/**
 * Whether the resolved `sessions` binary is new enough for the 0.2.0 filters.
 * Runs `sessions --version` once per process (cached). A probe failure or an
 * unparseable version reads as unsupported — the safe direction (in-repo engine
 * handles the filters), never a mis-route to an old binary.
 */
export function sessionsBinSupportsFilters(bin: string): boolean {
  if (cachedFilterSupport !== undefined) return cachedFilterSupport;
  const { command, prefix } = invocation(bin);
  const res = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8', timeout: 3000 });
  const version = (res.stdout ?? '').trim();
  cachedFilterSupport =
    !res.error && /^\d+\.\d+\.\d+/.test(version) && compareVersions(version, SESSIONS_FILTERS_MIN_VERSION) >= 0;
  return cachedFilterSupport;
}

const ENGINE_VERBS = new Set([
  'resume',
  'detach',
  'stop',
  'inject',
  'fork',
  'backfill',
  'migrate',
  'share',
  'export',
  'import',
  'optimize',
  'trace',
  'insights',
  'bookmark',
  'tail',
  'watch',
  'preview',
  'focus',
  'render',
  'stats',
  'migrations',
  'export',
]);

export function isReadQuery(args: string[], opts: { filters?: boolean } = {}): boolean {
  if (args.length === 0) return false;
  // Base (0.1.x) value flags, always recognized; the 0.2.0 filter value flags
  // join them only when the binary supports filters.
  const valueFlags = new Set(['--limit', '--agent']);
  const boolFlags = new Set(READ_FLAGS);
  if (opts.filters) {
    for (const vf of FILTER_VALUE_FLAGS) valueFlags.add(vf);
    for (const bf of FILTER_BOOL_FLAGS) boolFlags.add(bf);
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // `-a` (agent) and `-p` (project) are 0.2.0 short flags that take a value.
    if (opts.filters && (arg === '-a' || arg === '-p')) {
      i += 1;
      continue;
    }
    let matchedValue = false;
    for (const vf of valueFlags) {
      if (arg === vf) {
        i += 1;
        matchedValue = true;
        break;
      }
      if (arg.startsWith(`${vf}=`)) {
        matchedValue = true;
        break;
      }
    }
    if (matchedValue) continue;
    if (arg.startsWith('-')) {
      if (!boolFlags.has(arg)) return false;
      continue;
    }
    if (ENGINE_VERBS.has(arg)) return false;
  }
  return true;
}

/** Test seam: drop the memoized bin so PATH fixtures can re-resolve. */
export function _resetSessionsClientForTest(): void {
  cachedBin = undefined;
  cachedFilterSupport = undefined;
}

export const SESSIONS_INSTALL_HINT = INSTALL_HINT;
