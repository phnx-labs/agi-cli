/**
 * Monitor evaluate/fire loop.
 *
 * Modeled on the routines daemon: a single MonitorEngine lives inside runDaemon()
 * beside the cron JobScheduler. On each tick it evaluates every enabled monitor
 * that is DUE and owned by this device, applies the condition through the native
 * state-diff store, and on a fire dispatches the action, writes a fire record, and
 * updates state. A per-monitor rate limit auto-pauses a firehose.
 *
 * v1 covers the poll model (command, poll, poll-http, file, device). Push sources
 * (ws, webhook) return null from `evaluate` — they deliver through `subscribe` /
 * the webhook receiver, wired in a follow-up; the engine treats them as inert.
 */

import {
  listMonitors,
  monitorRunsOnThisDevice,
  parseInterval,
  setMonitorEnabled,
  type MonitorConfig,
  type MonitorEvent,
} from './config.js';
import { evaluateSource, type Observation } from './sources/index.js';
import {
  hasChanged,
  readState,
  writeState,
  recordFireTime,
  writeFireRecord,
  recordCheck,
  readLiveness,
  markDroughtNotified,
} from './state.js';
import { dispatchAction, injectEvent, type DispatchResult } from './dispatch.js';
import { sendToOwner } from '../notify.js';
import { readRunMeta } from '../scheduling/routines.js';

/** How often the engine wakes to check which monitors are due. */
export const MONITOR_ENGINE_TICK_MS = 5_000;
/** Default evaluation cadence for sources that carry no explicit interval. */
const DEFAULT_INTERVAL_MS = 60_000;
/**
 * Consecutive failed polls before the engine escalates a drought to the owner.
 * A monitor that looks healthy (enabled, daemon up) but whose source errors
 * every poll does no real work — the "every signal reads healthy while zero work
 * happened" failure RUSH-2485 is about. One notification per drought.
 */
const DROUGHT_THRESHOLD = 5;
/** Poll-model source types the engine actually evaluates on a cadence; ws/webhook are push-only and inert here. */
export const POLL_SOURCE_TYPES = new Set(['command', 'poll', 'poll-http', 'file', 'device']);

/**
 * Whether a monitor's liveness has crossed into a drought worth notifying the
 * owner about: enough consecutive failed checks, and not already notified for
 * this drought. Pure so the branch is unit-testable without a real notify.
 */
export function shouldEscalateDrought(liveness: MonitorLivenessLike): boolean {
  return liveness.consecutiveErrors >= DROUGHT_THRESHOLD && !liveness.droughtNotifiedAt;
}

/** The liveness fields the drought predicate reads. */
interface MonitorLivenessLike {
  consecutiveErrors: number;
  droughtNotifiedAt?: string;
}

/** The fire/no-fire decision for one observation, plus what to persist. */
interface FireDecision {
  fire: boolean;
  /** The value whose de-dupe signature is stored on persist. */
  value: string;
  /** The de-dupe key (regex) applied to the value, if any. */
  dedupeKey?: string;
  /** Persist `value` as the new baseline even when not firing (on-change baseline). */
  persist: boolean;
  /** The event to dispatch, present iff `fire`. */
  event: MonitorEvent | null;
}

function truncateSummary(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 240 ? oneLine.slice(0, 240) + '…' : oneLine;
}

function buildEvent(monitor: MonitorConfig, summary: string, payload: Record<string, unknown>): MonitorEvent {
  return { monitorName: monitor.name, firedAt: new Date().toISOString(), summary, payload };
}

/**
 * Apply a monitor's condition to an observation. Pure (reads state, never
 * writes), so both the tick loop and the `test` dry-run share it.
 */
export function decideFire(monitor: MonitorConfig, observation: Observation): FireDecision {
  const cond = monitor.condition;
  const raw = observation.raw;
  const payload = observation.meta ?? {};
  const dedupeKey = cond.dedupeKey;

  // A snapshot the source flagged as an OBSERVATION FAILURE (a poll that exited
  // non-zero or emitted a transport/auth/rate-limit error) is never a value
  // change: don't fire, don't move the baseline — so an empty→error→empty flap
  // can't read as two value changes (PHNX-3510). The engine records it as a
  // failed check separately, feeding the drought health streak.
  if (observation.failed) {
    return { fire: false, value: raw, dedupeKey, persist: false, event: null };
  }

  if (cond.mode === 'every') {
    // Fire on every tick that carries a real observation. An empty (or
    // whitespace-only) observation means "nothing to report": firing an action
    // with an empty {event} is never useful, and skipping it lets a poll whose
    // command yields no rows (e.g. no mergeable PR) stay silent while still
    // re-firing every tick the set is non-empty — the retry semantics a
    // silently-failed action dispatch needs (RUSH-2488).
    if (raw.trim() === '') {
      return { fire: false, value: raw, dedupeKey, persist: false, event: null };
    }
    return {
      fire: true,
      value: raw,
      dedupeKey,
      persist: false,
      event: buildEvent(monitor, truncateSummary(raw), payload),
    };
  }

  if (cond.mode === 'match') {
    let matched: RegExpExecArray | null = null;
    try {
      matched = new RegExp(cond.match ?? '').exec(raw);
    } catch {
      matched = null;
    }
    if (!matched) {
      return { fire: false, value: raw, dedupeKey, persist: false, event: null };
    }
    const matchedValue = matched[0];
    const changed = hasChanged(monitor.name, matchedValue, dedupeKey);
    return {
      fire: changed,
      value: matchedValue,
      dedupeKey,
      persist: changed,
      event: changed ? buildEvent(monitor, truncateSummary(matchedValue), payload) : null,
    };
  }

  // on-change (default): the first observation establishes a silent baseline;
  // thereafter fire when the de-dupe signature differs from last-seen.
  const prior = readState(monitor.name);
  if (!prior) {
    return { fire: false, value: raw, dedupeKey, persist: true, event: null };
  }
  const changed = hasChanged(monitor.name, raw, dedupeKey);
  return {
    fire: changed,
    value: raw,
    dedupeKey,
    persist: changed,
    event: changed ? buildEvent(monitor, truncateSummary(raw), payload) : null,
  };
}

/** One evaluation of a monitor's source + condition, without side effects. Used by `test`. */
export async function evaluateMonitorOnce(
  monitor: MonitorConfig,
): Promise<{ observation: Observation | null; decision: FireDecision | null }> {
  const observation = await evaluateSource(monitor.source);
  if (!observation) return { observation: null, decision: null };
  return { observation, decision: decideFire(monitor, observation) };
}

type LogFn = (level: string, message: string) => void;

/** The durable monitor engine. One instance per daemon. */
export class MonitorEngine {
  private timer: NodeJS.Timeout | null = null;
  private monitors: MonitorConfig[] = [];
  private lastEval = new Map<string, number>();
  private ticking = false;
  private running = false;

  constructor(private logFn: LogFn = () => {}) {}

  /** Load owned+enabled monitors and start the tick loop. */
  start(options: { externalScheduler?: boolean } = {}): void {
    this.running = true;
    this.loadAll();
    this.logFn('INFO', `Monitor engine started (${this.monitors.length} monitor(s) on this device)`);
    if (!options.externalScheduler) {
      this.timer = setInterval(() => void this.tick(), MONITOR_ENGINE_TICK_MS);
    }
  }

  /** Reload monitor configs (SIGHUP). */
  reload(): void {
    this.loadAll();
    this.logFn('INFO', `Monitor engine reloaded (${this.monitors.length} monitor(s) on this device)`);
  }

  /** Stop the tick loop. No monitor dispatches after this until `start()`. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private loadAll(): void {
    this.monitors = listMonitors().filter((m) => m.enabled && monitorRunsOnThisDevice(m));
  }

  private intervalMs(monitor: MonitorConfig): number {
    if (monitor.source.interval) return parseInterval(monitor.source.interval) ?? DEFAULT_INTERVAL_MS;
    return DEFAULT_INTERVAL_MS;
  }

  private isDue(monitor: MonitorConfig, now: number): boolean {
    const last = this.lastEval.get(monitor.name) ?? 0;
    return now - last >= this.intervalMs(monitor);
  }

  /** Evaluate every due monitor once. Overlap-guarded so a slow cycle never stacks. */
  async tick(): Promise<void> {
    // A stopped engine dispatches nothing (PHNX-3608): under the external
    // scheduler the supervisor owns the timer, so a `stop()` (monitors service
    // disabled) must be honoured HERE — otherwise the next supervised tick would
    // still fire the last-loaded monitors even though the engine is stopped.
    if (!this.running || this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      for (const monitor of this.monitors) {
        if (!this.isDue(monitor, now)) continue;
        this.lastEval.set(monitor.name, now);
        await this.runMonitor(monitor);
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Evaluate one monitor once and record the outcome. Public so the daemon tick
   * and tests drive the exact same path. A "failed check" is an evaluation that
   * produced no observation, threw, OR fired an action that failed — all three
   * are "the monitor ran and accomplished nothing", the drought signal. A poll
   * that observes and either fires cleanly or matches nothing is a success and
   * resets the streak.
   */
  async runMonitor(monitor: MonitorConfig): Promise<void> {
    // Push-only sources (ws/webhook) deliver through subscribe, not this loop —
    // they return null from evaluate by design, so they have no poll to record.
    const isPollSource = POLL_SOURCE_TYPES.has(monitor.source.type);
    if (!isPollSource) return;
    const checkedAt = new Date().toISOString();
    let checkError: string | undefined;
    try {
      const observation = await evaluateSource(monitor.source);
      if (!observation) {
        checkError = 'source produced no observation';
      } else if (observation.failed) {
        // The poll ran but did not OBSERVE (non-zero exit, or a transport/auth/
        // rate-limit error in its output). Skip it entirely: no decideFire, no
        // fire, watched-state untouched — so no empty→error→empty flap dispatches
        // an agent on a dead premise. Record it as a failed check so a sustained
        // streak escalates as a drought, the same health surface `--postcondition`
        // uses on the action side (PHNX-3510).
        checkError = `poll failed: ${observation.failureReason ?? 'observation failure'}`;
        this.logFn(
          'WARN',
          `monitor '${monitor.name}' poll failed (${observation.failureReason ?? 'observation failure'}) — not treated as a value change`,
        );
      } else {
        const decision = decideFire(monitor, observation);
        if (decision.fire && decision.event) {
          const result = await this.fire(monitor, decision, decision.event);
          if (!result.ok) checkError = `action ${result.kind} failed: ${result.error ?? 'unknown'}`;
        } else if (decision.persist) {
          // Silent baseline / no-change: record the value so we don't re-fire.
          writeState(monitor.name, decision.value, decision.dedupeKey);
        }
      }
    } catch (err) {
      checkError = (err as Error).message;
      this.logFn('ERROR', `monitor '${monitor.name}' evaluation failed: ${checkError}`);
    }
    this.afterCheck(monitor, checkedAt, checkError);
  }

  /**
   * Record the poll heartbeat and, on a sustained failure streak, escalate a
   * drought to the owner exactly once. The heartbeat is what makes a
   * polling-but-not-matching monitor visibly distinct from one the engine never
   * touched (RUSH-2485); the streak is what turns "every poll fails and the owner
   * never hears about it" into one notification.
   */
  private afterCheck(monitor: MonitorConfig, checkedAt: string, error?: string): void {
    const liveness = recordCheck(monitor.name, checkedAt, error);
    if (error && shouldEscalateDrought(liveness)) {
      void this.escalateDrought(monitor, liveness.consecutiveErrors, error);
    }
  }

  /** Notify the owner that an enabled monitor has failed N checks in a row and done nothing. */
  private async escalateDrought(
    monitor: MonitorConfig,
    consecutiveErrors: number,
    error: string,
  ): Promise<void> {
    const at = new Date().toISOString();
    // Stamp the marker BEFORE the send so a slow/failing notify can't re-fire the
    // drought on the next tick; recordCheck clears it on the first good check.
    markDroughtNotified(monitor.name, at);
    const text =
      `Monitor '${monitor.name}' has failed ${consecutiveErrors} checks in a row and accomplished nothing. ` +
      `Last error: ${error}`;
    try {
      const result = await sendToOwner(text);
      this.logFn(
        result.ok ? 'WARN' : 'ERROR',
        `monitor '${monitor.name}' drought (${consecutiveErrors} failed checks) → notify owner` +
          (result.ok ? '' : ` FAILED: ${result.error}`),
      );
    } catch (err) {
      this.logFn('ERROR', `monitor '${monitor.name}' drought notify threw: ${(err as Error).message}`);
    }
  }

  private async fire(monitor: MonitorConfig, decision: FireDecision, event: MonitorEvent): Promise<DispatchResult> {
    const now = Date.now();
    let fireTimes: number[] | undefined;

    // Firehose guard: auto-pause a monitor that exceeds its rate limit.
    if (monitor.rateLimit) {
      const windowMs = parseInterval(monitor.rateLimit.per) ?? 60_000;
      fireTimes = recordFireTime(monitor.name, now, windowMs);
      if (fireTimes.length > monitor.rateLimit.max) {
        // Record the tripped event in fire history too, so `agents monitors runs`
        // reflects what `view`'s `lastFiredAt` shows — the firehose event the guard
        // exists to surface must not be invisible in the fire log.
        writeFireRecord(event, { action: monitor.action.type, ok: false, error: 'rate limited — auto-paused' });
        writeState(monitor.name, decision.value, decision.dedupeKey, { lastFiredAt: event.firedAt, fireTimes });
        try {
          setMonitorEnabled(monitor.name, false);
        } catch { /* best-effort pause */ }
        this.logFn(
          'WARN',
          `monitor '${monitor.name}' exceeded rate limit (${monitor.rateLimit.max}/${monitor.rateLimit.per}) — auto-paused`,
        );
        this.loadAll();
        // An auto-pause is a deliberate stop, not a failed action — don't let it
        // feed the drought streak (the monitor is now disabled anyway).
        return { kind: monitor.action.type, ok: true };
      }
    }

    let result: DispatchResult;
    try {
      result = await dispatchAction(monitor, event);
    } catch (err) {
      result = { kind: monitor.action.type, ok: false, error: (err as Error).message };
    }

    // Best-effort snapshot of the run's status AT THIS INSTANT — the same
    // synchronous view `dispatchAction` just returned from. For the async-race
    // case (RUSH-2690) this reads 'running': the dispatched process is still
    // in flight, `ok` was frozen on that transient state, and the real outcome
    // is not known yet. Recorded so a future reconciliation pass can find
    // exactly the fires whose `ok` needs revisiting; `resolveFireOutcome`
    // (state.ts) never trusts this field — it re-reads the run fresh instead.
    const runStatusAtFire = result.runId ? readRunMeta(monitor.name, result.runId)?.status : undefined;

    // Snapshot the postcondition with `{event}` already interpolated so a later
    // `resolveFireOutcome` can assert the stated effect without re-reading YAML
    // (PHNX-2842). Notify/webhook-out have no run to settle, so they skip this.
    const postcondition = (result.kind === 'run' || result.kind === 'routine') && monitor.action.postcondition
      ? injectEvent(monitor.action.postcondition, event)
      : undefined;

    writeFireRecord(event, {
      ...(result.runId ? { runId: result.runId } : {}),
      action: result.kind,
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
      ...(runStatusAtFire ? { runStatusAtFire } : {}),
      ...(postcondition ? { postcondition } : {}),
    });
    writeState(monitor.name, decision.value, decision.dedupeKey, { lastFiredAt: event.firedAt, fireTimes });

    this.logFn(
      result.ok ? 'INFO' : 'ERROR',
      `monitor '${monitor.name}' fired → ${result.kind}` +
        (result.runId ? ` (run: ${result.runId})` : '') +
        (result.ok ? '' : ` FAILED: ${result.error}`),
    );
    return result;
  }
}
