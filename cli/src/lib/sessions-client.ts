import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
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

function dependencySessionsBin(): string | null {
  const dirs = createRequire(import.meta.url).resolve.paths('@phnx-labs/sessions-cli');
  if (!dirs) return null;
  let pkgJsonPath: string | undefined;
  for (const dir of dirs) {
    const candidate = path.join(dir, '@phnx-labs', 'sessions-cli', 'package.json');
    if (existsSync(candidate)) {
      pkgJsonPath = candidate;
      break;
    }
  }
  if (!pkgJsonPath) return null;
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.sessions;
  const abs = rel ? path.resolve(path.dirname(pkgJsonPath), rel) : '';
  if (!rel || !existsSync(abs)) {
    throw new SessionsClientError(
      'SESSIONS_BIN_MISSING',
      `@phnx-labs/sessions-cli is installed beside agents-cli but its sessions bin is missing` +
        `${rel ? ` (${rel})` : ''}.`,
    );
  }
  return realpathSync(abs);
}

export function resolveSessionsBin(): string {
  if (cachedBin) return cachedBin;
  const raw = process.env.SESSIONS_BIN;
  const explicit = raw?.trim();
  if (explicit) {
    cachedBin = explicit;
    return cachedBin;
  }
  const resolved = (raw === undefined ? dependencySessionsBin() : null) ?? findInPath('sessions');
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

export function runSessions(argv: string[]): Promise<number> {
  const { command, prefix } = invocation(resolveSessionsBin());
  const leaveInterruptToChild = (): void => {};
  process.on('SIGINT', leaveInterruptToChild);
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, [...prefix, ...argv], { stdio: 'inherit' });
    child.on('error', (err) => {
      process.off('SIGINT', leaveInterruptToChild);
      reject(new SessionsClientError('SESSIONS_SPAWN_FAILED', `Failed to run \`sessions\`: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      process.off('SIGINT', leaveInterruptToChild);
      resolve(code ?? (signal === 'SIGINT' ? 130 : 1));
    });
  });
}

export function _resetSessionsClientForTest(): void {
  cachedBin = undefined;
}
