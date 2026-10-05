/** Watchdog rotate: move a rate-limited session onto a healthy account/harness in the SAME tab
 * (RUSH-2132): detect the limit, check `agents run auto` selection, inject exit and relaunch,
 * replay once the TUI is live (default 60s, else flag and stop). */

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

/** Agent-reported hard-limit texts matched against a transcript tail, ported from apps/ext
 * autoRotate.ts. Kept specific on purpose: a loose "rate limit" match would rotate terminals whose
 * agent merely discussed limits. */
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

/** Classify a transcript tail: hard account limit (rotate) or not (nudge path). Unlike the retired
 * extension path there is no `no healthy` tail parsing; the health gate is a first-party call. */
export function classifyTailForRotate(tailLines: string[], nowMs: number): RotateTailVerdict {
  if (tailLines.length === 0) return { kind: 'none' };
  const tail = tailLines.join('\n');
  if (ROTATE_LIMIT_PATTERNS.some((p) => p.test(tail))) {
    return { kind: 'rate_limited', resetsAtMs: parseRotateResetMs(tail, nowMs) };
  }
  return { kind: 'none' };
}

/** Parse the `resets <time>` clause into an epoch-ms horizon (ported from autoRotate.ts). The ISO
 * form is matched first and explicitly: a generic capture drops the Z and Date.parse reads local
 * time. Undefined when absent or already past. */
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

/** Clean-exit key sequences per harness, ported from apps/ext prewarm.ts. Injected as raw bytes with
 * no Enter (\x03 is Ctrl+C, \x1b is Esc); claude's Ink TUI needs Esc first to leave any open mode. */
export const ROTATE_EXIT_SEQUENCES: Record<string, string[]> = {
  claude: ['\x1b', '\x03', '\x03'], // Esc, Ctrl+C, Ctrl+C (Esc first for Claude)
  codex: ['\x03', '\x03'], // Ctrl+C twice
  cursor: ['\x03', '\x03'],
  opencode: ['\x03', '\x03'],
};

/** Unknown harnesses get the common denominator: Ctrl+C twice. */
export const DEFAULT_ROTATE_EXIT_SEQUENCE: string[] = ['\x03', '\x03'];

export function exitSequenceFor(agent: string): string[] {
  return ROTATE_EXIT_SEQUENCES[agent] ?? DEFAULT_ROTATE_EXIT_SEQUENCE;
}

// --- launch + replay text ------------------------------------------------------

/** The rotate relaunch typed into the same tab: `agents run auto` (nonzero when exhausted). A remote
 * terminal rotates on that device (`--device`). `--session-id` is honored only for claude but
 * always passed, keeping AGENT_SESSION_ID aligned. */
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

/** The harness-agnostic replay injected once the new TUI is live: load the old transcript, assess,
 * continue (same shape as the CLI's `continue` flow). */
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
  /** The old session's cwd; the readiness fallback counts a fresh session only if it runs in the
   * same project. */
  cwd?: string;
  /** The old session's machine (os.hostname()); a fresh session on another box never satisfies the
   * readiness fallback. */
  machineHost?: string;
  startedAtMs: number;
  updatedAtMs: number;
  /** awaiting-tui deadline: startedAtMs + readiness budget. */
  deadlineMs: number;
  error?: string;
  /** Set on the transition to `failed`: no new rotate for this session until then (default +15m),
   * else a session whose old TUI ignored the exit sequence re-enters every tick. */
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

/** One `rotate` skip event per cooldown window, tracked in <watchdog-state>/rotate-skips.json as {
 * [sessionId]: suppressUntilMs }; skips inside the window log nothing. */
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

/** `watchdog.rotate` in agents.yaml (default on; safe now that the health check is first-party and
 * the readiness wait is bounded). Read per tick so a flip is honored next pass. */
export function isWatchdogRotateEnabled(): boolean {
  return readMeta().watchdog?.rotate !== 'off';
}

/** Persist `watchdog.rotate: on|off`, called by `agents watchdog rotate on|off` (the rotate-only
 * switch the Factory migration uses so an opted-out user keeps nudging). */
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

/** The first-party health check: the same selection `agents run auto` makes
 * (collectHarnessCandidates, pickHarnessWeighted). Zero healthy suppresses rotation until the
 * earliest reset or cooldown. Cache-only; no `agents view` subprocess or Keychain probe. */
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
const ROTATE_TRANSCRIPT_AGENTS = ['claude', 'codex', 'droid'];

/** Default TUI-liveness probe for the relaunched session: the new session's transcript under any
 * harness layout. `--session-id` is honored on a claude pick; for others a fresh active session
 * started after the rotate also counts. */
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

/** Readiness fallback: a fresh active session counts as the relaunched TUI only if not the old one,
 * started after the rotate began, with the same cwd and machine. Otherwise it could pass even if
 * the relaunch failed, typing the replay into a bare shell. */
export function isCorrelatedRelaunch(state: RotateState, s: ActiveSession): boolean {
  if (!s.sessionId || s.sessionId === state.sessionId) return false;
  if ((s.startedAtMs ?? 0) < state.startedAtMs) return false;
  const cwd = normalizeCwd(state.cwd);
  const host = state.machineHost;
  if (!cwd || !host) return false;
  return normalizeCwd(s.cwd) === cwd && s.provenance?.host === host;
}

/** The default TUI-liveness probe: the new-session-id transcript is primary (claude honors
 * `--session-id`); the correlated fresh-session fallback covers non-claude picks. */
export function defaultTuiLiveFor(state: RotateState, sessions: ActiveSession[]): boolean {
  if (defaultRotateTranscriptLive(state.newSessionId)) return true;
  return sessions.some((s) => isCorrelatedRelaunch(state, s));
}
