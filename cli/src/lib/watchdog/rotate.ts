/**
 * Watchdog rotate — in-place rotation of a rate-limited session onto a healthy
 * account/harness, inside the SAME terminal tab (one-watchdog; follow-up to
 * RUSH-2132 / PR #1875).
 *
 * When a stalled session's transcript tail shows a hard limit ("You've hit your
 * weekly limit · resets …"), the daemon watchdog rotates it instead of nudging:
 *
 *   1. DETECT  — classifyTailForRotate() matches the tail against the limit
 *      patterns (ported from apps/ext/src/core/autoRotate.ts) and parses the
 *      `resets <time>` clause when present.
 *   2. GATE    — defaultRotateGate() runs the SAME first-party selection
 *      `agents run auto` would (collectHarnessCandidates + pickHarnessWeighted,
 *      ../rotate.ts). Zero healthy → ONE `rotate` skip event per cooldown window
 *      and the terminal is left untouched. No `agents view` subprocess anywhere.
 *   3. RELAUNCH — the per-harness exit sequence (ported from apps/ext
 *      prewarm.ts PREWARM_CONFIGS) is injected, then
 *      `agents run auto --interactive --session-id <uuid>`.
 *   4. REPLAY   — when the new session's TUI is live (bounded wait, default
 *      60s), the resume replay is injected. On timeout the session is flagged
 *      and the machine stops — never blind-type into a dead shell.
 *
 * The machine spans ticks (the exit sequence kills the old session, so it drops
 * out of the active-session list before the new TUI is live): state persists at
 * <watchdog-state>/rotate/<sessionId>.json as
 * exiting → launching → awaiting-tui → replaying → done | failed.
 *
 * Config: `watchdog.rotate: on|off` in agents.yaml (default on), read per tick.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { InjectTarget } from '../terminal/index.js';
import type { ActiveSession } from '../session/active.js';
import { readMeta, writeMeta } from '../state.js';
import {
  collectHarnessCandidates,
  classifyHarnessCandidates,
  pickHarnessWeighted,
  earliestResetAcross,
  formatNoHealthyHarnessError,
} from '../accounting/rotate.js';
import { resolveWatchdogSessionPath } from './read.js';

// --- detection ---------------------------------------------------------------

/**
 * Agent-reported hard-limit texts, matched against a session transcript tail.
 * Ported verbatim from apps/ext/src/core/autoRotate.ts RATE_LIMIT_PATTERNS —
 * kept specific on purpose: a transcript carries prose, so a loose "rate limit"
 * match would rotate terminals whose agent merely DISCUSSED limits. The first
 * two patterns cover the weekly/session variants, including claude's
 * "You've hit your weekly limit · resets <time>" form.
 */
const ROTATE_LIMIT_PATTERNS: RegExp[] = [
  /you'?ve hit your [\w-]*\s?limit/i,
  /hit your (weekly|daily|usage|session) limit/i,
  /usage limit (has been )?(reached|exceeded)/i,
  /rate limit (reached|exceeded)/i,
  /out of (credits|extra usage)/i,
];

type RotateTailVerdict =
  | { kind: 'none' }
  | { kind: 'rate_limited'; resetsAtMs?: number };

/**
 * Classify a transcript tail for the rotate decision: does it show a hard
 * account limit (rotate this session) or not (leave it to the nudge path)?
 * Unlike the retired extension path there is NO `no healthy` tail parsing here —
 * the health gate is a first-party function call (defaultRotateGate), not a
 * cross-package string contract.
 */
export function classifyTailForRotate(tailLines: string[], nowMs: number): RotateTailVerdict {
  if (tailLines.length === 0) return { kind: 'none' };
  const tail = tailLines.join('\n');
  if (ROTATE_LIMIT_PATTERNS.some((p) => p.test(tail))) {
    return { kind: 'rate_limited', resetsAtMs: parseRotateResetMs(tail, nowMs) };
  }
  return { kind: 'none' };
}

/**
 * Parse the `resets <time>` clause of a limit line into an epoch-ms horizon.
 * Ported from apps/ext/src/core/autoRotate.ts parseResetTimeMs (behavior
 * verbatim): the ISO form (milliseconds + Z) is matched EXPLICITLY and first —
 * a generic capture stops at the milliseconds dot and drops the Z, which makes
 * Date.parse read LOCAL time (the suppression would end hours off). Time-of-day
 * forms like `7am` / `7:30pm` with an optional `(Area/City)` IANA zone cover
 * claude's own limit text. Returns undefined when no usable reset is present or
 * the parsed time is already past (caller falls back to its default cooldown).
 */
export function parseRotateResetMs(text: string, nowMs: number): number | undefined {
  const iso = /resets\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\b/i.exec(text);
  if (iso) {
    const parsedIso = Date.parse(iso[1]);
    return Number.isNaN(parsedIso) || parsedIso <= nowMs ? undefined : parsedIso;
  }

  const m = /resets\s+([^.;!\n]+)/i.exec(text);
  if (!m) return undefined;
  const segment = m[1].trim();
  const timeZone = /\(([A-Za-z_]+\/[A-Za-z_]+)\)/.exec(segment)?.[1];
  const timePart = segment.replace(/\([A-Za-z_]+\/[A-Za-z_]+\)/, '').trim();

  const parsed = Date.parse(timePart);
  if (!Number.isNaN(parsed)) {
    return parsed > nowMs ? parsed : undefined;
  }

  const t = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(timePart);
  if (!t) return undefined;
  let hour = parseInt(t[1], 10) % 12;
  if (t[3].toLowerCase() === 'pm') hour += 12;
  const minute = t[2] ? parseInt(t[2], 10) : 0;
  return nextOccurrenceMs(hour, minute, timeZone, nowMs);
}

/** Next wall-clock occurrence of hour:minute in the given zone after nowMs. */
function nextOccurrenceMs(
  hour: number,
  minute: number,
  timeZone: string | undefined,
  nowMs: number,
): number | undefined {
  try {
    if (!timeZone) {
      const d = new Date(nowMs);
      d.setHours(hour, minute, 0, 0);
      if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    // Wall-clock "now" in the target zone, to minute precision — close enough
    // for a cooldown horizon.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(nowMs));
    const get = (type: string): number =>
      parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
    const year = get('year');
    const month = get('month') - 1;
    const day = get('day');
    const wallNowMs = Date.UTC(year, month, day, get('hour') % 24, get('minute'));
    const offsetMs = wallNowMs - nowMs;
    let candidate = Date.UTC(year, month, day, hour, minute) - offsetMs;
    if (candidate <= nowMs) candidate += 24 * 60 * 60 * 1000;
    return candidate;
  } catch {
    return undefined;
  }
}

// --- exit sequences ------------------------------------------------------------

/**
 * Clean-exit key sequences per harness, ported verbatim from apps/ext
 * prewarm.ts PREWARM_CONFIGS. Injected as RAW BYTES with no trailing Enter — a
 * literal \x03 written to the pty IS Ctrl+C (SIGINT), \x1b IS Esc. claude's Ink
 * TUI needs the Esc first to leave any open mode before the interrupt pair.
 */
export const ROTATE_EXIT_SEQUENCES: Record<string, string[]> = {
  claude: ['\x1b', '\x03', '\x03'], // Esc, Ctrl+C, Ctrl+C (Esc first for Claude)
  codex: ['\x03', '\x03'], // Ctrl+C twice
  gemini: ['\x03', '\x03'],
  cursor: ['\x03', '\x03'],
  opencode: ['\x03', '\x03'],
};

/** Unknown harnesses get the common denominator: Ctrl+C twice. */
export const DEFAULT_ROTATE_EXIT_SEQUENCE: string[] = ['\x03', '\x03'];

export function exitSequenceFor(agent: string): string[] {
  return ROTATE_EXIT_SEQUENCES[agent] ?? DEFAULT_ROTATE_EXIT_SEQUENCE;
}

// --- launch + replay text ------------------------------------------------------

/**
 * The rotate relaunch, typed into the same tab: full auto — the CLI resolves
 * host (affinity) → harness (cross-harness headroom) → account (balanced) and
 * exits nonzero when every layer is exhausted. Ported from apps/ext
 * autoRotate.ts buildAutoRotateLaunchCommand. A terminal on a REMOTE device
 * rotates ON that device (`--device`); a local terminal omits it. `--session-id`
 * is honored only when the CLI picks claude (existing claude-only semantics)
 * and ignored otherwise — passing it unconditionally keeps the terminal's
 * AGENT_SESSION_ID aligned with the session Claude actually creates.
 */
export function buildRotateLaunchCommand(opts: { host?: string; sessionId: string }): string {
  let cmd = 'agents run auto --interactive';
  if (opts.host) {
    cmd += ` --device ${shellQuoteHost(opts.host)}`;
  }
  cmd += ` --session-id ${opts.sessionId}`;
  return cmd;
}

/** Single-quote a device name so it can never break out of the built command. */
function shellQuoteHost(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The harness-agnostic replay injected once the new TUI is live: load the OLD
 * session's transcript, assess, continue. This is the same instruction shape
 * the CLI's own `continue` flow uses.
 */
export function buildRotateReplayText(oldSessionId: string): string {
  return (
    `Resume previous work by loading session ${oldSessionId}. ` +
    `Run \`agents sessions ${oldSessionId}\` to load the transcript, assess current state, then continue working.`
  );
}

// --- state machine -------------------------------------------------------------

export type RotatePhase =
  | 'exiting' // exit sequence injected, old harness on its way down
  | 'launching' // `agents run auto` injected
  | 'awaiting-tui' // bounded wait for the new session's TUI to come live
  | 'replaying' // replay inject in flight
  | 'done'
  | 'failed';

/** Persisted at <watchdog-state>/rotate/<sessionId>.json — keyed by the OLD session id. */
export interface RotateState {
  /** The OLD (rate-limited) session id — the file key and the replay target. */
  sessionId: string;
  /** The id passed to `--session-id` on the relaunch. */
  newSessionId: string;
  /** The harness that was rate-limited (drives the exit-sequence table). */
  agent: string;
  phase: RotatePhase;
  /** The resolved inject target — serializable, so the sweep can replay without re-resolving. */
  target: InjectTarget;
  /** Remote device the terminal lives on, when provenance says ssh. */
  host?: string;
  /**
   * The old session's cwd — correlates the readiness fallback: a fresh active
   * session only counts as the relaunched TUI when it runs in the SAME project.
   */
  cwd?: string;
  /**
   * The machine the old session runs on (provenance host = os.hostname()) —
   * the second half of the readiness-fallback correlation, so a fresh session
   * on ANOTHER box never satisfies it.
   */
  machineHost?: string;
  startedAtMs: number;
  updatedAtMs: number;
  /** awaiting-tui deadline: startedAtMs + readiness budget. */
  deadlineMs: number;
  error?: string;
  /**
   * Set on the transition to `failed`: the tick will not re-begin a rotate for
   * this session until then (default +15m). Without it a session whose old TUI
   * ignored the exit sequence re-enters begin → deadline → failed every tick.
   */
  suppressUntilMs?: number;
}

/** Bounded wait for the relaunched TUI to come live (readiness). */
export const DEFAULT_ROTATE_READINESS_MS = 60_000;
/** Zero-healthy skip cooldown when neither the gate nor the tail carries a reset. */
export const DEFAULT_ROTATE_SKIP_COOLDOWN_MS = 30 * 60_000;
/** Retry cooldown after a FAILED rotate — honored at begin via the state file. */
export const DEFAULT_ROTATE_FAILED_COOLDOWN_MS = 15 * 60_000;

function rotateDir(dir: string): string {
  return path.join(dir, 'rotate');
}

function rotateStatePath(dir: string, sessionId: string): string {
  return path.join(rotateDir(dir), `${sessionId}.json`);
}

export function readRotateState(dir: string, sessionId: string): RotateState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(rotateStatePath(dir, sessionId), 'utf8')) as RotateState;
    return parsed && typeof parsed.sessionId === 'string' && typeof parsed.phase === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeRotateState(dir: string, state: RotateState): void {
  try {
    fs.mkdirSync(rotateDir(dir), { recursive: true });
    fs.writeFileSync(rotateStatePath(dir, state.sessionId), JSON.stringify(state, null, 2));
  } catch {
    /* best-effort: the tray tolerates a missing/partial state file */
  }
}

/** A phase the machine still has work to do in (done/failed are terminal). */
export function isInflightPhase(phase: RotatePhase): boolean {
  return phase !== 'done' && phase !== 'failed';
}

/** Every persisted rotate state (any phase) — for `watchdog status`. */
export function listRotateStates(dir: string): RotateState[] {
  let files: string[];
  try {
    files = fs.readdirSync(rotateDir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: RotateState[] = [];
  for (const f of files) {
    const s = readRotateState(dir, f.slice(0, -'.json'.length));
    if (s) out.push(s);
  }
  return out;
}

/** In-flight rotates only — the set a tick's sweep must advance. */
export function listInflightRotates(dir: string): RotateState[] {
  return listRotateStates(dir).filter((s) => isInflightPhase(s.phase));
}

// --- zero-healthy skip ledger ----------------------------------------------------

/**
 * One `rotate` skip event per cooldown window, tracked as
 * <watchdog-state>/rotate-skips.json: { [sessionId]: suppressUntilMs }. A skip
 * inside the window logs nothing and touches nothing.
 */
function readRotateSkipLedger(dir: string): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'rotate-skips.json'), 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

/** True when a skip for this session is OUTSIDE its suppression window (log it). */
export function shouldLogRotateSkip(dir: string, sessionId: string, nowMs: number): boolean {
  return (readRotateSkipLedger(dir)[sessionId] ?? 0) <= nowMs;
}

/** Suppress further skip events for this session until suppressUntilMs. */
export function recordRotateSkip(dir: string, sessionId: string, suppressUntilMs: number): void {
  try {
    const ledger = readRotateSkipLedger(dir);
    ledger[sessionId] = suppressUntilMs;
    fs.writeFileSync(path.join(dir, 'rotate-skips.json'), JSON.stringify(ledger, null, 2));
  } catch {
    /* best-effort */
  }
}

// --- config ---------------------------------------------------------------------

/**
 * `watchdog.rotate` in agents.yaml (default ON — it is safe now: the health gate
 * is first-party and the readiness wait is bounded). Read fresh per tick so a
 * flip mid-run is honored on the next pass.
 */
export function isWatchdogRotateEnabled(): boolean {
  return readMeta().watchdog?.rotate !== 'off';
}

/**
 * Persist `watchdog.rotate: on|off`. Called by the `agents watchdog rotate
 * on|off` subcommand (commands/watchdog.ts) — the rotate-only switch the
 * Factory migration uses so a user who opted out of autoRotate keeps nudging
 * (rather than `agents watchdog disable`, which disables the whole watchdog here).
 */
export function setWatchdogRotateEnabled(on: boolean): void {
  const meta = readMeta();
  meta.watchdog = { ...(meta.watchdog ?? {}), rotate: on ? 'on' : 'off' };
  writeMeta(meta);
}

// --- the health gate ---------------------------------------------------------------

export interface RotateGateResult {
  /** True when at least one harness has a healthy account to rotate INTO. */
  healthy: boolean;
  /** Earliest future window reset across all candidates, when any snapshot carries one. */
  resetsAtMs?: number;
  /** Human detail for the skip event (the zero-healthy error text). */
  detail: string;
}

/**
 * The first-party health gate: run the SAME selection `agents run auto` would —
 * collectHarnessCandidates over every installed harness, pickHarnessWeighted.
 * Zero healthy → the caller suppresses rotation until earliestResetAcross (or
 * the parsed tail reset, or the default cooldown) and leaves the terminal alone.
 * No `agents view` subprocess, no Keychain probe: collection is cache-only
 * (collectRunCandidates reads daemon-written snapshots, readOnly).
 */
export async function defaultRotateGate(): Promise<RotateGateResult> {
  const byHarness = await collectHarnessCandidates();
  const pick = pickHarnessWeighted(byHarness);
  if (pick) {
    return { healthy: true, detail: `picked ${pick.picked.agent}` };
  }
  const all = [...byHarness.values()].flat();
  const reset = earliestResetAcross(all);
  return {
    healthy: false,
    resetsAtMs: reset?.getTime(),
    detail: formatNoHealthyHarnessError(classifyHarnessCandidates(byHarness)),
  };
}

// --- readiness --------------------------------------------------------------------

/** Transcript layouts to probe for the new session (mirrors read.ts's table). */
const ROTATE_TRANSCRIPT_AGENTS = ['claude', 'codex', 'gemini', 'droid'];

/**
 * Default TUI-liveness probe for the relaunched session: the new session's
 * transcript resolves under any known harness layout. `--session-id` is honored
 * on a claude pick; for other harnesses the runner's readiness check ALSO
 * accepts a fresh active session (started after the rotate began), so a codex
 * pick with an unknown id is still detected.
 */
function defaultRotateTranscriptLive(newSessionId: string): boolean {
  return ROTATE_TRANSCRIPT_AGENTS.some(
    (agent) => resolveWatchdogSessionPath(newSessionId, agent) !== undefined,
  );
}

/** Strip trailing slashes so `/repo` and `/repo/` correlate. */
function normalizeCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const n = cwd.replace(/\/+$/, '');
  return n === '' ? '/' : n;
}

/**
 * The readiness FALLBACK correlation. A fresh active session counts as the
 * relaunched TUI only when ALL of these hold:
 *   - it is not the old session and started at/after the rotate began;
 *   - it runs in the SAME cwd (trailing-slash normalized); and
 *   - it runs on the SAME machine (provenance host = os.hostname(), the same
 *     field provenance.ts populates).
 * An unrelated fresh session — another project, another host, a remote
 * teammate — must NEVER satisfy readiness: on a busy fleet box an
 * uncorrelated "any new session" match fires on the first sweep regardless of
 * whether the relaunch came up, and when `agents run auto` failed loud after
 * the gate that types the replay into a bare shell. When the state lacks cwd
 * or host the fallback cannot correlate and only the transcript probe counts.
 */
export function isCorrelatedRelaunch(state: RotateState, s: ActiveSession): boolean {
  if (!s.sessionId || s.sessionId === state.sessionId) return false;
  if ((s.startedAtMs ?? 0) < state.startedAtMs) return false;
  const cwd = normalizeCwd(state.cwd);
  const host = state.machineHost;
  if (!cwd || !host) return false;
  return normalizeCwd(s.cwd) === cwd && s.provenance?.host === host;
}

/**
 * The default TUI-liveness probe. The new-session-id transcript is PRIMARY (a
 * claude pick honors `--session-id`); the correlated fresh-session fallback
 * (isCorrelatedRelaunch) covers non-claude picks whose id we can't know a
 * priori.
 */
export function defaultTuiLiveFor(state: RotateState, sessions: ActiveSession[]): boolean {
  if (defaultRotateTranscriptLive(state.newSessionId)) return true;
  return sessions.some((s) => isCorrelatedRelaunch(state, s));
}
