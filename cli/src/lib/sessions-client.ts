import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { findInPath } from './agent-spec/agents.js';
import { compareVersions } from './agent-spec/primitives.js';
import { stripRoutingFlags } from './hosts/remote-cmd.js';

const INSTALL_HINT = 'npm i -g @phnx-labs/sessions-cli';

const SESSIONS_FILTERS_MIN_VERSION = '0.2.0';

const SESSIONS_HOST_MIN_VERSION = '0.2.1';

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

// Skip the legacy agents shim to avoid recursive sessions passthrough.
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

const READ_FLAGS = new Set([
  '--json',
  '--local',
  '--no-interactive',
]);

const FILTER_BOOL_FLAGS = new Set([
  '--claude',
  '--codex',
  '--kimi',
  '--antigravity',
  '--grok',
  '--opencode',
]);

const FILTER_VALUE_FLAGS = new Set([
  '--project',
  '--since',
  '--until',
  '--sort',
]);

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

export function usesHostFlag(args: string[]): boolean {
  return args.some((arg) => arg === '--host' || arg.startsWith('--host='));
}

let cachedProbedVersion: string | null | undefined;

function probeSessionsVersion(bin: string): string | null {
  if (cachedProbedVersion !== undefined) return cachedProbedVersion;
  const { command, prefix } = invocation(bin);
  const res = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8', timeout: 3000 });
  const version = (res.stdout ?? '').trim();
  cachedProbedVersion = !res.error && /^\d+\.\d+\.\d+/.test(version) ? version : null;
  return cachedProbedVersion;
}

// Failed or old version probes stay in the in-repo engine because an old CLI may treat unknown flags as FTS terms.
export function sessionsBinSupports(bin: string, minVersion: string): boolean {
  const version = probeSessionsVersion(bin);
  return version !== null && compareVersions(version, minVersion) >= 0;
}

export function sessionsBinSupportsFilters(bin: string): boolean {
  return sessionsBinSupports(bin, SESSIONS_FILTERS_MIN_VERSION);
}

export function sessionsBinSupportsHost(bin: string): boolean {
  return sessionsBinSupports(bin, SESSIONS_HOST_MIN_VERSION);
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

export function isReadQuery(args: string[], opts: { filters?: boolean; host?: boolean } = {}): boolean {
  if (args.length === 0) return false;
  const valueFlags = new Set(['--limit', '--agent']);
  const boolFlags = new Set(READ_FLAGS);
  if (opts.filters) {
    for (const vf of FILTER_VALUE_FLAGS) valueFlags.add(vf);
    for (const bf of FILTER_BOOL_FLAGS) boolFlags.add(bf);
  }
  if (opts.host) valueFlags.add('--host');
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
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

function scanDeviceFlag(args: string[]): { count: number; value?: string; valueEndIndex?: number } {
  let count = 0;
  let value: string | undefined;
  let valueEndIndex: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let matched = false;
    let v: string | undefined;
    let endIdx = i;
    if (a === '--device' || a === '-D') {
      matched = true;
      v = args[i + 1];
      endIdx = i + 1;
    } else if (a.startsWith('--device=')) {
      matched = true;
      v = a.slice('--device='.length);
    } else if (a.startsWith('-D=')) {
      matched = true;
      v = a.slice(3);
    } else if (/^-D.+/.test(a)) {
      matched = true;
      v = a.slice(2);
    }
    if (matched) {
      count += 1;
      if (count === 1) {
        value = v;
        valueEndIndex = endIdx;
      }
    }
  }
  return { count, value, valueEndIndex };
}

// Collapse --device to --host only for one unambiguous read; multi/fleet/lifecycle queries remain on in-repo fan-out.
export function planDeviceHostRead(
  args: string[],
  opts: { filters?: boolean } = {},
): { device: string; readArgs: string[] } | null {
  const { count, value, valueEndIndex } = scanDeviceFlag(args);
  if (count !== 1) return null;
  if (value === undefined || value === '' || value.startsWith('-')) return null;
  if (usesHostFlag(args)) return null;
  const lower = value.toLowerCase();
  if (lower === 'all' || lower === 'fleet') return null;
  const next = valueEndIndex !== undefined ? args[valueEndIndex + 1] : undefined;
  if (next !== undefined && !next.startsWith('-')) return null;
  const readArgs = stripRoutingFlags(args, [{ long: 'device', short: 'D', takesValue: true }]);
  if (!isReadQuery(readArgs, { filters: opts.filters })) return null;
  return { device: value, readArgs };
}

export function _resetSessionsClientForTest(): void {
  cachedBin = undefined;
  cachedProbedVersion = undefined;
}

export const SESSIONS_INSTALL_HINT = INSTALL_HINT;
