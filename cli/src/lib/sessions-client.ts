/** agents-cli's client for the standalone `sessions` CLI (PHNX-4012). Never falls back: a missing
 * binary throws `SESSIONS_BIN_MISSING` (DIST-1). Order: `$SESSIONS_BIN`, the dependency, PATH.
 * `findInPath` must skip `~/.agents/.cache/shims`: the `sessions` shim recurses (agi-cli#3532). */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { findInPath } from './agent-spec/agents.js';
import { compareVersions } from './agent-spec/primitives.js';
import { stripRoutingFlags } from './hosts/remote-cmd.js';

const INSTALL_HINT = 'npm i -g @phnx-labs/sessions-cli';

/** First `sessions` release with the metadata filters and sort (`-p`, `--since`, `--until`,
 * `--sort`, `@version`, harness shorthands). An older binary would treat them as FTS tokens, so
 * such a box keeps them on the in-repo engine. */
const SESSIONS_FILTERS_MIN_VERSION = '0.2.0';

/** First `sessions` release with the point-to-one remote read `--host <target>`. Older binaries
 * treat it as an FTS token, so `--host` queries stay on the in-repo engine. Separate from the
 * filter floor: 0.2.0 has filters but not `--host`. */
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

/** The `sessions` executable in the `@phnx-labs/sessions-cli` dependency. Its `exports` map
 * publishes only `./reader`, so `require.resolve` of the package, bin or package.json throws; walk
 * Node's lookup paths and read the bin field. */
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
  // Unset: the dependency this CLI ships, then PATH. Empty: PATH only, so a
  // harness can keep a read on the in-repo engine without a global `sessions`.
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

/** Allowlist of what sessions-cli v1 implements. Everything else (picker, `--since`, `-D`,
 * `--waiting`, `render`, `stats`, lifecycle verbs) stays on the in-repo engine. A denylist leaked
 * those through `allowUnknownOption()` (PR review, #3554). */
const READ_FLAGS = new Set([
  '--json',
  '--local',
  '--no-interactive',
]);

/** Boolean harness-shorthand flags added in 0.2.0 (`--claude` = `--agent claude`); read flags only
 * when the binary supports filters. */
const FILTER_BOOL_FLAGS = new Set([
  '--claude',
  '--codex',
  '--kimi',
  '--antigravity',
  '--grok',
  '--opencode',
]);

/** Value-taking filter flags added in 0.2.0 (next argv token or `--flag=value`).
 * `--agent`/`--limit` are the 0.1.x base set, handled unconditionally. */
const FILTER_VALUE_FLAGS = new Set([
  '--project',
  '--since',
  '--until',
  '--sort',
]);

/** True if any 0.2.0-only filter flag is present — one case that needs the version probe. */
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

/** True if the 0.2.1 remote read flag `--host <value>` (or `--host=value`) is present: the other
 * case needing the version probe, gated on its own floor. */
export function usesHostFlag(args: string[]): boolean {
  return args.some((arg) => arg === '--host' || arg.startsWith('--host='));
}

let cachedProbedVersion: string | null | undefined;

/** Probe `sessions --version` once per process (cached); null on failure or unparseable output. The
 * single cache keeps the filter and host gates to one spawn however many `sessionsBinSupports*`
 * calls a query makes. */
function probeSessionsVersion(bin: string): string | null {
  if (cachedProbedVersion !== undefined) return cachedProbedVersion;
  const { command, prefix } = invocation(bin);
  const res = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8', timeout: 3000 });
  const version = (res.stdout ?? '').trim();
  cachedProbedVersion = !res.error && /^\d+\.\d+\.\d+/.test(version) ? version : null;
  return cachedProbedVersion;
}

/** Whether the resolved `sessions` binary is at or above `minVersion`. A probe failure or
 * unparseable version reads as unsupported, the safe direction (in-repo engine), never a mis-route
 * to an old binary. */
export function sessionsBinSupports(bin: string, minVersion: string): boolean {
  const version = probeSessionsVersion(bin);
  return version !== null && compareVersions(version, minVersion) >= 0;
}

/** Whether the resolved `sessions` binary is new enough for the 0.2.0 filters. */
export function sessionsBinSupportsFilters(bin: string): boolean {
  return sessionsBinSupports(bin, SESSIONS_FILTERS_MIN_VERSION);
}

/** Whether the resolved `sessions` binary is new enough for the 0.2.1 `--host` flag. */
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
  // Base (0.1.x) value flags, always recognized; the 0.2.0 filter value flags
  // join them only when the binary supports filters, and the 0.2.1 `--host`
  // value flag only when the binary supports it (its own, higher floor).
  const valueFlags = new Set(['--limit', '--agent']);
  const boolFlags = new Set(READ_FLAGS);
  if (opts.filters) {
    for (const vf of FILTER_VALUE_FLAGS) valueFlags.add(vf);
    for (const bf of FILTER_BOOL_FLAGS) boolFlags.add(bf);
  }
  if (opts.host) valueFlags.add('--host');
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

/** Scan argv for `--device`/`-D`, which commander defines as variadic, so it can repeat and a
 * space-form value consumes following bare tokens. Returns the count, the first value, and the
 * index of the last token it occupies. Pure. */
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

/** Plan the rewrite of a `sessions` read naming exactly one device into the standalone's
 * point-to-one `--host ssh://<target>` (the caller resolves the target and gates on the local
 * binary supporting `--host`, >=0.2.1). Multi-device queries stay on the in-repo fan-out. */
export function planDeviceHostRead(
  args: string[],
  opts: { filters?: boolean } = {},
): { device: string; readArgs: string[] } | null {
  const { count, value, valueEndIndex } = scanDeviceFlag(args);
  // Exactly one occurrence, with a real (non-flag) value — else fall through.
  if (count !== 1) return null;
  if (value === undefined || value === '' || value.startsWith('-')) return null;
  if (usesHostFlag(args)) return null;
  const lower = value.toLowerCase();
  if (lower === 'all' || lower === 'fleet') return null;
  // A bare token after the value is a second variadic device (multi-device).
  const next = valueEndIndex !== undefined ? args[valueEndIndex + 1] : undefined;
  if (next !== undefined && !next.startsWith('-')) return null;
  const readArgs = stripRoutingFlags(args, [{ long: 'device', short: 'D', takesValue: true }]);
  if (!isReadQuery(readArgs, { filters: opts.filters })) return null;
  return { device: value, readArgs };
}

/** Test seam: drop the memoized bin so PATH fixtures can re-resolve. */
export function _resetSessionsClientForTest(): void {
  cachedBin = undefined;
  cachedProbedVersion = undefined;
}

export const SESSIONS_INSTALL_HINT = INSTALL_HINT;
