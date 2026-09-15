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
import { stripRoutingFlags } from './hosts/remote-cmd.js';

const INSTALL_HINT = 'npm i -g @phnx-labs/sessions-cli';

/**
 * First `sessions` release that implements the metadata filters and sort
 * (`-p/--project`, `--since`, `--until`, `--sort`, the `@version` agent suffix,
 * and the harness shorthands). An older binary would treat these as FTS tokens,
 * so a box with `sessions` < this floor keeps them on the in-repo engine (which
 * implements the same filters) rather than mis-routing to a binary that can't.
 */
const SESSIONS_FILTERS_MIN_VERSION = '0.2.0';

/**
 * First `sessions` release that implements the point-to-one remote read flag
 * `--host <target>` (SSH to ONE box, run `sessions … --local`, stream JSON back).
 * An older binary would treat `--host` as an FTS token, so a box with `sessions`
 * below this floor keeps a `--host` query on the in-repo engine (which resolves
 * `--device` against the fleet) rather than mis-routing it. Kept separate from the
 * filter floor above even though 0.3.0 ≥ 0.2.0 — a 0.2.0 binary supports the
 * filters but NOT `--host`, so the two gates are checked independently.
 */
const SESSIONS_HOST_MIN_VERSION = '0.3.0';

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

/**
 * True if the 0.3.0 point-to-one remote read flag `--host <value>` (or `--host=value`)
 * is present — the other case that needs the version probe, gated on its own floor.
 */
export function usesHostFlag(args: string[]): boolean {
  return args.some((arg) => arg === '--host' || arg.startsWith('--host='));
}

let cachedProbedVersion: string | null | undefined;

/**
 * Probe `sessions --version` ONCE per process (cached), returning the parsed
 * version string, or `null` when the probe fails or the output is unparseable.
 * The single cache is what keeps the filter and host gates to one spawn between
 * them, however many `sessionsBinSupports*` calls a query makes.
 */
function probeSessionsVersion(bin: string): string | null {
  if (cachedProbedVersion !== undefined) return cachedProbedVersion;
  const { command, prefix } = invocation(bin);
  const res = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8', timeout: 3000 });
  const version = (res.stdout ?? '').trim();
  cachedProbedVersion = !res.error && /^\d+\.\d+\.\d+/.test(version) ? version : null;
  return cachedProbedVersion;
}

/**
 * Whether the resolved `sessions` binary is at or above `minVersion`. A probe
 * failure or an unparseable version reads as unsupported — the safe direction
 * (in-repo engine handles it), never a mis-route to an old binary.
 */
export function sessionsBinSupports(bin: string, minVersion: string): boolean {
  const version = probeSessionsVersion(bin);
  return version !== null && compareVersions(version, minVersion) >= 0;
}

/** Whether the resolved `sessions` binary is new enough for the 0.2.0 filters. */
export function sessionsBinSupportsFilters(bin: string): boolean {
  return sessionsBinSupports(bin, SESSIONS_FILTERS_MIN_VERSION);
}

/** Whether the resolved `sessions` binary is new enough for the 0.3.0 `--host` flag. */
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
  // join them only when the binary supports filters, and the 0.3.0 `--host`
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

/**
 * Scan an argv for the `sessions` `--device`/`-D` flag, which commander defines
 * as VARIADIC (`-D, --device <target...>`) — so it can appear more than once and
 * a space-form value greedily consumes following bare tokens as extra devices.
 * Returns how many times it occurs, the FIRST value, and the index of the last
 * argv token that value occupies (the flag token itself for the `=`/glued forms,
 * the following value token for the space form). Pure; no imports.
 */
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

/**
 * Plan the rewrite of a `sessions` READ query that names EXACTLY ONE device via
 * `--device <name>` (and no explicit `--host`) into the standalone's
 * point-to-one remote read: the caller resolves the device to an ssh target and
 * appends `--host ssh://<target>` to `readArgs`, forwarding it to the LOCAL
 * standalone (which owns the ssh hop). This is the local-orchestration collapse
 * (secrets-cli model): `sessions` owns the remote read, replacing the in-repo
 * `--device` peer fan-out — WHEN it is safe (the caller gates on the LOCAL
 * standalone supporting `--host`, >=0.3.0, and falls through to the in-repo
 * fan-out if the PEER lacks the standalone).
 *
 * `sessions --host` is point-to-one, so ONLY a single unambiguous device may
 * collapse; a multi-device query MUST stay on the in-repo fan-out, which parses
 * commander's variadic `--device` correctly. Returns null (→ in-repo path,
 * unchanged) when the query is not a single-device read:
 *   - no `--device`/`-D`, or a missing/flag-shaped value;
 *   - `--device`/`-D` appears more than once (`--device box --device mac-mini`);
 *   - the value is a fan-out sentinel `all`/`fleet` (case-insensitive);
 *   - a bare token immediately follows the value (`--device box mac-mini`) —
 *     commander's variadic would take it as a second device, so this is
 *     multi-device too;
 *   - an explicit `--host` is already on the argv — it wins, matching `secrets`'
 *     `rewriteDeviceToHost`, so we never add a second `--host`;
 *   - the remaining query (with `--device` stripped) is not a read — a lifecycle
 *     `--device` (resume/watch/inject/focus/…) keeps its in-repo/`runOnPeer`
 *     behavior exactly.
 *
 * Pure and argv-only: fleet resolution (device → ssh target, via
 * `resolveRemoteDevice`) and the version gate live in the caller so this is unit
 * testable with real inputs. `filters` mirrors the caller's version gate for the
 * 0.2.0 filter flags (the `--device` token is not a filter flag, so it is
 * computed identically on the original argv and on `readArgs`).
 */
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
