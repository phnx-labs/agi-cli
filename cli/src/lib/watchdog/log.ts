import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withFileLock, atomicWriteFileSync, ensureLockTarget } from '../fs-atomic.js';

// AGI EXT reads this JSONL path and event shape directly; treat both as an external contract.
export const WATCHDOG_LOG_PATH = path.join(os.homedir(), '.agents', '.cache', 'logs', 'watchdog.log');

export type WatchdogEventKind = 'tick' | 'decision' | 'nudge' | 'undelivered' | 'rotate' | 'error';

export interface WatchdogEvent {
  ts: number;
  kind: WatchdogEventKind;
  terminalId?: string;
  agentType?: string;
  message: string;
  reason?: string;
  tailLines?: string[];
  stalledForMs?: number;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  nudgeText?: string;
  inspections?: WatchdogInspection[];
}

export interface WatchdogInspection {
  terminalId?: string;
  agentType: string;
  message: string;
  reason: string;
  stalledForMs?: number;
}

const WATCHDOG_EVENT_KINDS = new Set<WatchdogEventKind>(['tick', 'decision', 'nudge', 'undelivered', 'rotate', 'error']);

export function parseWatchdogEvents(text: string): WatchdogEvent[] {
  // Ignore malformed or partial final rows so an interrupted append cannot hide older history.
  const events: WatchdogEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof value.ts !== 'number' ||
        !Number.isFinite(value.ts) ||
        typeof value.kind !== 'string' ||
        !WATCHDOG_EVENT_KINDS.has(value.kind as WatchdogEventKind) ||
        typeof value.message !== 'string'
      ) continue;
      const inspections = Array.isArray(value.inspections)
        ? value.inspections.flatMap((item): WatchdogInspection[] => {
          if (item === null || typeof item !== 'object') return [];
          const row = item as Record<string, unknown>;
          if (typeof row.agentType !== 'string' || typeof row.message !== 'string' || typeof row.reason !== 'string') return [];
          return [{
            terminalId: typeof row.terminalId === 'string' ? row.terminalId : undefined,
            agentType: row.agentType,
            message: row.message,
            reason: row.reason,
            stalledForMs: typeof row.stalledForMs === 'number' ? row.stalledForMs : undefined,
          }];
        })
        : undefined;
      events.push({
        ts: value.ts,
        kind: value.kind as WatchdogEventKind,
        message: value.message,
        terminalId: typeof value.terminalId === 'string' ? value.terminalId : undefined,
        agentType: typeof value.agentType === 'string' ? value.agentType : undefined,
        reason: typeof value.reason === 'string' ? value.reason : undefined,
        tailLines: Array.isArray(value.tailLines)
          ? value.tailLines.filter((item): item is string => typeof item === 'string')
          : undefined,
        stalledForMs: typeof value.stalledForMs === 'number' ? value.stalledForMs : undefined,
        lastUserMessage: typeof value.lastUserMessage === 'string' ? value.lastUserMessage : undefined,
        lastAssistantMessage: typeof value.lastAssistantMessage === 'string' ? value.lastAssistantMessage : undefined,
        nudgeText: typeof value.nudgeText === 'string' ? value.nudgeText : undefined,
        inspections,
      });
    } catch {
    }
  }
  return events;
}

export function readWatchdogEvents(logPath = WATCHDOG_LOG_PATH): WatchdogEvent[] {
  if (!fs.existsSync(logPath)) return [];
  return parseWatchdogEvents(fs.readFileSync(logPath, 'utf8'));
}

export function formatEvent(ev: WatchdogEvent): string {
  return JSON.stringify(ev);
}

const WATCHDOG_LOG_MAX_LINES = 5000;
export const WATCHDOG_TAIL_MAX_CHARS = 4096;

export function boundTailLines(lines: string[], maxChars = WATCHDOG_TAIL_MAX_CHARS): string[] {
  const kept: string[] = [];
  let remaining = maxChars;
  for (let i = lines.length - 1; i >= 0 && remaining > 0; i--) {
    const line = lines[i];
    if (line.length <= remaining) {
      kept.unshift(line);
      remaining -= line.length;
    } else {
      kept.unshift(line.slice(-remaining));
      remaining = 0;
    }
  }
  return kept;
}

export function trimToLast(text: string, maxLines: number): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length <= maxLines) return lines.join('\n') + (lines.length ? '\n' : '');
  return lines.slice(lines.length - maxLines).join('\n') + '\n';
}

export function appendWatchdogEvents(
  events: WatchdogEvent[],
  opts: { logPath?: string; maxLines?: number } = {},
): void {
  // Bound retained transcript exposure and cache growth; tail content remains intentionally persisted.
  if (events.length === 0) return;
  const logPath = opts.logPath ?? WATCHDOG_LOG_PATH;
  const maxLines = opts.maxLines ?? WATCHDOG_LOG_MAX_LINES;
  const lockPath = path.join(path.dirname(logPath), '.watchdog.log.lock');
  try {
    ensureLockTarget(lockPath);
    // Serialize read/trim/replace; atomic replacement alone would still lose concurrent appends.
    withFileLock(lockPath, () => {
      let existing = '';
      try {
        existing = fs.readFileSync(logPath, 'utf8');
      } catch {
      }
      const boundedEvents = events.map((event) => event.tailLines === undefined
        ? event
        : { ...event, tailLines: boundTailLines(event.tailLines) });
      const appended = boundedEvents.map(formatEvent).join('\n') + '\n';
      const body = trimToLast(existing + appended, maxLines);
      atomicWriteFileSync(logPath, body);
    });
  } catch {
    // Observability is best-effort and must never abort a watchdog tick.
  }
}
