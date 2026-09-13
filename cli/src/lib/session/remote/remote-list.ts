/**
 * Cross-machine fan-out for the default `agents sessions` listing.
 *
 * `discoverSessions()` only scans the local disk. To browse the whole fleet in
 * one list — without syncing anything — we run `agents sessions <same query>
 * --json` on each peer over SSH and merge the parsed `SessionMeta[]`, tagging
 * every row with the machine it came from so the picker/table can label and
 * group by computer.
 *
 * This is the browse-listing sibling of `remote-active.ts` (which fans out
 * `--active`): same transport, same device set, same recursion guard. The peer
 * runs with `AGENTS_SESSIONS_LOCAL=1` so it answers only for itself and the
 * sweep never recurses. A dead or slow host is skipped with a stderr note,
 * never fatal — one asleep laptop must not blank the list.
 */
import { spawn } from 'child_process';
import chalk from 'chalk';
import {
  SSH_OPTS,
  controlOpts,
  assertValidSshTarget,
  shellQuote,
  SSH_CONN_FAILURE_CODE,
  REMOTE_STDOUT_MAX_BYTES,
  RemoteUtf8Accumulator,
} from '../../ssh-exec.js';
import { connectionEndedNotice } from '../../hosts/reconnect.js';
import { sshTargetFor } from '../../devices/connect.js';
import { resolveExplicitTargetSet } from '../../devices/resolve-target.js';
import { loadDevices, isDialableDevice, type DeviceProfile } from '../../devices/registry.js';
import { remoteShellFor, buildWindowsAgentsCommand, stripClixml } from '../../hosts/remote-cmd.js';
import { gatherRemoteAgentsJson, type RemoteAgentsJsonParseResult } from '../../remote-agents-json.js';
import { machineId, normalizeHost } from '../sync/config.js';
import { NO_FANOUT_ENV } from '../remote-active.js';
import { terminalWidth } from '../../text/width.js';
import { sanitizeForTerminal } from '../../redact.js';
import { mapBounded } from '../../concurrency.js';
import type { SessionMeta } from '../types.js';
import {
  TOOL_QUERY_MAX_CLAUSE_BYTES,
  TOOL_QUERY_MAX_CALL_ROWS,
  TOOL_QUERY_MAX_CLAUSES,
  TOOL_QUERY_MAX_RESULT_SESSIONS,
  TOOL_QUERY_MAX_SERIALIZED_BYTES,
  serializedToolSearchEnvelopeBytes,
  type ToolCallEvidence,
  type ToolProgramCountEnvelope,
  type ToolSearchEnvelope,
  type ToolSessionEvidence,
} from '../tool-index.js';
import {
  TOOL_ERROR_OUTPUT_MAX_BYTES,
  TOOL_INPUT_MAX_BYTES,
  TOOL_SUCCESS_OUTPUT_MAX_BYTES,
  sanitizeToolEvidenceText,
} from '../tool-calls.js';

const REMOTE_TOOL_TIMEOUT_MS = 60_000;
// The per-peer stdout ceiling and the UTF-8-safe accumulator live in ssh-exec.ts
// (the shared SSH transport both this reader and the top-level `remote-agents-json`
// fan-out import), so the bound is defined once. Re-exported here for the existing
// consumers/tests that reach them through this module.
export { REMOTE_STDOUT_MAX_BYTES, RemoteUtf8Accumulator } from '../../ssh-exec.js';
export const REMOTE_TOOL_AGGREGATE_MAX_BYTES = TOOL_QUERY_MAX_SERIALIZED_BYTES;

export interface RemoteToolByteBudget {
  remainingBytes: number;
  exhausted: boolean;
}

/** Claim received bytes against one fleet-query budget before retaining them. */
export function consumeRemoteToolByteBudget(budget: RemoteToolByteBudget, bytes: number): boolean {
  if (budget.exhausted || bytes > budget.remainingBytes) {
    budget.remainingBytes = 0;
    budget.exhausted = true;
    return false;
  }
  budget.remainingBytes -= bytes;
  if (budget.remainingBytes === 0) budget.exhausted = true;
  return true;
}

/** Charge sanitized, machine-stamped evidence because redaction may expand it. */
export function consumeParsedRemoteToolSearchBudget(
  budget: RemoteToolByteBudget,
  envelope: ToolSearchEnvelope,
): boolean {
  return consumeRemoteToolByteBudget(budget, serializedToolSearchEnvelopeBytes(envelope));
}

/**
 * The command run on each peer: answer for itself, as JSON, without recursing.
 * `forwardedArgs` carry the caller's own query/filters (already including the
 * leading `sessions` and a `--json`) so each peer returns a comparable slice.
 * A Windows peer gets a PowerShell invocation (ssh lands in cmd.exe/PowerShell
 * there, where `bash -lc` is not a command); every other OS keeps `bash -lc`.
 */
export function remoteListCommand(forwardedArgs: string[], os?: string): string {
  if (remoteShellFor(os) === 'powershell') {
    return buildWindowsAgentsCommand({
      args: forwardedArgs,
      env: { [NO_FANOUT_ENV]: '1' },
    });
  }
  const inner = [`${NO_FANOUT_ENV}=1`, 'agents', ...forwardedArgs].map((t, i) =>
    i === 0 ? t : shellQuote(t),
  ).join(' ');
  return `bash -lc ${shellQuote(inner)}`;
}

/**
 * Parse a peer's `sessions --json` stdout into `SessionMeta[]`, tagging each
 * with `machine`. Defensive against version skew / partial output: non-JSON or
 * a non-array yields `[]`, and non-object entries are dropped rather than
 * throwing. The `machine` we dialed always wins over any value the peer set on
 * its own rows, so grouping keys off the computer we asked. Exported for unit
 * testing without a live tailnet.
 */
export function parseRemoteList(stdout: string, machine: string): SessionMeta[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripClixml(stdout));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((value) => value && typeof value === 'object' && !Array.isArray(value)
    ? [{ ...(value as SessionMeta), machine, _remote: true }]
    : []);
}

/** Strict parser used at the live peer boundary. A successful process with
 * malformed/non-array JSON is an incomplete source, not an empty machine. */
const SAFE_RESOLVER_KEYS = new Set([
  'id', 'shortId', 'agent', 'origin', 'timestamp', 'lastActivity', 'project',
  'version', 'harness', 'mode', 'label', 'topic', 'machine',
]);

function isSafeResolverRow(value: Record<string, unknown>): boolean {
  if (typeof value.id !== 'string' || typeof value.shortId !== 'string'
    || typeof value.agent !== 'string' || typeof value.timestamp !== 'string') return false;
  return Object.keys(value).every(key => SAFE_RESOLVER_KEYS.has(key));
}

export function parseRemoteListPayload(stdout: string, machine: string, safeResolver = false): {
  items: SessionMeta[];
  valid: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripClixml(stdout));
  } catch {
    return { items: [], valid: false };
  }
  if (!Array.isArray(parsed)) return { items: [], valid: false };
  const out: SessionMeta[] = [];
  for (const x of parsed) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return { items: [], valid: false };
    if (safeResolver && !isSafeResolverRow(x as Record<string, unknown>)) {
      return { items: [], valid: false };
    }
    // `_remote` marks these as living on the peer's disk (not a local mirror),
    // so the picker routes read/resume back over SSH instead of the local FS.
    out.push({ ...(x as SessionMeta), machine, _remote: true });
  }
  return { items: out, valid: true };
}

/** Run one remote `agents sessions … --json` and capture stdout. Resolves
 * `{ code: null }` on spawn error or timeout (host treated as dead). */
export function sshCapture(
  target: string,
  remoteCmd: string,
  timeoutMs: number,
  aggregateBudget?: RemoteToolByteBudget,
  options: { multiplex?: boolean; port?: number; hostKeyOpts?: string[] } = {},
): Promise<{ code: number | null; stdout: string; aggregateBudgetExceeded?: boolean }> {
  assertValidSshTarget(target);
  return new Promise((resolve) => {
    const args = [
      ...(options.hostKeyOpts ?? []),
      ...SSH_OPTS,
      ...(options.multiplex === false ? [] : controlOpts()),
      ...(options.port === undefined ? [] : ['-p', String(options.port)]),
      target,
      remoteCmd,
    ];
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const decoded = new RemoteUtf8Accumulator();
    let stdoutBytes = 0;
    let aggregateBudgetExceeded = false;
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = code === null ? decoded.current() : decoded.end();
      resolve({ code, stdout, aggregateBudgetExceeded: aggregateBudgetExceeded || undefined });
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(null); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (stdoutBytes + d.byteLength > REMOTE_STDOUT_MAX_BYTES) {
        child.kill('SIGKILL');
        done(null);
        return;
      }
      if (aggregateBudget && !consumeRemoteToolByteBudget(aggregateBudget, d.byteLength)) {
        aggregateBudgetExceeded = true;
        child.kill('SIGKILL');
        done(null);
        return;
      }
      stdoutBytes += d.byteLength;
      decoded.write(d);
    });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
  });
}

export interface RemoteListResult {
  sessions: SessionMeta[];
  /** How many peer machines we attempted to reach (drives the empty-fleet tip). */
  deviceCount: number;
  /**
   * Peers that failed to answer, by display name. The stderr note above is
   * enough for a printed listing, but the interactive browser repaints over it —
   * so callers rendering a full-screen UI need the outcome as data to tell
   * "that box is asleep" apart from "that box has no matching sessions".
   */
  unreachable: string[];
}

/** Keep browse and tool-search fan-out on the same automatic peer set. */
export function isAutomaticSessionPeer(d: DeviceProfile, self: string): boolean {
  if (!isDialableDevice(d)) return false;
  if (normalizeHost(d.name) === self) return false;
  return d.platform === 'windows' || d.platform === 'linux' || d.platform === 'macos';
}

/**
 * Gather listing sessions from other machines. With an explicit `hosts` list
 * (from `--device`), fan out to exactly those. Otherwise sweep the registered,
 * online devices from `ag devices`, excluding this machine and any without an
 * address. `forwardedArgs` are the caller's own sessions args (query + filters,
 * already `--json`) so every peer returns the same slice this machine asked for.
 */
export interface GatherRemoteListOptions {
  /**
   * Opt-in early-exit for a globally-unique id lookup (a full UUID): the first
   * peer to return the matching row resolves the fan-out and cancels the rest.
   * Omitted for browse/label/prefix sweeps, which must wait for every peer to
   * know whether the match is unique or conflicting.
   */
  isDefinitive?: (session: SessionMeta, machine: string) => boolean;
  /** Per-peer deadline for slower indexed browse queries. */
  timeoutMs?: number;
}

export async function gatherRemoteList(
  forwardedArgs: string[],
  hosts?: string[],
  opts?: GatherRemoteListOptions,
): Promise<RemoteListResult> {
  const safeResolver = forwardedArgs.includes('--resolve-safe-v1');
  const result = await gatherRemoteAgentsJson<SessionMeta>({
    args: forwardedArgs,
    noFanoutEnv: NO_FANOUT_ENV,
    hosts,
    timeoutMs: opts?.timeoutMs,
    earlyExit: opts?.isDefinitive ? { isDefinitive: opts.isDefinitive } : undefined,
    parse: (stdout, machine): RemoteAgentsJsonParseResult<SessionMeta> =>
      parseRemoteListPayload(stdout, machine, safeResolver),
  });
  return {
    sessions: result.items,
    deviceCount: result.deviceCount,
    unreachable: [
      ...(result.discoveryFailed ? ['device registry'] : []),
      ...result.skipped,
      ...result.parseFailed,
    ],
  };
}

export interface RemoteToolSearchResult {
  envelopes: Array<{ machine: string; envelope: ToolSearchEnvelope }>;
  deviceCount: number;
  unreachable: string[];
  truncated: string[];
}

export interface RemoteToolProgramCountResult {
  envelopes: Array<{ machine: string; envelope: ToolProgramCountEnvelope }>;
  deviceCount: number;
  unreachable: string[];
}

export function parseRemoteToolProgramCount(
  stdout: string,
  machine: string,
  expectedProgram: string,
): RemoteAgentsJsonParseResult<{ machine: string; envelope: ToolProgramCountEnvelope }> {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const query = parsed.query as Record<string, unknown> | undefined;
    const coverage = parsed.coverage as Record<string, unknown> | undefined;
    const totals = parsed.totals as Record<string, unknown> | undefined;
    const machines = parsed.machines;
    const coverageKeys = ['indexedFiles', 'indexedCalls', 'skippedFiles', 'limitedFiles', 'remainingFiles'] as const;
    const totalKeys = ['occurrences', 'toolCalls', 'sessions'] as const;
    if (parsed.schemaVersion !== 1 || parsed.kind !== 'tool-program-count'
      || !query || query.program !== expectedProgram || query.semantics !== 'static-program-occurrences-v1'
      || !coverage || typeof coverage.complete !== 'boolean'
      || coverageKeys.some((key) => !Number.isSafeInteger(coverage[key]) || (coverage[key] as number) < 0)
      || !totals || totalKeys.some((key) => !Number.isSafeInteger(totals[key]) || (totals[key] as number) < 0)
      || !Array.isArray(machines) || machines.length !== 1
      || boundedRemoteString(parsed.generatedAt, 128) === undefined) {
      return { items: [], valid: false };
    }
    return {
      valid: true,
      items: [{
        machine,
        envelope: {
          schemaVersion: 1,
          kind: 'tool-program-count',
          generatedAt: parsed.generatedAt as string,
          query: { program: expectedProgram, semantics: 'static-program-occurrences-v1' },
          coverage: coverage as unknown as ToolProgramCountEnvelope['coverage'],
          totals: totals as unknown as ToolProgramCountEnvelope['totals'],
          machines: [{
            machine,
            coverage: coverage as unknown as ToolProgramCountEnvelope['coverage'],
            totals: totals as unknown as ToolProgramCountEnvelope['totals'],
          }],
        },
      }],
    };
  } catch {
    return { items: [], valid: false };
  }
}

export async function gatherRemoteToolProgramCounts(
  forwardedArgs: string[],
  hosts: string[] | undefined,
  expectedProgram: string,
): Promise<RemoteToolProgramCountResult> {
  const result = await gatherRemoteAgentsJson<{ machine: string; envelope: ToolProgramCountEnvelope }>({
    args: forwardedArgs,
    noFanoutEnv: NO_FANOUT_ENV,
    hosts,
    timeoutMs: REMOTE_TOOL_TIMEOUT_MS,
    parse: (stdout, machine) => parseRemoteToolProgramCount(stdout, machine, expectedProgram),
  });
  return {
    envelopes: result.items,
    deviceCount: result.deviceCount,
    unreachable: [
      ...(result.discoveryFailed ? ['device registry'] : []),
      ...result.skipped,
      ...result.parseFailed,
    ],
  };
}

function boundedRemoteString(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maxBytes) return undefined;
  return sanitizeToolEvidenceText(value, maxBytes);
}

function optionalRemoteString(value: unknown, maxBytes: number): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return boundedRemoteString(value, maxBytes) ?? null;
}

function parseRemoteCall(value: unknown): ToolCallEvidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const call = value as Record<string, unknown>;
  const id = boundedRemoteString(call.id, 512);
  const timestamp = boundedRemoteString(call.timestamp, 128);
  const tool = boundedRemoteString(call.tool, 512);
  const input = boundedRemoteString(call.input, TOOL_INPUT_MAX_BYTES);
  const sourceCallId = optionalRemoteString(call.sourceCallId, 512);
  const output = optionalRemoteString(call.output, TOOL_SUCCESS_OUTPUT_MAX_BYTES);
  const error = optionalRemoteString(call.error, TOOL_ERROR_OUTPUT_MAX_BYTES);
  const errorCode = optionalRemoteString(call.errorCode, 512);
  const parseError = optionalRemoteString(call.parseError, 1024);
  if (call.programs !== undefined
    && (!Array.isArray(call.programs) || call.programs.length > 128)) return undefined;
  const programs = Array.isArray(call.programs)
    ? call.programs.map((program) => boundedRemoteString(program, 512))
    : [];
  if (!Array.isArray(call.programOccurrences) || call.programOccurrences.length > 10_000) return undefined;
  const programOccurrences = call.programOccurrences.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const occurrence = value as Record<string, unknown>;
    const program = boundedRemoteString(occurrence.program, 512);
    if (!program || (occurrence.role !== 'wrapper' && occurrence.role !== 'effective')) return undefined;
    return { program, role: occurrence.role };
  });
  if (!id || !timestamp || !tool || input === undefined
    || !Number.isSafeInteger(call.ordinal) || (call.ordinal as number) < 0
    || !['ok', 'error', 'unknown'].includes(String(call.outcome))
    || sourceCallId === null || output === null || error === null || errorCode === null || parseError === null
    || programs.some((program) => program === undefined)
    || programOccurrences.some((occurrence) => occurrence === undefined)) return undefined;
  for (const code of [call.exitCode, call.statusCode]) {
    if (code !== undefined && (!Number.isSafeInteger(code) || (code as number) < 0)) return undefined;
  }
  return {
    id,
    ordinal: call.ordinal as number,
    sourceCallId,
    timestamp,
    tool,
    programs: programs as string[],
    programOccurrences: programOccurrences as ToolCallEvidence['programOccurrences'],
    input,
    outcome: call.outcome as ToolCallEvidence['outcome'],
    exitCode: call.exitCode as number | undefined,
    statusCode: call.statusCode as number | undefined,
    errorCode,
    output,
    error,
    parseError,
  };
}

function parseRemoteToolSession(value: unknown, machine: string): ToolSessionEvidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const session = value as Record<string, unknown>;
  const id = boundedRemoteString(session.id, 512);
  const shortId = boundedRemoteString(session.shortId, 128);
  const agent = boundedRemoteString(session.agent, 128);
  const timestamp = boundedRemoteString(session.timestamp, 128);
  const project = optionalRemoteString(session.project, 4096);
  const cwd = optionalRemoteString(session.cwd, 4096);
  const topic = optionalRemoteString(session.topic, 4096);
  const label = optionalRemoteString(session.label, 4096);
  const originMachine = optionalRemoteString(session.machine, 512);
  const dialedMachine = boundedRemoteString(machine, 512);
  if (!id || !shortId || !agent || !timestamp || !dialedMachine || originMachine === null
    || project === null || cwd === null || topic === null || label === null
    || !Array.isArray(session.calls) || session.calls.length > TOOL_QUERY_MAX_CALL_ROWS) return undefined;
  const calls = session.calls.map(parseRemoteCall);
  if (calls.some((call) => call === undefined)) return undefined;
  return {
    id,
    shortId,
    agent,
    machine: originMachine ?? dialedMachine,
    timestamp,
    project,
    cwd,
    topic,
    label,
    calls: calls as ToolCallEvidence[],
  };
}

export function parseRemoteToolSearch(
  stdout: string,
  machine: string,
  expectedClauses?: string[],
): ToolSearchEnvelope | undefined {
  // The fleet tool-search fan-out reads a raw sshCapture (not the stripped
  // gatherRemoteAgentsJson wrapper), so a Windows peer's PowerShell CLIXML banner
  // must be removed here too or the box reads as "no envelope" (RUSH-2286).
  stdout = stripClixml(stdout);
  if (Buffer.byteLength(stdout) > REMOTE_STDOUT_MAX_BYTES) return undefined;
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const coverage = parsed?.coverage as Record<string, unknown> | undefined;
    const query = parsed?.query as Record<string, unknown> | undefined;
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.sessions)
      || parsed.sessions.length > TOOL_QUERY_MAX_RESULT_SESSIONS || !coverage || !query
      || !Array.isArray(query.clauses) || query.clauses.length > TOOL_QUERY_MAX_CLAUSES
      || query.clauses.some((clause) => boundedRemoteString(clause, TOOL_QUERY_MAX_CLAUSE_BYTES) === undefined)) return undefined;
    let totalCalls = 0;
    for (const sessionValue of parsed.sessions) {
      if (!sessionValue || typeof sessionValue !== 'object' || Array.isArray(sessionValue)) return undefined;
      const calls = (sessionValue as Record<string, unknown>).calls;
      if (!Array.isArray(calls) || calls.length > TOOL_QUERY_MAX_CALL_ROWS) return undefined;
      totalCalls += calls.length;
      if (totalCalls > TOOL_QUERY_MAX_CALL_ROWS) return undefined;
    }
    const clauses = query.clauses.map((clause) => sanitizeForTerminal(clause as string));
    const expected = expectedClauses?.map((clause) => sanitizeForTerminal(clause));
    if (expected && (clauses.length !== expected.length
      || clauses.some((clause, index) => clause !== expected[index]))) return undefined;
    const coverageNumbers = ['indexedFiles', 'indexedCalls', 'skippedFiles', 'limitedFiles', 'remainingFiles'] as const;
    if (coverageNumbers.some((key) => !Number.isSafeInteger(coverage[key]) || (coverage[key] as number) < 0)
      || typeof coverage.complete !== 'boolean') return undefined;
    const sessions = parsed.sessions.map((session) => parseRemoteToolSession(session, machine));
    const generatedAt = boundedRemoteString(parsed.generatedAt, 128);
    if (!generatedAt || sessions.some((session) => session === undefined)) return undefined;
    return {
      schemaVersion: 1,
      generatedAt,
      query: { clauses },
      coverage: {
        indexedFiles: coverage.indexedFiles as number,
        indexedCalls: coverage.indexedCalls as number,
        skippedFiles: coverage.skippedFiles as number,
        limitedFiles: coverage.limitedFiles as number,
        remainingFiles: coverage.remainingFiles as number,
        complete: coverage.complete,
      },
      sessions: sessions as ToolSessionEvidence[],
    };
  } catch {
    return undefined;
  }
}

/**
 * Fleet sibling of {@link gatherRemoteList} for the versioned tool-search
 * envelope. Each peer executes the same local-only query against its own
 * SQLite index; only compact matches cross SSH.
 */
export async function gatherRemoteToolSearch(
  forwardedArgs: string[],
  hosts?: string[],
  maxAggregateBytes = REMOTE_TOOL_AGGREGATE_MAX_BYTES,
  expectedClauses: string[] = [],
): Promise<RemoteToolSearchResult> {
  const self = machineId();
  const targets: Array<{ target: string; machine: string; name: string; os?: string }> = [];
  const unresolved: string[] = [];
  if (hosts && hosts.length > 0) {
    const resolved = await resolveExplicitTargetSet(hosts);
    targets.push(...resolved.targets);
    unresolved.push(...resolved.unresolved);
  } else {
    let reg: Record<string, DeviceProfile>;
    try {
      reg = await loadDevices();
    } catch {
      return { envelopes: [], deviceCount: 0, unreachable: ['device registry'], truncated: [] };
    }
    for (const d of Object.values(reg)) {
      if (!isAutomaticSessionPeer(d, self)) continue;
      try {
        targets.push({ target: sshTargetFor(d), machine: normalizeHost(d.name), name: d.name, os: d.platform });
      } catch {
        // A registered control record without a dialable address is not a query target.
      }
    }
  }

  const remainingBytes = Math.max(0, Math.min(REMOTE_TOOL_AGGREGATE_MAX_BYTES, maxAggregateBytes));
  const aggregateBudget: RemoteToolByteBudget = {
    remainingBytes,
    exhausted: remainingBytes === 0,
  };
  const parsedBudget: RemoteToolByteBudget = {
    remainingBytes,
    exhausted: remainingBytes === 0,
  };
  const results = await mapBounded(targets, async (target) => {
      if (aggregateBudget.exhausted) return { target, truncated: target.name };
      const capture = await sshCapture(
        target.target,
        remoteListCommand(forwardedArgs, target.os),
        REMOTE_TOOL_TIMEOUT_MS,
        aggregateBudget,
        // A tool-index deadline must own the SSH connection. Killing a
        // multiplexed child would leave its remote command running on the
        // persistent control master.
        { multiplex: false },
      );
      if (capture.aggregateBudgetExceeded) return { target, truncated: target.name };
      if (capture.code !== 0) return { target, unreachable: target.name };
      const envelope = parseRemoteToolSearch(capture.stdout, target.machine, expectedClauses);
      if (!envelope) return { target, unreachable: target.name };
      if (!consumeParsedRemoteToolSearchBudget(parsedBudget, envelope)) {
        return { target, truncated: target.name };
      }
      return { target, envelope };
    }, { concurrency: 6 });
  for (const result of results) {
    if (result.unreachable) {
      process.stderr.write(chalk.gray(`  ${result.unreachable}: unreachable, incompatible, or no agents CLI — skipped\n`));
    }
    if (result.truncated) {
      process.stderr.write(chalk.gray(`  ${result.truncated}: fleet tool-result budget exhausted — skipped\n`));
    }
  }
  return {
    envelopes: results.flatMap((result) => result.envelope
      ? [{ machine: result.target.machine, envelope: result.envelope }]
      : []),
    deviceCount: targets.length,
    unreachable: [...unresolved, ...results.map((result) => result.unreachable).filter((name): name is string => !!name)],
    truncated: results.map((result) => result.truncated).filter((name): name is string => !!name),
  };
}

/** Resolve a peer's SSH target (and OS) from the device registry by its
 * normalized machine id — the same id the fan-out tags rows with. Returns
 * undefined when no registered device with an address matches. */
export async function resolvePeerTarget(machine: string): Promise<{ target: string; os?: string } | undefined> {
  let reg: Record<string, DeviceProfile>;
  try {
    reg = await loadDevices();
  } catch {
    return undefined;
  }
  for (const d of Object.values(reg)) {
    if (normalizeHost(d.name) !== machine) continue;
    try {
      return { target: sshTargetFor(d), os: d.platform };
    } catch {
      return undefined; // matched the machine, but it has no address to dial
    }
  }
  return undefined;
}

/** Interactive ceiling for a picker-driven peer preview fetch. Tighter than the
 * fan-out's 60s: the user is arrowing through rows, and a peer that can't
 * answer a one-session digest in this window should degrade to the metadata
 * card rather than hold a "fetching…" pane open. */
const PEER_PREVIEW_TIMEOUT_MS = 15_000;

/**
 * Fetch one remote session's preview digest from its owning peer — the data
 * behind the picker pane for a `_remote` row, whose transcript file this
 * machine cannot parse. Runs the peer's own `agents sessions preview <id>
 * --local --json` (the same envelope `agents sessions preview` already
 * delegates to for a remote id) and returns its `preview` object, verbatim and
 * UNSANITIZED — the caller owns scrubbing peer-supplied strings before any of
 * them reach a TTY. Undefined on every failure: unregistered machine, SSH
 * error, timeout, version-skewed peer with no `--json` preview envelope.
 */
export async function fetchPeerPreviewDigest(
  sessionId: string,
  machine: string,
  timeoutMs = PEER_PREVIEW_TIMEOUT_MS,
): Promise<unknown | undefined> {
  const peer = await resolvePeerTarget(machine);
  if (!peer) return undefined;
  const cmd = remoteListCommand(['sessions', 'preview', sessionId, '--local', '--json'], peer.os);
  const capture = await sshCapture(peer.target, cmd, timeoutMs);
  if (capture.code !== 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripClixml(capture.stdout));
  } catch {
    return undefined;
  }
  return parsePeerPreviewDigest(parsed);
}

/** Parse the JSON envelope returned by `sessions preview --json`. */
export function parsePeerPreviewDigest(parsed: unknown): unknown | undefined {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const preview = (parsed as { preview?: unknown }).preview;
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return undefined;
  return preview;
}

/**
 * Run `agents <args>` ON a peer over SSH, attached to this terminal (inherited
 * stdio). `args` is the full arg vector after the binary — callers pass e.g.
 * `['sessions', id, '--markdown']` or `['sessions', 'resume', id]`. Used when a
 * picked session lives on another machine: its transcript and agent binary are
 * there, so both reading (no TTY) and resuming (TTY) must execute on the peer —
 * not via a local `--device` hop, which would discover locally and dead-end for a
 * session that exists only on the peer. Resolves 'no-target' when the machine
 * isn't a dialable registered device; the caller surfaces a clear message.
 *
 * `opts.env` adds variables to the remote command. It deliberately does NOT
 * carry `AGENTS_FLEET_REMOTE` the way the `--device` passthrough does: that marker
 * gates consent-sensitive actions on the far side
 * (lib/browser/remote-control.ts), and a resumed agent is a long-lived session
 * that would inherit it for its whole life — `agents browser start` inside it
 * would then be refused as a cross-machine drive. A one-shot `--device` command
 * can carry the marker; a session cannot.
 *
 * `opts.sessionId` (with `tty`) prints the session id and resume command when
 * the SSH hop ends, so OpenSSH's `Shared connection … closed.` is not the last
 * thing on the local shell (RUSH-3227). Omit it for one-shot non-TTY renders.
 *
 * Resolves `'unreachable'` when the SSH connection itself failed — ssh could not
 * launch (spawn error) or exited with {@link SSH_CONN_FAILURE_CODE} (255, its
 * connect-failure convention) — as opposed to `'ok'` for a hop that actually
 * reached the peer (whatever the remote command's own exit code). This lets a
 * caller prefer the recorded device yet fall back locally when it is genuinely
 * offline (PHNX-3626); callers that ignore `'unreachable'` behave exactly as
 * before (it was `'ok'`).
 */
/**
 * Classify a finished SSH hop by its exit code: `'unreachable'` when the
 * connection itself failed (ssh's {@link SSH_CONN_FAILURE_CODE} = 255, or a null
 * code from a killed/never-launched child), else `'ok'` — the remote command ran,
 * whatever its own exit status. Pure so the offline-device fallback is unit-tested
 * without a live SSH hop (PHNX-3626).
 */
export function peerHopOutcome(code: number | null): 'ok' | 'unreachable' {
  return code === SSH_CONN_FAILURE_CODE || code === null ? 'unreachable' : 'ok';
}

export function peerHopCloseNotice(
  opts: { tty?: boolean; sessionId?: string },
  machine: string,
  code: number | null,
): string | undefined {
  if (!opts.tty || !opts.sessionId) return undefined;
  return connectionEndedNotice(
    { kind: 'session', id: opts.sessionId },
    machine,
    { dropped: code === SSH_CONN_FAILURE_CODE },
  );
}

export async function runOnPeer(
  args: string[],
  machine: string,
  opts: { tty?: boolean; env?: Record<string, string>; sessionId?: string } = {},
): Promise<'ok' | 'no-target' | 'unreachable'> {
  const peer = await resolvePeerTarget(machine);
  if (!peer) return 'no-target';
  assertValidSshTarget(peer.target); // registry-sourced, but validate like the fan-out does

  const cols = terminalWidth();
  const env: Record<string, string> = { ...(cols > 0 ? { COLUMNS: String(cols) } : {}), ...opts.env };
  const assignments = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  const invocation = assignments.concat(['agents', ...args].map(shellQuote)).join(' ');
  // OpenSSH uses 255 for transport failure, but also propagates a reached remote
  // program's 255 verbatim. Remap only the remote program's 255 inside the peer
  // shell so the outer SSH status remains an unambiguous connectivity signal.
  const remoteCmd = remoteShellFor(peer.os) === 'powershell'
    ? buildWindowsAgentsCommand({ args, env: assignments.length ? env : undefined, remapExit255: true })
    : `bash -lc ${shellQuote(`${invocation}; agents_rc=$?; if [ "$agents_rc" -eq 255 ]; then exit 254; fi; exit "$agents_rc"`)}`;

  const sshArgs = [...SSH_OPTS, ...controlOpts()];
  if (opts.tty) sshArgs.push('-tt'); // force a PTY so the resumed agent is interactive
  sshArgs.push(peer.target, remoteCmd);

  return new Promise((resolve) => {
    const child = spawn('ssh', sshArgs, { stdio: 'inherit' });
    // ssh prints its own connection errors to the inherited stderr; a spawn
    // failure (e.g. ssh not on PATH) has no such output, so name it. Either way
    // we resolve once it settles so the picker flow completes.
    child.on('error', (err: any) => {
      process.stderr.write(chalk.red(`Failed to reach ${machine}: ${err?.message ?? 'ssh failed to launch'}\n`));
      resolve('unreachable');
    });
    child.on('close', (code) => {
      // Interactive TTY hop: OpenSSH prints "Shared connection … closed." and
      // nothing else. Leave the session id on the local shell (RUSH-3227).
      const notice = peerHopCloseNotice(opts, machine, code);
      if (notice) process.stderr.write(notice);
      // ssh exits 255 only when the connection itself failed (host down/asleep),
      // distinct from the remote command's own non-zero exit. Report that so a
      // caller can fall back locally instead of silently completing.
      resolve(peerHopOutcome(code));
    });
  });
}
