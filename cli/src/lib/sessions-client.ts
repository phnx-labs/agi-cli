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
import { findInPath } from './agent-spec/agents.js';

const INSTALL_HINT = 'npm i -g @phnx-labs/sessions-cli';

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
  'attach',
  'focus',
  'render',
  'stats',
  'go',
  'reconnect',
  'migrations',
  'export',
]);

export function isReadQuery(args: string[]): boolean {
  if (args.length === 0) return false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--limit' || arg === '--agent') {
      i += 1;
      continue;
    }
    if (arg.startsWith('--limit=') || arg.startsWith('--agent=')) continue;
    if (arg.startsWith('-')) {
      if (!READ_FLAGS.has(arg)) return false;
      continue;
    }
    if (ENGINE_VERBS.has(arg)) return false;
  }
  return true;
}

/** Test seam: drop the memoized bin so PATH fixtures can re-resolve. */
export function _resetSessionsClientForTest(): void {
  cachedBin = undefined;
}

export const SESSIONS_INSTALL_HINT = INSTALL_HINT;
