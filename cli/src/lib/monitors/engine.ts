
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

export const MONITOR_ENGINE_TICK_MS = 5_000;
const DEFAULT_INTERVAL_MS = 60_000;
const DROUGHT_THRESHOLD = 5;
export const POLL_SOURCE_TYPES = new Set(['command', 'poll', 'poll-http', 'file', 'device']);

export function shouldEscalateDrought(liveness: MonitorLivenessLike): boolean {
  return liveness.consecutiveErrors >= DROUGHT_THRESHOLD && !liveness.droughtNotifiedAt;
}

interface MonitorLivenessLike {
  consecutiveErrors: number;
  droughtNotifiedAt?: string;
}

interface FireDecision {
  fire: boolean;
  value: string;
  dedupeKey?: string;
  persist: boolean;
  event: MonitorEvent | null;
}

function truncateSummary(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 240 ? oneLine.slice(0, 240) + '…' : oneLine;
}

function buildEvent(monitor: MonitorConfig, summary: string, payload: Record<string, unknown>): MonitorEvent {
  return { monitorName: monitor.name, firedAt: new Date().toISOString(), summary, payload };
}

// Failed observations never move state; every-mode ignores blank output, while the first valid on-change value, even empty, becomes a silent baseline.
export function decideFire(monitor: MonitorConfig, observation: Observation): FireDecision {
  const cond = monitor.condition;
  const raw = observation.raw;
  const payload = observation.meta ?? {};
  const dedupeKey = cond.dedupeKey;

  if (observation.failed) {
    return { fire: false, value: raw, dedupeKey, persist: false, event: null };
  }

  if (cond.mode === 'every') {
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

export async function evaluateMonitorOnce(
  monitor: MonitorConfig,
): Promise<{ observation: Observation | null; decision: FireDecision | null }> {
  const observation = await evaluateSource(monitor.source);
  if (!observation) return { observation: null, decision: null };
  return { observation, decision: decideFire(monitor, observation) };
}

type LogFn = (level: string, message: string) => void;

export class MonitorEngine {
  private timer: NodeJS.Timeout | null = null;
  private monitors: MonitorConfig[] = [];
  private lastEval = new Map<string, number>();
  private ticking = false;
  private running = false;

  constructor(private logFn: LogFn = () => {}) {}

  start(options: { externalScheduler?: boolean } = {}): void {
    this.running = true;
    this.loadAll();
    this.logFn('INFO', `Monitor engine started (${this.monitors.length} monitor(s) on this device)`);
    if (!options.externalScheduler) {
      this.timer = setInterval(() => void this.tick(), MONITOR_ENGINE_TICK_MS);
    }
  }

  reload(): void {
    this.loadAll();
    this.logFn('INFO', `Monitor engine reloaded (${this.monitors.length} monitor(s) on this device)`);
  }

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

  async tick(): Promise<void> {
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

  async runMonitor(monitor: MonitorConfig): Promise<void> {
    const isPollSource = POLL_SOURCE_TYPES.has(monitor.source.type);
    if (!isPollSource) return;
    const checkedAt = new Date().toISOString();
    let checkError: string | undefined;
    try {
      const observation = await evaluateSource(monitor.source);
      if (!observation) {
        checkError = 'source produced no observation';
      } else if (observation.failed) {
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
          writeState(monitor.name, decision.value, decision.dedupeKey);
        }
      }
    } catch (err) {
      checkError = (err as Error).message;
      this.logFn('ERROR', `monitor '${monitor.name}' evaluation failed: ${checkError}`);
    }
    this.afterCheck(monitor, checkedAt, checkError);
  }

  // Liveness is independent of change state: every poll updates it and recovery resets the drought.
  private afterCheck(monitor: MonitorConfig, checkedAt: string, error?: string): void {
    const liveness = recordCheck(monitor.name, checkedAt, error);
    if (error && shouldEscalateDrought(liveness)) {
      void this.escalateDrought(monitor, liveness.consecutiveErrors, error);
    }
  }

  private async escalateDrought(
    monitor: MonitorConfig,
    consecutiveErrors: number,
    error: string,
  ): Promise<void> {
    const at = new Date().toISOString();
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

    if (monitor.rateLimit) {
      const windowMs = parseInterval(monitor.rateLimit.per) ?? 60_000;
      fireTimes = recordFireTime(monitor.name, now, windowMs);
      if (fireTimes.length > monitor.rateLimit.max) {
        writeFireRecord(event, { action: monitor.action.type, ok: false, error: 'rate limited — auto-paused' });
        writeState(monitor.name, decision.value, decision.dedupeKey, { lastFiredAt: event.firedAt, fireTimes });
        try {
          setMonitorEnabled(monitor.name, false);
        } catch {  }
        this.logFn(
          'WARN',
          `monitor '${monitor.name}' exceeded rate limit (${monitor.rateLimit.max}/${monitor.rateLimit.per}) — auto-paused`,
        );
        this.loadAll();
        return { kind: monitor.action.type, ok: true };
      }
    }

    let result: DispatchResult;
    try {
      result = await dispatchAction(monitor, event);
    } catch (err) {
      result = { kind: monitor.action.type, ok: false, error: (err as Error).message };
    }

    const runStatusAtFire = result.runId ? readRunMeta(monitor.name, result.runId)?.status : undefined;

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
