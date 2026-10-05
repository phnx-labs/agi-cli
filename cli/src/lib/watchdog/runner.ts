
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ActiveSession } from '../session/active.js';
import { getActiveSessions } from '../session/active.js';
import {
  reconcilePresence,
  loadPresence,
  savePresence,
  observedFromActive,
  type PresenceTransition,
} from '../session/presence.js';
import {
  resolveInjectTargetForSession,
  type InjectRail,
  injectIntoTerminal,
  type InjectResult,
  type InjectTarget,
} from '../terminal/index.js';
import {
  classifyTerminal,
  type StallStatus,
  type WatchdogCandidate,
} from './watchdog.js';
import { makeWatchdogAgentDecider, type WatchdogAgentDecider } from './watchdog-agent.js';
import {
  readWatchdogTail,
  WATCHDOG_STALL_MS,
  WATCHDOG_COOLDOWN_MS,
  WATCHDOG_DORMANT_MS,
  WATCHDOG_TAIL_LINES,
} from './read.js';
import { getRuntimeStateDir } from '../state.js';
import { withFileLock, atomicWriteFileSync, ensureLockTarget } from '../fs-atomic.js';
import { resolveAnswerRoute, isOpenQuestionBlock } from '../answer-router.js';
import { enqueue, mailboxDir } from '../mailbox.js';
import { mailboxIdForActiveSession } from '../mailbox-target.js';
import { readBlock, blockIdForSession, buildDeclaredBlock, publishBlock, type OpenBlock } from '../feed/feed.js';
import { summarizeWatchdogTail } from './watchdogTail.js';
import { appendWatchdogEvents, type WatchdogEvent } from './log.js';
import {
  buildRotateLaunchCommand,
  buildRotateReplayText,
  classifyTailForRotate,
  defaultRotateGate,
  defaultTuiLiveFor,
  exitSequenceFor,
  isInflightPhase,
  isWatchdogRotateEnabled,
  listInflightRotates,
  readRotateState,
  recordRotateSkip,
  shouldLogRotateSkip,
  writeRotateState,
  DEFAULT_ROTATE_READINESS_MS,
  DEFAULT_ROTATE_SKIP_COOLDOWN_MS,
  DEFAULT_ROTATE_FAILED_COOLDOWN_MS,
  type RotateGateResult,
  type RotatePhase,
  type RotateState,
} from './rotate.js';

export type WatchdogPolicy = 'off' | 'keep' | 'handsoff';

export interface WatchdogThresholds {
  stallMs: number;
  cooldownMs: number;
  dormantMs: number;
}

export const DEFAULT_THRESHOLDS: WatchdogThresholds = {
  stallMs: WATCHDOG_STALL_MS,
  cooldownMs: WATCHDOG_COOLDOWN_MS,
  dormantMs: WATCHDOG_DORMANT_MS,
};

const DEFAULT_NUDGE_TEXT = 'Continue.';

export interface WatchdogTickOptions {
  nudge?: boolean;
  nudgeText?: string;
  smartAgent?: string;
  thresholds?: Partial<WatchdogThresholds>;
  allowGhosttyFocus?: boolean;
  injectDryRun?: boolean;

  sessions?: ActiveSession[];
  nowMs?: number;
  stateDir?: string;
  lastActivityFor?: (s: ActiveSession) => number | undefined;
  tailFor?: (s: ActiveSession) => string[];
  policyFor?: (s: ActiveSession) => WatchdogPolicy;
  smartDecider?: SmartDecider;
  agentDecider?: WatchdogAgentDecider;
  openBlockFor?: (s: ActiveSession) => OpenBlock | null;
  injectFn?: (target: InjectTarget, text: string, opts: { dryRun?: boolean; enter?: boolean }) => Promise<InjectResult>;
  publishBlockFn?: (block: OpenBlock) => void;
  logPath?: string;

  rotate?: boolean;
  rotateReadinessMs?: number;
  rotateGate?: () => Promise<RotateGateResult>;
  newSessionIdFor?: () => string;
  tuiLiveFor?: (state: RotateState, sessions: ActiveSession[]) => boolean;
  rotateKeyDelayMs?: number;
}

export type SmartDecider = (session: ActiveSession, candidate: WatchdogCandidate) => Promise<NudgeDecision>;

export interface SessionOutcome {
  sessionId?: string;
  kind: string;
  host?: string;
  cwd?: string;
  project?: string | null;
  label?: string;
  name?: string;
  generatedTitle?: string;
  topic?: string;
  preview?: string;
  activity?: ActiveSession['activity'];
  status?: ActiveSession['status'];
  startedAtMs?: number;
  lastActivityMs?: number;
  origin?: ActiveSession['origin'];
  routineName?: string;
  machine?: string;
  owner?: string;
  stall: StallStatus['kind'];
  stalledForMs?: number;
  policy: WatchdogPolicy;
  decision: 'nudge' | 'skip' | 'rotate';
  reason: string;
  rotatePhase?: RotatePhase;
  rail?: InjectRail;
  via?: NudgeVia;
  addressable?: boolean;
  injected?: boolean;
  nudgeText?: string;
}

export type NudgeVia = 'inject' | 'mailbox' | 'resume';

export interface WatchdogTickResult {
  atMs: number;
  didNudge: boolean;
  outcomes: SessionOutcome[];
  counts: {
    total: number;
    stalled: number;
    nudged: number;
    unaddressable: number;
    skipped: number;
    rotating: number;
  };
  presence: {
    connected: number;
    disconnected: number;
    transitions: PresenceTransition[];
  };
}


function watchdogStateDir(opts: WatchdogTickOptions): string {
  return opts.stateDir ?? path.join(getRuntimeStateDir(), 'watchdog');
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(file: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  } catch {
  }
}

function readNudgeLedger(dir: string): Record<string, number> {
  return readJsonFile<Record<string, number>>(path.join(dir, 'nudges.json'), {});
}

function readPolicySentinel(dir: string, sessionId: string): WatchdogPolicy {
  if (!sessionId) return 'keep';
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, 'policy', sessionId), 'utf8').trim().toLowerCase();
  } catch {
    return 'keep';
  }
  return raw === 'off' || raw === 'handsoff' ? raw : 'keep';
}

export function writePolicySentinel(dir: string, sessionId: string, policy: WatchdogPolicy): void {
  const file = path.join(dir, 'policy', sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, policy + '\n');
}


function defaultLastActivity(s: ActiveSession): number | undefined {
  if (s.sessionFile) {
    try {
      return fs.statSync(s.sessionFile).mtimeMs;
    } catch {
    }
  }
  return s.startedAtMs;
}

export interface NudgeDecision {
  nudge: boolean;
  reason: string;
  text?: string;
  needsHuman?: boolean;
}


type DeliveryPlan =
  | { via: 'inject'; rail: InjectRail; target: InjectTarget }
  | { via: 'resume' }
  | { via: 'mailbox'; mailboxId: string }
  | { via: 'refuse'; reason: string; hint?: string };

function planDelivery(
  session: ActiveSession,
  chosenText: string,
  block: OpenBlock | null,
  allowGhosttyFocus: boolean | undefined,
): DeliveryPlan {
  const sessionId = session.sessionId ?? '';
  const mailboxId = mailboxIdForActiveSession(session) ?? sessionId;
  const resolution = resolveInjectTargetForSession(session, { allowGhosttyFocus });
  const route = resolveAnswerRoute({ mailboxId, answer: chosenText, session, block });

  if (resolution.addressable) {
    return { via: 'inject', rail: resolution.rail, target: resolution.target };
  }
  if (route.kind === 'resume') return { via: 'resume' };
  if (route.kind === 'mailbox' && isOpenQuestionBlock(block)) return { via: 'mailbox', mailboxId };
  return {
    via: 'refuse',
    reason: route.kind === 'refuse' ? route.reason : resolution.reason,
    hint: route.kind === 'refuse' ? undefined : resolution.hint,
  };
}

function defaultOpenBlockFor(session: ActiveSession): OpenBlock | null {
  const id = mailboxIdForActiveSession(session) ?? session.sessionId;
  if (!id) return null;
  const direct = readBlock(blockIdForSession(id));
  if (direct && direct.mailboxId === id) return direct;
  return null;
}

function deliverViaMailbox(mailboxId: string, text: string, block: OpenBlock | null): void {
  enqueue(mailboxDir(mailboxId), { to: mailboxId, text, from: 'watchdog', blockId: block?.blockId });
}

async function deliverViaResume(session: ActiveSession, text: string): Promise<{ ok: boolean; error?: string }> {
  const sid = session.sessionId;
  if (!sid) return { ok: false, error: 'no session id to resume' };
  try {
    const [{ getAgentsInvocation }, { spawn }] = await Promise.all([
      import('../daemon/daemon.js'),
      import('child_process'),
    ]);
    const inv = getAgentsInvocation(['run', session.kind, '--resume', sid, '--', text]);
    const code: number = await new Promise((resolve) => {
      const child = spawn(inv.command, inv.args, { stdio: 'ignore', env: process.env, detached: false });
      child.on('exit', (c) => resolve(c ?? 1));
      child.on('error', () => resolve(1));
    });
    return code === 0 ? { ok: true } : { ok: false, error: `resume exited ${code}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}


interface RotateAdvanceDeps {
  dir: string;
  nowMs: number;
  sessions: ActiveSession[];
  mayInject: boolean;
  injectFn: (target: InjectTarget, text: string, opts: { dryRun?: boolean; enter?: boolean }) => Promise<InjectResult>;
  tuiLiveFor: (state: RotateState, sessions: ActiveSession[]) => boolean;
  injectDryRun?: boolean;
  logEvents: WatchdogEvent[];
  flags: Record<string, { reason: string; host?: string; atMs: number }>;
}

function rotateOutcomeReason(s: RotateState): string {
  switch (s.phase) {
    case 'awaiting-tui':
      return `rotate in flight — awaiting new session ${s.newSessionId} TUI (deadline ${new Date(s.deadlineMs).toISOString()})`;
    case 'done':
      return `rotated → ${s.newSessionId}; replayed resume`;
    case 'failed':
      return `rotate failed: ${s.error ?? 'unknown'}`;
    default:
      return `rotate in flight (${s.phase})`;
  }
}

async function advanceRotate(state: RotateState, deps: RotateAdvanceDeps): Promise<RotateState> {
  let s = state;
  const fail = (error: string): RotateState => {
    s = {
      ...s, phase: 'failed', error, updatedAtMs: deps.nowMs,
      suppressUntilMs: deps.nowMs + DEFAULT_ROTATE_FAILED_COOLDOWN_MS,
    };
    writeRotateState(deps.dir, s);
    deps.flags[s.sessionId] = { reason: `rotate failed: ${error}`, host: s.host, atMs: deps.nowMs };
    deps.logEvents.push({
      ts: deps.nowMs, kind: 'rotate', terminalId: s.sessionId, agentType: s.agent,
      message: `rotate failed: ${s.sessionId} — ${error}`,
    });
    return s;
  };

  if (s.phase === 'exiting' || s.phase === 'launching') {
    s = { ...s, phase: 'awaiting-tui', updatedAtMs: deps.nowMs };
    writeRotateState(deps.dir, s);
  }

  if (s.phase === 'awaiting-tui') {

    if (!deps.tuiLiveFor(s, deps.sessions)) {
      if (deps.nowMs > s.deadlineMs) {
        return fail(
          `new session ${s.newSessionId} TUI not live within the readiness budget — nothing was typed ` +
          `into a possibly-dead shell; the terminal may sit at a BARE SHELL now: relaunch manually with ` +
          `\`agents run auto\` (there is no automatic recovery)`,
        );
      }
      return s;
    }
    s = { ...s, phase: 'replaying', updatedAtMs: deps.nowMs };
    writeRotateState(deps.dir, s);
  }

  if (s.phase === 'replaying') {
    if (!deps.mayInject) return s;
    let ok = true;
    let error: string | undefined;
    try {
      const r = await deps.injectFn(s.target, buildRotateReplayText(s.sessionId), { dryRun: deps.injectDryRun });
      ok = r.ok;
      error = r.error;
    } catch (err) {
      ok = false;
      error = err instanceof Error ? err.message : String(err);
    }
    if (!ok) return fail(`replay inject failed: ${error ?? 'unknown error'}`);
    s = { ...s, phase: 'done', updatedAtMs: deps.nowMs };
    writeRotateState(deps.dir, s);
    deps.logEvents.push({
      ts: deps.nowMs, kind: 'rotate', terminalId: s.sessionId, agentType: s.agent,
      message: `rotated ${s.sessionId} → ${s.newSessionId}; replayed resume`,
    });
  }
  return s;
}


export async function runWatchdogTick(opts: WatchdogTickOptions = {}): Promise<WatchdogTickResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const nudgeText = opts.nudgeText ?? DEFAULT_NUDGE_TEXT;
  const thresholds: WatchdogThresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
  const dir = watchdogStateDir(opts);
  const lastActivityFor = opts.lastActivityFor ?? defaultLastActivity;
  const tailFor = opts.tailFor ?? ((s) => (s.sessionId ? readWatchdogTail(s.sessionId, s.kind, WATCHDOG_TAIL_LINES) : []));
  const policyFor = opts.policyFor ?? ((s) => (s.sessionId ? readPolicySentinel(dir, s.sessionId) : 'keep'));
  const openBlockFor = opts.openBlockFor ?? defaultOpenBlockFor;
  const injectFn = opts.injectFn ?? injectIntoTerminal;
  const publishBlockFn = opts.publishBlockFn ?? publishBlock;

  const rotateEnabled = opts.rotate ?? isWatchdogRotateEnabled();
  const rotateGate = opts.rotateGate ?? defaultRotateGate;
  const newSessionIdFor = opts.newSessionIdFor ?? (() => crypto.randomUUID());
  const rotateReadinessMs = opts.rotateReadinessMs ?? DEFAULT_ROTATE_READINESS_MS;
  const rotateKeyDelayMs = opts.rotateKeyDelayMs ?? 300;
  const tuiLiveFor = opts.tuiLiveFor ?? defaultTuiLiveFor;

  const sessions = opts.sessions ?? (await getActiveSessions());

  const presenceResult = reconcilePresence(loadPresence(dir), observedFromActive(sessions), nowMs);
  savePresence(presenceResult.next, dir);
  const presence = {
    connected: Object.values(presenceResult.next).filter((r) => r.status === 'connected').length,
    disconnected: Object.values(presenceResult.next).filter((r) => r.status === 'disconnected').length,
    transitions: presenceResult.transitions,
  };

  const ledger = readNudgeLedger(dir);
  const ledgerUpdates: Record<string, number> = {};
  const flags: Record<string, { reason: string; host?: string; atMs: number }> = {};
  const outcomes: SessionOutcome[] = [];
  const logEvents: WatchdogEvent[] = [];
  const viaLabel = (plan: DeliveryPlan): string =>
    plan.via === 'inject' ? `inject (${plan.rail})` : plan.via;

  const advancedRotates = new Set<string>();
  const rotateDeps: RotateAdvanceDeps = {
    dir, nowMs, sessions,
    mayInject: opts.nudge === true,
    injectFn, tuiLiveFor,
    injectDryRun: opts.injectDryRun,
    logEvents, flags,
  };

  const tailCache = new Map<string, string[]>();
  const idleCandidates: { session: ActiveSession; candidate: WatchdogCandidate }[] = [];
  for (const session of sessions) {
    const sid = session.sessionId;
    if (!sid) continue;
    if (policyFor(session) === 'off') continue;
    const la = lastActivityFor(session);
    if (la === undefined) continue;
    const st = classifyTerminal({
      lastActivityMs: la, nowMs, lastNudgeMs: ledger[sid] ?? null, optedOut: false,
      stallMs: thresholds.stallMs, cooldownMs: thresholds.cooldownMs, dormantMs: thresholds.dormantMs,
    });
    if (st.kind !== 'stalled') continue;
    const tail = tailFor(session);
    tailCache.set(sid, tail);
    if (rotateEnabled) {
      const inflight = readRotateState(dir, sid);
      if (inflight && (isInflightPhase(inflight.phase) || (inflight.phase === 'failed' && (inflight.suppressUntilMs ?? 0) > nowMs))) continue;
      if (classifyTailForRotate(tail, nowMs).kind === 'rate_limited') continue;
    }
    idleCandidates.push({
      session,
      candidate: {
        terminalId: sid,
        agentType: session.kind === 'codex' ? 'codex' : 'claude',
        tailLines: tail,
        stalledForMs: st.stalledForMs,
        task: session.topic ?? session.label ?? session.name,
        cwd: session.cwd,
      },
    });
  }

  const decisionByTerminal = new Map<string, NudgeDecision>();

  if (idleCandidates.length > 0) {
    if (opts.smartDecider) {
      for (const { session, candidate } of idleCandidates) {
        const raw = await opts.smartDecider(session, candidate);
        decisionByTerminal.set(candidate.terminalId, raw.nudge ? raw : { ...raw, needsHuman: raw.needsHuman ?? true });
      }
    } else {
      const decide = opts.agentDecider ?? makeWatchdogAgentDecider(opts.smartAgent ?? 'claude');
      const verdicts = await decide(idleCandidates.map((e) => e.candidate));
      if (verdicts.size === 0) {
        logEvents.push({
          ts: nowMs, kind: 'error',
          message: `watchdog agent returned no verdicts for ${idleCandidates.length} idle session(s) — decider unavailable this tick`,
        });
      }
      for (const { candidate } of idleCandidates) {
        const d = verdicts.get(candidate.terminalId);
        decisionByTerminal.set(
          candidate.terminalId,
          d
            ? {
                nudge: d.action === 'nudge',
                reason: d.reason || `agent: ${d.action}`,
                text: d.text || undefined,
                needsHuman: d.action === 'skip' ? d.needsHuman ?? true : undefined,
              }
            : { nudge: false, reason: 'watchdog agent returned no verdict — retry next tick' },
        );
      }
    }
  }

  for (const session of sessions) {
    const policy = policyFor(session);
    const base: SessionOutcome = {
      sessionId: session.sessionId,
      kind: session.kind,
      host: session.host,
      cwd: session.cwd,
      project: session.project,
      label: session.label,
      name: session.name,
      generatedTitle: session.generatedTitle,
      topic: session.topic,
      preview: session.preview,
      activity: session.activity,
      status: session.status,
      startedAtMs: session.startedAtMs,
      lastActivityMs: session.lastActivityMs,
      origin: session.origin,
      routineName: session.routineName,
      machine: session.machine ?? session.provenance?.host,
      owner: session.owner,
      policy,
      stall: 'active',
      decision: 'skip',
      reason: '',
      nudgeText,
    };

    if (!session.sessionId) {
      outcomes.push({ ...base, reason: 'no session id (cannot address or track)' });
      continue;
    }
    if (policy === 'off') {
      outcomes.push({ ...base, stall: 'opted_out', reason: 'policy: off (opted out)' });
      continue;
    }

    const lastActivityMs = lastActivityFor(session);
    base.lastActivityMs = session.lastActivityMs ?? lastActivityMs;
    if (lastActivityMs === undefined) {
      outcomes.push({ ...base, reason: 'no activity timestamp (no transcript / start time)' });
      continue;
    }

    const status = classifyTerminal({
      lastActivityMs,
      nowMs,
      lastNudgeMs: ledger[session.sessionId] ?? null,
      optedOut: false,
      stallMs: thresholds.stallMs,
      cooldownMs: thresholds.cooldownMs,
      dormantMs: thresholds.dormantMs,
    });
    base.stall = status.kind;

    if (status.kind !== 'stalled') {
      const reason =
        status.kind === 'active' ? `active (last activity ${Math.round((nowMs - lastActivityMs) / 1000)}s ago)`
        : status.kind === 'dormant' ? 'dormant (idle past the dormant window)'
        : status.kind === 'rate_limited' ? `cooling down (${Math.round(status.cooldownRemainingMs / 1000)}s left)`
        : 'opted out';
      outcomes.push({ ...base, reason });
      continue;
    }

    base.stalledForMs = status.stalledForMs;

    const tailLines = tailCache.get(session.sessionId) ?? tailFor(session);
    const candidate: WatchdogCandidate = {
      terminalId: session.sessionId,
      agentType: (session.kind === 'codex' ? 'codex' : 'claude'),
      tailLines,
      stalledForMs: status.stalledForMs,
    };

    if (rotateEnabled) {
      const sid = session.sessionId;
      const inflight = readRotateState(dir, sid);
      if (inflight && isInflightPhase(inflight.phase)) {
        const advanced = await advanceRotate(inflight, rotateDeps);
        advancedRotates.add(sid);
        outcomes.push({
          ...base, decision: 'rotate', rotatePhase: advanced.phase,
          reason: rotateOutcomeReason(advanced),
        });
        continue;
      }
      if (inflight && inflight.phase === 'failed' && (inflight.suppressUntilMs ?? 0) > nowMs) {
        outcomes.push({
          ...base, decision: 'skip', rotatePhase: 'failed',
          reason: `rotate suppressed until ${new Date(inflight.suppressUntilMs!).toISOString()} (failed-rotate cooldown)`,
        });
        continue;
      }

      const verdict = classifyTailForRotate(tailLines, nowMs);
      if (verdict.kind === 'rate_limited') {
        if (policy === 'handsoff') {
          flags[sid] = {
            reason: 'handsoff: rate-limited, would rotate in place but policy is hands-off',
            host: session.host,
            atMs: nowMs,
          };
          outcomes.push({
            ...base, decision: 'skip',
            reason: 'handsoff: rate-limited — flagged, not rotated',
          });
          continue;
        }

        if (!opts.nudge) {
          outcomes.push({
            ...base, decision: 'rotate',
            reason: 'rate-limited — would rotate in place via `agents run auto` (dry — pass --nudge)',
          });
          continue;
        }

        let gate: RotateGateResult;
        try {
          gate = await rotateGate();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logEvents.push({
            ts: nowMs, kind: 'error', terminalId: sid, agentType: candidate.agentType,
            message: `rotate gate failed: ${msg}`,
          });
          outcomes.push({
            ...base, decision: 'skip',
            reason: `rate-limited but the rotate health gate failed — skipped this tick: ${msg}`,
          });
          continue;
        }
        if (!gate.healthy) {
          const cooldownMs =
            gate.resetsAtMs !== undefined ? Math.max(60_000, gate.resetsAtMs - nowMs)
            : verdict.resetsAtMs !== undefined ? Math.max(60_000, verdict.resetsAtMs - nowMs)
            : DEFAULT_ROTATE_SKIP_COOLDOWN_MS;
          const suppressUntilMs = nowMs + cooldownMs;
          if (shouldLogRotateSkip(dir, sid, nowMs)) {
            recordRotateSkip(dir, sid, suppressUntilMs);
            logEvents.push({
              ts: nowMs, kind: 'rotate', terminalId: sid, agentType: candidate.agentType,
              message: `rotate skipped: no healthy harness — ${gate.detail}; suppressed until ${new Date(suppressUntilMs).toISOString()}`,
              reason: gate.detail,
            });
          }
          outcomes.push({
            ...base, decision: 'skip',
            reason: `rate-limited but no healthy account/harness to rotate into — terminal untouched (suppressed until ${new Date(suppressUntilMs).toISOString()})`,
          });
          continue;
        }

        const resolution = resolveInjectTargetForSession(session, { allowGhosttyFocus: opts.allowGhosttyFocus });
        if (!resolution.addressable) {
          flags[sid] = { reason: `rotate: ${resolution.reason}`, host: session.host, atMs: nowMs };
          outcomes.push({
            ...base, decision: 'skip', addressable: false,
            reason: resolution.hint
              ? `rate-limited but un-addressable — ${resolution.reason} — ${resolution.hint}`
              : `rate-limited but un-addressable — ${resolution.reason}`,
          });
          continue;
        }

        const newSessionId = newSessionIdFor();
        let state: RotateState = {
          sessionId: sid,
          newSessionId,
          agent: session.kind,
          phase: 'exiting',
          target: resolution.target,
          host: session.provenance?.transport === 'ssh' ? session.provenance.host : undefined,
          cwd: session.cwd,
          machineHost: session.provenance?.host,
          startedAtMs: nowMs,
          updatedAtMs: nowMs,
          deadlineMs: nowMs + rotateReadinessMs,
        };

        writeRotateState(dir, state);
        advancedRotates.add(sid);

        let rotateFailed: string | null = null;
        for (const key of exitSequenceFor(session.kind)) {
          try {
            const r = await injectFn(state.target, key, { dryRun: opts.injectDryRun, enter: false });
            if (!r.ok) { rotateFailed = `exit sequence inject failed: ${r.error ?? 'unknown error'}`; break; }
          } catch (err) {
            rotateFailed = `exit sequence inject threw: ${err instanceof Error ? err.message : String(err)}`;
            break;
          }
          if (rotateKeyDelayMs > 0 && !opts.injectDryRun) {
            await new Promise((resolve) => setTimeout(resolve, rotateKeyDelayMs));
          }
        }

        if (!rotateFailed) {
          state = { ...state, phase: 'launching', updatedAtMs: nowMs };
          writeRotateState(dir, state);
          const launch = buildRotateLaunchCommand({ host: state.host, sessionId: newSessionId });
          try {
            const r = await injectFn(state.target, launch, { dryRun: opts.injectDryRun });
            if (!r.ok) rotateFailed = `launch inject failed: ${r.error ?? 'unknown error'}`;
          } catch (err) {
            rotateFailed = `launch inject threw: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        if (rotateFailed) {
          state = {
            ...state, phase: 'failed', error: rotateFailed, updatedAtMs: nowMs,
            suppressUntilMs: nowMs + DEFAULT_ROTATE_FAILED_COOLDOWN_MS,
          };
          writeRotateState(dir, state);
          flags[sid] = { reason: `rotate failed: ${rotateFailed}`, host: session.host, atMs: nowMs };
          logEvents.push({
            ts: nowMs, kind: 'rotate', terminalId: sid, agentType: candidate.agentType,
            message: `rotate failed: ${sid} — ${rotateFailed}`,
          });
          outcomes.push({
            ...base, decision: 'rotate', rotatePhase: 'failed', addressable: true, rail: resolution.rail,
            reason: `rotate failed: ${rotateFailed}`,
          });
          continue;
        }

        state = { ...state, phase: 'awaiting-tui', updatedAtMs: nowMs };
        writeRotateState(dir, state);
        logEvents.push({
          ts: nowMs, kind: 'rotate', terminalId: sid, agentType: candidate.agentType,
          message: `rotating ${sid} in place → agents run auto (new session ${newSessionId})`,
        });
        outcomes.push({
          ...base, decision: 'rotate', rotatePhase: 'awaiting-tui', addressable: true, rail: resolution.rail,
          reason: `rotating in place → agents run auto (new session ${newSessionId})`,
        });
        continue;
      }
    }

    const decision: NudgeDecision =
      decisionByTerminal.get(session.sessionId) ??
      { nudge: false, reason: 'not evaluated by the watchdog agent', needsHuman: false };
    const chosenText = decision.text ?? nudgeText;

    const summary = summarizeWatchdogTail(tailLines, candidate.agentType);
    logEvents.push({
      ts: nowMs,
      kind: 'decision',
      terminalId: session.sessionId,
      agentType: candidate.agentType,
      message: decision.reason,
      reason: decision.reason,
      stalledForMs: status.stalledForMs,
      tailLines,
      nudgeText: decision.nudge ? chosenText : undefined,
      lastUserMessage: summary.lastUserMessage,
      lastAssistantMessage: summary.lastAssistantMessage,
    });

    if (!decision.nudge) {
      if (decision.needsHuman) {

        const lastNudgeMs = ledger[session.sessionId ?? ''] ?? 0;
        const cooldownMs = thresholds.cooldownMs;
        const withinCooldown = nowMs - lastNudgeMs < cooldownMs;
        if (opts.nudge && session.sessionId && !withinCooldown) {
          const existingBlock = openBlockFor(session);
          if (existingBlock === null) {
            const resolution = resolveInjectTargetForSession(session, { allowGhosttyFocus: opts.allowGhosttyFocus });
            if (resolution.addressable) {
              const reminderText =
                'You appear stuck. If you genuinely need Muqsit, file it: ' +
                'agents feed post "<one-line ask>" --blocked --default "<safe default>". ' +
                'Otherwise keep going.';
              try {
                await injectFn(resolution.target, reminderText, { dryRun: opts.injectDryRun });
              } catch {
              }
              ledgerUpdates[session.sessionId] = nowMs;
            } else {
              const mailboxId = mailboxIdForActiveSession(session) ?? session.sessionId;
              const machineHost = session.provenance?.host ?? 'unknown';
              const runtime = session.kind;
              try {
                const declaredBlock = buildDeclaredBlock(
                  { sessionId: session.sessionId, mailboxId, host: machineHost, runtime, cwd: session.cwd },
                  {
                    text: resolution.hint
                      ? `Session genuinely needs Muqsit and is un-addressable — ${decision.reason}. Needs attention. ${resolution.hint}`
                      : `Session genuinely needs Muqsit and is un-addressable — ${decision.reason}. Needs attention.`,
                  },
                );
                publishBlockFn(declaredBlock);
                ledgerUpdates[session.sessionId] = nowMs;
              } catch {
              }
            }
          }
        }
      }
      outcomes.push({ ...base, decision: 'skip', reason: decision.reason });
      continue;
    }

    const block = openBlockFor(session);
    const plan = planDelivery(session, chosenText, block, opts.allowGhosttyFocus);
    const rail = plan.via === 'inject' ? plan.rail : undefined;
    const addressable = plan.via === 'inject' ? true : undefined;

    if (plan.via === 'refuse') {
      flags[session.sessionId] = { reason: plan.reason, host: session.host, atMs: nowMs };
      outcomes.push({
        ...base, decision: 'skip', addressable: false,
        reason: plan.hint
          ? `nudge-worthy but un-addressable — ${plan.reason} — ${plan.hint}`
          : `nudge-worthy but un-addressable — ${plan.reason}`,
        nudgeText: chosenText,
      });
      continue;
    }

    if (policy === 'handsoff') {
      flags[session.sessionId] = {
        reason: `handsoff: would nudge via ${viaLabel(plan)} but policy is hands-off`,
        host: session.host,
        atMs: nowMs,
      };
      outcomes.push({
        ...base, decision: 'nudge', addressable, rail, via: plan.via, injected: false,
        reason: `handsoff: flagged, not delivered (would nudge via ${viaLabel(plan)})`,
        nudgeText: chosenText,
      });
      continue;
    }

    if (!opts.nudge) {
      outcomes.push({
        ...base, decision: 'nudge', addressable, rail, via: plan.via, injected: false,
        reason: `would nudge via ${viaLabel(plan)} (dry — pass --nudge)`,
        nudgeText: chosenText,
      });
      continue;
    }

    let delivered: { ok: boolean; confirmed: boolean; error?: string };
    if (plan.via === 'inject') {
      try {
        const r = await injectFn(plan.target, chosenText, { dryRun: opts.injectDryRun });
        delivered = { ok: r.ok, confirmed: r.confirmed, error: r.error };
      } catch (err) {
        delivered = { ok: false, confirmed: false, error: err instanceof Error ? err.message : String(err) };
      }
    } else if (plan.via === 'mailbox') {
      if (opts.injectDryRun) {
        delivered = { ok: true, confirmed: true };
      } else {
        try { deliverViaMailbox(plan.mailboxId, chosenText, block); delivered = { ok: true, confirmed: true }; }
        catch (err) { delivered = { ok: false, confirmed: false, error: err instanceof Error ? err.message : String(err) }; }
      }
    } else {
      delivered = opts.injectDryRun ? { ok: true, confirmed: true } : { ...(await deliverViaResume(session, chosenText)), confirmed: true };
    }


    if (delivered.ok && delivered.confirmed) {
      ledgerUpdates[session.sessionId] = nowMs;
      logEvents.push({
        ts: nowMs, kind: 'nudge', terminalId: session.sessionId, agentType: candidate.agentType,
        message: `nudged via ${viaLabel(plan)}`, reason: decision.reason, nudgeText: chosenText,
      });
      outcomes.push({
        ...base, decision: 'nudge', addressable, rail, via: plan.via, injected: true,
        reason: `nudged via ${viaLabel(plan)}`,
        nudgeText: chosenText,
      });
    } else if (delivered.ok && !delivered.confirmed) {
      ledgerUpdates[session.sessionId] = nowMs;
      logEvents.push({
        ts: nowMs, kind: 'undelivered', terminalId: session.sessionId, agentType: candidate.agentType,
        message: `dispatched via ${viaLabel(plan)} but UNCONFIRMED (needs swarm-ext ack)`,
        reason: decision.reason, nudgeText: chosenText,
      });
      outcomes.push({
        ...base, decision: 'skip', addressable, rail, via: plan.via, injected: false,
        reason: `nudge dispatched via ${viaLabel(plan)} but delivery is UNCONFIRMED (swarm-ext ack pending)`,
        nudgeText: chosenText,
      });
    } else {
      outcomes.push({
        ...base, decision: 'skip', addressable, rail, via: plan.via, injected: false,
        reason: `nudge via ${viaLabel(plan)} failed: ${delivered.error ?? 'unknown error'}`,
        nudgeText: chosenText,
      });
    }
  }

  for (const inflight of listInflightRotates(dir)) {
    if (advancedRotates.has(inflight.sessionId)) continue;
    await advanceRotate(inflight, rotateDeps);
  }

  if (Object.keys(ledgerUpdates).length > 0) {
    const nudgesPath = path.join(dir, 'nudges.json');
    const ledgerLock = path.join(dir, '.ledger.lock');
    try {
      ensureLockTarget(ledgerLock);

      withFileLock(ledgerLock, () => {
        const current = readNudgeLedger(dir);
        for (const [sid, ts] of Object.entries(ledgerUpdates)) current[sid] = ts;
        atomicWriteFileSync(nudgesPath, JSON.stringify(current, null, 2));
      });
    } catch {
    }
  }
  writeJsonFile(path.join(dir, 'flags.json'), flags);

  const counts = {
    total: outcomes.length,
    stalled: outcomes.filter((o) => o.stall === 'stalled').length,
    nudged: outcomes.filter((o) => o.injected).length,
    unaddressable: outcomes.filter((o) => o.addressable === false).length,
    skipped: outcomes.filter((o) => o.decision === 'skip').length,
    rotating: outcomes.filter((o) => o.decision === 'rotate').length,
  };
  const result: WatchdogTickResult = { atMs: nowMs, didNudge: opts.nudge === true, outcomes, counts, presence };
  writeJsonFile(path.join(dir, 'last-tick.json'), result);

  logEvents.push({
    ts: nowMs,
    kind: 'tick',
    message: `${counts.total} live · ${counts.stalled} stalled · ${counts.nudged} nudged · ${counts.unaddressable} un-addressable`,
    inspections: outcomes.map((outcome) => ({
      terminalId: outcome.sessionId,
      agentType: outcome.kind,
      message: outcome.decision,
      reason: outcome.reason,
      stalledForMs: outcome.stalledForMs,
    })),
  });
  appendWatchdogEvents(logEvents, { logPath: opts.logPath });

  return result;
}
