/**
 * sessions-client.ts — agents-cli's process client for the standalone
 * `sessions` CLI (PHNX-4012). DIST-1: a missing binary fails loud; there is
 * no fallback to the in-repo `lib/session` query engine on the read path.
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

/** Verbs/flags the standalone v1 does not own — stay on the in-repo engine. */
const LIFECYCLE_VERBS = new Set([
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
]);

const LIVE_FLAGS = new Set([
  '--active',
  '--working',
  '--idle',
  '--orphan',
  '--orphaned',
  '--crashed',
  '--markdown',
  '--include',
  '--preview',
  '--teams',
  '--fleet',
  '--routine',
]);

export function isReadQuery(args: string[]): boolean {
  for (const arg of args) {
    if (LIVE_FLAGS.has(arg)) return false;
    if (arg.startsWith('--device') || arg.startsWith('--include') || arg.startsWith('--host')) {
      return false;
    }
    if (!arg.startsWith('-') && LIFECYCLE_VERBS.has(arg)) return false;
  }
  return true;
}

export const SESSIONS_INSTALL_HINT = INSTALL_HINT;
