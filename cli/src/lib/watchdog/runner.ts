/** Watchdog runner (RUSH-1415), driven by `agents watchdog`: classify sessions, read tails of idle
 * ones, ONE batched agent call decides nudge vs skip. A nudge is delivered only if `addressable:
 * true` and booked only when confirmed. State: ~/.agents/.cache/state/watchdog/. */

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

/** Per-session policy sentinel. `keep` is the default (watchdog may nudge). */
export type WatchdogPolicy = 'off' | 'keep' | 'handsoff';

/** Stall / cooldown / dormant thresholds (ms). Defaults mirror read.ts. */
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

/** The default nudge text — a short imperative, configurable via opts.nudgeText. */
const DEFAULT_NUDGE_TEXT = 'Continue.';

export interface WatchdogTickOptions {
  /** Actually inject when a nudge is decided. Default false (dry status). */
  nudge?: boolean;
  /** Nudge text delivered into the terminal. Default "Continue." */
  nudgeText?: string;
  /** Agent the watchdog decider runs as (and the built-in prompt). Default 'claude'. */
  smartAgent?: string;
  /** Threshold overrides. Missing fields fall back to DEFAULT_THRESHOLDS. */
  thresholds?: Partial<WatchdogThresholds>;
  /** Permit the coarse, focus-stealing Ghostty path. Off by default. */
  allowGhosttyFocus?: boolean;
  /** Pass dryRun through to injectIntoTerminal (tests set true — no real terminal). */
  injectDryRun?: boolean;

  // --- injectable I/O seams (production defaults resolve the real thing) ---
  /** Session list. Default getActiveSessions(). Tests pass synthetic sessions. */
  sessions?: ActiveSession[];
  /** Clock. Default Date.now(). Tests pin it. */
  nowMs?: number;
  /** Override the state directory (tests point at a tmpdir). */
  stateDir?: string;
  /** lastActivity (ms) for a session. Default = its transcript mtime. */
  lastActivityFor?: (s: ActiveSession) => number | undefined;
  /** Transcript tail lines for a session. Default readWatchdogTail(). */
  tailFor?: (s: ActiveSession) => string[];
  /** Per-session policy. Default = the on-disk sentinel. */
  policyFor?: (s: ActiveSession) => WatchdogPolicy;
  /** The decider seam: per idle candidate, nudge vs skip and the message. Production leaves it unset
   * (one batched `agents run --mode plan` call); tests inject a synthetic decider. */
  smartDecider?: SmartDecider;
  /** The batched agent decider used in production (default `makeWatchdogAgentDecider`); tests inject
   * one to exercise the batched path. Ignored when `smartDecider` is set. */
  agentDecider?: WatchdogAgentDecider;
  /** Open feed block for a session (parked-on-question detection). Default reads the feed. */
  openBlockFor?: (s: ActiveSession) => OpenBlock | null;
  /** Inject primitive. Default injectIntoTerminal — tests capture the resolved target. */
  injectFn?: (target: InjectTarget, text: string, opts: { dryRun?: boolean; enter?: boolean }) => Promise<InjectResult>;
  /** Publish a declared block on the owner's feed (default publishBlock()); tests inject a
   * collector. */
  publishBlockFn?: (block: OpenBlock) => void;
  /** Override the canonical watchdog.log path (tests point at a tmp file). */
  logPath?: string;

  // --- rotate seams (watchdog/rotate.ts) ---
  /** In-place rotate of rate-limited sessions; default is `watchdog.rotate` in agents.yaml (on).
   * Acts only when `nudge` is set; a dry tick never rotates. */
  rotate?: boolean;
  /** Bounded wait for the relaunched TUI to come live. Default 60s. */
  rotateReadinessMs?: number;
  /** Health check run before rotating; default defaultRotateGate() makes the same selection as
   * `agents run auto`. Tests inject a verdict. */
  rotateGate?: () => Promise<RotateGateResult>;
  /** New session id for the relaunch. Default crypto.randomUUID(). Tests pin it. */
  newSessionIdFor?: () => string;
  /** Readiness probe: is the relaunched TUI live? Default: the new session id's transcript resolves,
   * or a fresh active session started after the rotate began exists. */
  tuiLiveFor?: (state: RotateState, sessions: ActiveSession[]) => boolean;
  /** Delay between exit-sequence keystrokes. Default 300ms; tests set 0. */
  rotateKeyDelayMs?: number;
}

/** The smart brain seam: a stalled candidate in, a nudge decision out. */
export type SmartDecider = (session: ActiveSession, candidate: WatchdogCandidate) => Promise<NudgeDecision>;

/** What the tick decided for a single session — the row `--json` / the tray reads. */
export interface SessionOutcome {
  sessionId?: string;
  kind: string;
  host?: string;
  cwd?: string;
  project?: string | null;
  label?: string;
  name?: string;
  /** The daemon-generated headline (PHNX-3797); carried so the report renders the
   * same name every other surface shows, not the raw first prompt. */
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
  /** classifyTerminal's verdict for this session. */
  stall: StallStatus['kind'];
  /** stalled duration (ms), when stalled. */
  stalledForMs?: number;
  policy: WatchdogPolicy;
  decision: 'nudge' | 'skip' | 'rotate';
  reason: string;
  /** The rotate machine's phase after this tick (decision === 'rotate'). */
  rotatePhase?: RotatePhase;
  /** The resolved rail, when delivered by injecting into a terminal split. */
  rail?: InjectRail;
  /** How the nudge was (or would be) delivered: inject | mailbox | resume. */
  via?: NudgeVia;
  /** True when resolveInjectTarget said addressable (only meaningful once we'd nudge). */
  addressable?: boolean;
  /** True when a nudge was actually delivered this tick (any mechanism). */
  injected?: boolean;
  /** The text that was (or would be) delivered. */
  nudgeText?: string;
}

/** Delivery mechanism the answer-router picked for a nudge. */
export type NudgeVia = 'inject' | 'mailbox' | 'resume';

export interface WatchdogTickResult {
  atMs: number;
  /** Whether this tick was allowed to inject (opts.nudge). */
  didNudge: boolean;
  outcomes: SessionOutcome[];
  /** Convenience counts for the menu-bar / status line. */
  counts: {
    total: number;
    stalled: number;
    nudged: number;
    unaddressable: number;
    skipped: number;
    /** Sessions the tick moved through the rotate machine (any phase). */
    rotating: number;
  };
  /** RUSH-2007 Layer C: per-session presence from this tick's scan. `transitions` holds only
   * sessions whose status flipped (interactive drop: reconnect-nudge candidate; headless remote:
   * keep-alive). Does not alter nudge decisions. */
  presence: {
    connected: number;
    disconnected: number;
    transitions: PresenceTransition[];
  };
}

// --- state persistence ------------------------------------------------------

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
    /* best-effort: the tray tolerates a missing/partial state file */
  }
}

/** Last-nudge timestamps keyed by sessionId (the cooldown ledger). */
function readNudgeLedger(dir: string): Record<string, number> {
  return readJsonFile<Record<string, number>>(path.join(dir, 'nudges.json'), {});
}

/** On-disk per-session policy sentinel `<stateDir>/policy/<sessionId>`: `off` | `keep` | `handsoff`;
 * absent, unreadable or unknown means keep. */
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

/** Write a per-session policy sentinel (used by the CLI `agents watchdog policy`). */
export function writePolicySentinel(dir: string, sessionId: string, policy: WatchdogPolicy): void {
  const file = path.join(dir, 'policy', sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, policy + '\n');
}

// --- helpers ----------------------------------------------------------------

function defaultLastActivity(s: ActiveSession): number | undefined {
  if (s.sessionFile) {
    try {
      return fs.statSync(s.sessionFile).mtimeMs;
    } catch {
      /* file vanished */
    }
  }
  return s.startedAtMs;
}

/** A decision for one idle session. `text` overrides the default nudge text. */
export interface NudgeDecision {
  nudge: boolean;
  reason: string;
  text?: string;
  /** On a skip, `true` = the agent judged the session genuinely needs the human (self-file reminder
   * or owner page); `false`/absent = idle and done. A finished session is never poked. */
  needsHuman?: boolean;
}

// --- delivery planning ------------------------------------------------------

/** How a decided nudge is delivered: a looping agent gets it in its mailbox (next tool call); a
 * parked agent gets it injected into its exact split, or resumed if headless; with no addressable
 * rail it is refused and flagged, never a guessed target. */
type DeliveryPlan =
  | { via: 'inject'; rail: InjectRail; target: InjectTarget }
  | { via: 'resume' }
  | { via: 'mailbox'; mailboxId: string }
  | { via: 'refuse'; reason: string; hint?: string };

/** Pick the delivery mechanism: resolveAnswerRoute chooses mailbox/resume/refuse;
 * resolveInjectTargetForSession supplies the inject target and handles the vscodium rail the
 * router cannot. A precise rail wins, so no nudge strands in an unread mailbox. */
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

  // A precise split (tmux / iTerm / vscodium) is the authoritative target.
  if (resolution.addressable) {
    return { via: 'inject', rail: resolution.rail, target: resolution.target };
  }
  // No precise rail: honor the answer-router's parked-agent decision.
  if (route.kind === 'resume') return { via: 'resume' };
  // Mailbox is right only for a still-looping agent with an open question block. A stalled agent
  // with no open block never polls it, so it is flagged instead of dropping a nudge into an unread
  // spool.
  if (route.kind === 'mailbox' && isOpenQuestionBlock(block)) return { via: 'mailbox', mailboxId };
  return {
    via: 'refuse',
    // answer-router's refuse reason already bakes in the recovery hint; the
    // resolver's reason does not, so carry hint separately for the caller.
    reason: route.kind === 'refuse' ? route.reason : resolution.reason,
    hint: route.kind === 'refuse' ? undefined : resolution.hint,
  };
}

/** Default open-block reader — the same lookup `agents message` uses. */
function defaultOpenBlockFor(session: ActiveSession): OpenBlock | null {
  const id = mailboxIdForActiveSession(session) ?? session.sessionId;
  if (!id) return null;
  const direct = readBlock(blockIdForSession(id));
  if (direct && direct.mailboxId === id) return direct;
  return null;
}

/** Enqueue a nudge into a session's mailbox (running agent, seen at next tool call). */
function deliverViaMailbox(mailboxId: string, text: string, block: OpenBlock | null): void {
  enqueue(mailboxDir(mailboxId), { to: mailboxId, text, from: 'watchdog', blockId: block?.blockId });
}

/** Re-enter a parked headless agent with the nudge as its next user turn. */
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

// --- the rotate machine (watchdog/rotate.ts) ----------------------------------

/** Everything advanceRotate needs from the tick — the runner's seam style. */
interface RotateAdvanceDeps {
  dir: string;
  nowMs: number;
  sessions: ActiveSession[];
  /** False on a dry tick (no --nudge): the machine waits, never injects. */
  mayInject: boolean;
  injectFn: (target: InjectTarget, text: string, opts: { dryRun?: boolean; enter?: boolean }) => Promise<InjectResult>;
  tuiLiveFor: (state: RotateState, sessions: ActiveSession[]) => boolean;
  injectDryRun?: boolean;
  logEvents: WatchdogEvent[];
  flags: Record<string, { reason: string; host?: string; atMs: number }>;
}

/** The one-line reason a rotate outcome carries. */
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

/** Advance ONE in-flight rotate by a tick. Only `awaiting-tui` normally spans ticks; persisted
 * `exiting`/`launching` are crash residue that fall to the readiness probe, `replaying`
 * re-delivers. At the deadline the session is failed and flagged, never blind-typed. */
async function advanceRotate(state: RotateState, deps: RotateAdvanceDeps): Promise<RotateState> {
  let s = state;
  const fail = (error: string): RotateState => {
    s = {
      ...s, phase: 'failed', error, updatedAtMs: deps.nowMs,
      // Failed-rotate retry cooldown (honored at begin): without it a session
      // whose old TUI ignored the exit sequence re-begins and deadline-fails
      // every tick forever.
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
      return s; // still inside the bounded wait
    }
    s = { ...s, phase: 'replaying', updatedAtMs: deps.nowMs };
    writeRotateState(deps.dir, s);
  }

  if (s.phase === 'replaying') {
    if (!deps.mayInject) return s; // dry tick: hold, never inject
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

// --- the tick ---------------------------------------------------------------

/** Run ONE watchdog pass, returning an outcome per live session. Injects only when `opts.nudge` is
 * set, the safety check says addressable, and policy permits. Persists the cooldown ledger, flags,
 * and last-tick snapshot. */
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

  // Rotate seams. Config is read per tick. The default readiness probe treats the new-session-id
  // transcript as primary, with a correlated fallback (after rotate, same cwd and machine); an
  // unrelated session must never satisfy it, or the replay lands in a bare shell.
  const rotateEnabled = opts.rotate ?? isWatchdogRotateEnabled();
  const rotateGate = opts.rotateGate ?? defaultRotateGate;
  const newSessionIdFor = opts.newSessionIdFor ?? (() => crypto.randomUUID());
  const rotateReadinessMs = opts.rotateReadinessMs ?? DEFAULT_ROTATE_READINESS_MS;
  const rotateKeyDelayMs = opts.rotateKeyDelayMs ?? 300;
  const tuiLiveFor = opts.tuiLiveFor ?? defaultTuiLiveFor;

  const sessions = opts.sessions ?? (await getActiveSessions());

  // RUSH-2007 Layer C: reconcile and persist per-session presence from this tick's active scan
  // (fleet-wide if the caller passes remote results). Additive: surfaces flips for the tray without
  // touching nudge decisions or adding SSH fan-out.
  const presenceResult = reconcilePresence(loadPresence(dir), observedFromActive(sessions), nowMs);
  savePresence(presenceResult.next, dir);
  const presence = {
    connected: Object.values(presenceResult.next).filter((r) => r.status === 'connected').length,
    disconnected: Object.values(presenceResult.next).filter((r) => r.status === 'disconnected').length,
    transitions: presenceResult.transitions,
  };

  const ledger = readNudgeLedger(dir);
  // Cooldown timestamps this tick decided to (re)start — merged into the ledger
  // under a lock at the end so a concurrent tick's updates are never lost.
  const ledgerUpdates: Record<string, number> = {};
  const flags: Record<string, { reason: string; host?: string; atMs: number }> = {};
  const outcomes: SessionOutcome[] = [];
  const logEvents: WatchdogEvent[] = [];
  const viaLabel = (plan: DeliveryPlan): string =>
    plan.via === 'inject' ? `inject (${plan.rail})` : plan.via;

  // Rotate bookkeeping for this tick: ids the in-loop path already advanced
  // (the post-loop sweep handles the rest — a session whose exit sequence
  // killed it drops out of the active list, so only the sweep can finish it).
  const advancedRotates = new Set<string>();
  const rotateDeps: RotateAdvanceDeps = {
    dir, nowMs, sessions,
    mayInject: opts.nudge === true,
    injectFn, tuiLiveFor,
    injectDryRun: opts.injectDryRun,
    logEvents, flags,
  };

  // Decide once with the agent: classify every session, collect idle ones (task + tail), and give
  // the whole set to the watchdog agent in ONE call (WD-GAP-1); tails are cached. A session with no
  // verdict is a safe skip, never a blind nudge.
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
    // Rotate takes precedence over the nudge agent: a session with an in-flight or failed-cooldown
    // rotate, or a hard account-limit tail, is owned by the rotate machine; "Continue." cannot fix
    // a capped account.
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
      // Test seam: a synthetic per-candidate decider, called once per candidate. A
      // skip with no explicit needsHuman defaults to surfacing it (same rule as the
      // agent path) so an unfinished session is never silently abandoned.
      for (const { session, candidate } of idleCandidates) {
        const raw = await opts.smartDecider(session, candidate);
        decisionByTerminal.set(candidate.terminalId, raw.nudge ? raw : { ...raw, needsHuman: raw.needsHuman ?? true });
      }
    } else {
      // Production: ONE batched agent call for every idle session this tick.
      const decide = opts.agentDecider ?? makeWatchdogAgentDecider(opts.smartAgent ?? 'claude');
      const verdicts = await decide(idleCandidates.map((e) => e.candidate));
      // A decider outage returns no verdicts while idle sessions exist; surface it as an error so
      // the tick is not an invisible no-op (the watchdog silently steering nothing is what this
      // subsystem prevents).
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
                // A skip with no explicit needsHuman defaults to surfacing it —
                // never silently abandon an unfinished session (the highest-risk state).
                needsHuman: d.action === 'skip' ? d.needsHuman ?? true : undefined,
              }
            // No verdict (agent undecided or outage): a neutral safe-skip, not "done" and not
            // needsHuman, nothing booked, so the next tick re-evaluates. Marking done would
            // abandon idle sessions on an outage; needsHuman would spam reminders.
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

    // A session with no id can neither be addressed nor cooldown-tracked.
    if (!session.sessionId) {
      outcomes.push({ ...base, reason: 'no session id (cannot address or track)' });
      continue;
    }
    // `off` = fully opted out. We short-circuit here rather than relying on
    // classifyTerminal (which is always called with optedOut: false below), so the
    // policy reason is reported explicitly.
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

    // Stalled — reuse the tail the pre-pass already read for the agent.
    const tailLines = tailCache.get(session.sessionId) ?? tailFor(session);
    const candidate: WatchdogCandidate = {
      terminalId: session.sessionId,
      agentType: (session.kind === 'codex' ? 'codex' : 'claude'),
      tailLines,
      stalledForMs: status.stalledForMs,
    };

    // An in-flight rotate owns this session: advance the machine, never nudge. A tail showing a
    // hard limit rotates in place, since "Continue." cannot unspend a capped account.
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
      // Failed-rotate retry cooldown: a terminal that already failed (e.g. its
      // old TUI ignored the exit sequence) is not re-entered until the
      // suppression recorded at the failure lapses.
      if (inflight && inflight.phase === 'failed' && (inflight.suppressUntilMs ?? 0) > nowMs) {
        outcomes.push({
          ...base, decision: 'skip', rotatePhase: 'failed',
          reason: `rotate suppressed until ${new Date(inflight.suppressUntilMs!).toISOString()} (failed-rotate cooldown)`,
        });
        continue;
      }

      const verdict = classifyTailForRotate(tailLines, nowMs);
      if (verdict.kind === 'rate_limited') {
        // handsoff = detect + flag, but never rotate (mirrors the nudge path).
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

        // Dry tick (no --nudge): report what WOULD happen, touch nothing.
        if (!opts.nudge) {
          outcomes.push({
            ...base, decision: 'rotate',
            reason: 'rate-limited — would rotate in place via `agents run auto` (dry — pass --nudge)',
          });
          continue;
        }

        // First-party health check, the same selection as `agents run auto`. Zero healthy: one
        // skip event per cooldown (earliest reset, else tail reset, else 30m), terminal untouched.
        // A gate throw degrades to a skip for this session, never aborting the tick.
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

        // The safety gate is the same one the nudge path obeys: an exact
        // addressable rail or an honest flag — never a guessed target.
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

        // Begin: persist exiting → inject the per-harness exit sequence →
        // launching → inject `agents run auto` → awaiting-tui (bounded). cwd +
        // machineHost are stored for the readiness fallback's correlation.
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
          // A real TUI needs a beat between Esc and the interrupt pair.
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

    // The decision was made up front by the watchdog agent over the whole idle
    // set (see the pre-pass). A session with no verdict is a safe skip.
    const decision: NudgeDecision =
      decisionByTerminal.get(session.sessionId) ??
      { nudge: false, reason: 'not evaluated by the watchdog agent', needsHuman: false };
    const chosenText = decision.text ?? nudgeText;

    // Log the decision for the Factory watchdog card.
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
      // Brain concluded "leave for human" (needsHuman === true): inject a self-file reminder so
      // the agent posts a feed block. Cheap skips (done, no stall) are not reminder-worthy; same
      // cooldown as a nudge.
      if (decision.needsHuman) {
        const lastNudgeMs = ledger[session.sessionId ?? ''] ?? 0;
        const cooldownMs = thresholds.cooldownMs;
        const withinCooldown = nowMs - lastNudgeMs < cooldownMs;
        if (opts.nudge && session.sessionId && !withinCooldown) {
          const existingBlock = openBlockFor(session);
          if (existingBlock === null) {
            // Determine addressability without planning the full nudge (no text needed).
            const resolution = resolveInjectTargetForSession(session, { allowGhosttyFocus: opts.allowGhosttyFocus });
            if (resolution.addressable) {
              // Addressable → inject a reminder asking the agent to self-file a feed block.
              const reminderText =
                'You appear stuck. If you genuinely need Muqsit, file it: ' +
                'agents feed post "<one-line ask>" --blocked --default "<safe default>". ' +
                'Otherwise keep going.';
              try {
                await injectFn(resolution.target, reminderText, { dryRun: opts.injectDryRun });
              } catch {
                // Swallow inject errors — reminder is best-effort; flag set below.
              }
              ledgerUpdates[session.sessionId] = nowMs;
            } else {
              // Un-addressable: the terminal cannot be reached, so the only way to reach the owner
              // is a declared block on the agent's behalf. The most important case; never let it
              // vanish silently.
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
                // publishBlock failure is non-fatal — best-effort owner page.
              }
            }
          }
        }
      }
      outcomes.push({ ...base, decision: 'skip', reason: decision.reason });
      continue;
    }

    // A nudge is warranted — plan delivery (answer-router picks mailbox/resume/
    // refuse; resolveInjectTargetForSession supplies the vscodium-aware inject
    // target) BEFORE any side effect.
    const block = openBlockFor(session);
    const plan = planDelivery(session, chosenText, block, opts.allowGhosttyFocus);
    const rail = plan.via === 'inject' ? plan.rail : undefined;
    const addressable = plan.via === 'inject' ? true : undefined;

    if (plan.via === 'refuse') {
      // No addressable rail and not headless-resumable: flag, never guess. Reached only for a
      // drive-forward poke (nudge === true, never needsHuman), so the owner is not paged; owner
      // paging happens only on the confirmed needsHuman path above. Only flagged for the tray.
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

    // handsoff = detect and flag, never deliver. Reached only for a drive-forward poke, so it must
    // not page the owner. A genuinely needs-human session is paged by the needsHuman path above,
    // which ignores policy: hands-off silences the forward nudge, not the "actually stuck" signal.
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

    // Dry status (no --nudge): report what WOULD happen, deliver nothing.
    if (!opts.nudge) {
      outcomes.push({
        ...base, decision: 'nudge', addressable, rail, via: plan.via, injected: false,
        reason: `would nudge via ${viaLabel(plan)} (dry — pass --nudge)`,
        nudgeText: chosenText,
      });
      continue;
    }

    // Deliver. injectDryRun exercises the path without side effects. `confirmed` distinguishes a
    // delivery known to reach the agent (tmux/iterm, mailbox, resume) from one merely dispatched
    // (vscodium fire-and-forget `--open-url`); only a confirmed delivery is booked as landed.
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
      ledgerUpdates[session.sessionId] = nowMs; // start the cooldown clock
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
      // Dispatched but unconfirmed (vscodium may have no-op'd the verb): do not claim it landed;
      // record `undelivered` so the phantom nudge is visible, and still start the cooldown so the
      // session is not re-nudged every tick.
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

  // Advance in-flight rotates the in-loop path did not touch: after the exit sequence kills the old
  // harness it drops out of the active list, so only this sweep can finish the machine. Runs even
  // if rotate was just disabled; a dry tick never injects (mayInject).
  for (const inflight of listInflightRotates(dir)) {
    if (advancedRotates.has(inflight.sessionId)) continue;
    await advanceRotate(inflight, rotateDeps);
  }

  // Persist the cooldown ledger under a lock: fresh-read + merge this tick's
  // updates + atomic write, so a concurrent tick's timestamps are never lost
  // (the old unlocked read-at-start / write-at-end was a lost-update race).
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
      /* best-effort: a lock failure must not throw out of a tick */
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

  // Heartbeat + decision/nudge events to the canonical watchdog.log the Factory
  // Floor reads. Best-effort; never throws into the tick.
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
