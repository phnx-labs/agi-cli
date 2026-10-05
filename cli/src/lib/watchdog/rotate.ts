
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

export function classifyTailForRotate(tailLines: string[], nowMs: number): RotateTailVerdict {
  if (tailLines.length === 0) return { kind: 'none' };
  const tail = tailLines.join('\n');
  if (ROTATE_LIMIT_PATTERNS.some((p) => p.test(tail))) {
    return { kind: 'rate_limited', resetsAtMs: parseRotateResetMs(tail, nowMs) };
  }
  return { kind: 'none' };
}

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


export const ROTATE_EXIT_SEQUENCES: Record<string, string[]> = {
  claude: ['\x1b', '\x03', '\x03'],
  codex: ['\x03', '\x03'],
  cursor: ['\x03', '\x03'],
  opencode: ['\x03', '\x03'],
};

export const DEFAULT_ROTATE_EXIT_SEQUENCE: string[] = ['\x03', '\x03'];

export function exitSequenceFor(agent: string): string[] {
  return ROTATE_EXIT_SEQUENCES[agent] ?? DEFAULT_ROTATE_EXIT_SEQUENCE;
}


export function buildRotateLaunchCommand(opts: { host?: string; sessionId: string }): string {
  let cmd = 'agents run auto --interactive';
  if (opts.host) {
    cmd += ` --device ${shellQuoteHost(opts.host)}`;
  }
  cmd += ` --session-id ${opts.sessionId}`;
  return cmd;
}

function shellQuoteHost(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildRotateReplayText(oldSessionId: string): string {
  return (
    `Resume previous work by loading session ${oldSessionId}. ` +
    `Run \`agents sessions ${oldSessionId}\` to load the transcript, assess current state, then continue working.`
  );
}


export type RotatePhase =
  | 'exiting'
  | 'launching'
  | 'awaiting-tui'
  | 'replaying'
  | 'done'
  | 'failed';

export interface RotateState {
  sessionId: string;
  newSessionId: string;
  agent: string;
  phase: RotatePhase;
  target: InjectTarget;
  host?: string;
  cwd?: string;
  machineHost?: string;
  startedAtMs: number;
  updatedAtMs: number;
  deadlineMs: number;
  error?: string;
  suppressUntilMs?: number;
}

export const DEFAULT_ROTATE_READINESS_MS = 60_000;
export const DEFAULT_ROTATE_SKIP_COOLDOWN_MS = 30 * 60_000;
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
  }
}

export function isInflightPhase(phase: RotatePhase): boolean {
  return phase !== 'done' && phase !== 'failed';
}

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

export function listInflightRotates(dir: string): RotateState[] {
  return listRotateStates(dir).filter((s) => isInflightPhase(s.phase));
}


function readRotateSkipLedger(dir: string): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'rotate-skips.json'), 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

export function shouldLogRotateSkip(dir: string, sessionId: string, nowMs: number): boolean {
  return (readRotateSkipLedger(dir)[sessionId] ?? 0) <= nowMs;
}

export function recordRotateSkip(dir: string, sessionId: string, suppressUntilMs: number): void {
  try {
    const ledger = readRotateSkipLedger(dir);
    ledger[sessionId] = suppressUntilMs;
    fs.writeFileSync(path.join(dir, 'rotate-skips.json'), JSON.stringify(ledger, null, 2));
  } catch {
  }
}


export function isWatchdogRotateEnabled(): boolean {
  return readMeta().watchdog?.rotate !== 'off';
}

export function setWatchdogRotateEnabled(on: boolean): void {
  const meta = readMeta();
  meta.watchdog = { ...(meta.watchdog ?? {}), rotate: on ? 'on' : 'off' };
  writeMeta(meta);
}


export interface RotateGateResult {
  healthy: boolean;
  resetsAtMs?: number;
  detail: string;
}

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


const ROTATE_TRANSCRIPT_AGENTS = ['claude', 'codex', 'droid'];

function defaultRotateTranscriptLive(newSessionId: string): boolean {
  return ROTATE_TRANSCRIPT_AGENTS.some(
    (agent) => resolveWatchdogSessionPath(newSessionId, agent) !== undefined,
  );
}

function normalizeCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const n = cwd.replace(/\/+$/, '');
  return n === '' ? '/' : n;
}

export function isCorrelatedRelaunch(state: RotateState, s: ActiveSession): boolean {

  if (!s.sessionId || s.sessionId === state.sessionId) return false;
  if ((s.startedAtMs ?? 0) < state.startedAtMs) return false;
  const cwd = normalizeCwd(state.cwd);
  const host = state.machineHost;
  if (!cwd || !host) return false;
  return normalizeCwd(s.cwd) === cwd && s.provenance?.host === host;
}

export function defaultTuiLiveFor(state: RotateState, sessions: ActiveSession[]): boolean {
  if (defaultRotateTranscriptLive(state.newSessionId)) return true;
  return sessions.some((s) => isCorrelatedRelaunch(state, s));
}
