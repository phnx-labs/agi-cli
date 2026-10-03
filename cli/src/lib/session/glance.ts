import { cleanFirstUserMessage } from './prompt.js';
import { isSubAgentTool } from './highlights.js';
import { toolFailureKind } from './tool-outcome.js';
import { redactSecrets, sanitizeForTerminal } from '../redact.js';
import type { SessionAttachment, SessionEvent, SessionFailure, SessionGlance, SessionUserTurn } from './types.js';

interface PendingCall { tool: string; summary: string; command?: string }
interface UserTurn extends SessionUserTurn { key: string }

/** Only timing counters grow with the session: exact rebucketing needs their original timestamps. */
export interface GlanceState {
  startMs?: number;
  endMs?: number;
  counts: [atMs: number, tools: number, failed: number, blocked: number][];
  model?: string;
  failures: SessionFailure[];
  turns: UserTurn[];
  pending: Record<string, PendingCall>;
  attachments: { attachment: SessionAttachment; turnKey?: string }[];
  failedAgentCalls: string[];
}

export function emptyGlanceState(): GlanceState {
  return { counts: [], failures: [], turns: [], pending: {}, attachments: [], failedAgentCalls: [] };
}

function excerpt(text: string, max: number): string {
  return redactSecrets(sanitizeForTerminal(text)).slice(0, max);
}

function callSummary(event: SessionEvent): PendingCall {
  const args = event.args ?? {};
  const command = event.command ?? args.command ?? args.cmd;
  const value = command ?? event.path ?? args.file_path ?? args.path ?? args.pattern ?? args.description ?? event.label ?? '';
  return {
    tool: event.tool ?? 'unknown',
    summary: excerpt(typeof value === 'string' ? value : '', 140),
    ...(typeof command === 'string' ? { command: excerpt(command, 256) } : {}),
  };
}

/** Fold already-parsed events; no transcript I/O, including across chunk boundaries. */
export function foldGlanceEvent(state: GlanceState, event: SessionEvent): void {
  const atMs = Date.parse(event.timestamp);
  const timed = Number.isFinite(atMs);
  if (timed) {
    state.startMs = Math.min(state.startMs ?? atMs, atMs);
    state.endMs = Math.max(state.endMs ?? atMs, atMs);
  }
  if (event.model && (event.type === 'usage' || event.type === 'init' || event.role === 'assistant')) state.model = event.model;
  const call = event.callId ? state.pending[event.callId] : undefined;
  const kind = toolFailureKind(event, call);
  if (timed && (event.type === 'tool_use' || kind)) {
    let counts = state.counts[state.counts.length - 1];
    if (!counts || counts[0] !== atMs) state.counts.push(counts = [atMs, 0, 0, 0]);
    if (event.type === 'tool_use') counts[1]++;
    if (kind === 'failed') counts[2]++;
    if (kind === 'blocked') counts[3]++;
  }
  if (event.type === 'tool_use' && event.callId) state.pending[event.callId] = callSummary(event);
  if (event.type === 'tool_result' || event.type === 'error') {
    if (kind && timed) {
      const info = call ?? callSummary(event);
      const error = (event.output ?? event.content ?? '').split(/\r?\n/).map(line => line.trim()).find(Boolean)
        ?? (event.exitCode !== undefined ? `exit ${event.exitCode}` : 'Tool execution failed');
      state.failures.push({ atMs, tool: info.tool, summary: info.summary, error: excerpt(error, 160), blocked: kind === 'blocked' });
      state.failures = state.failures.slice(-20);
      if (event.callId && isSubAgentTool(info.tool, info.command ?? '') && !state.failedAgentCalls.includes(event.callId)) {
        state.failedAgentCalls.push(event.callId);
      }
    }
    if (event.callId) delete state.pending[event.callId];
  }
  if (event._synthetic || !timed) return;
  const text = event.type === 'message' && event.role === 'user' ? cleanFirstUserMessage(event.content) : undefined;
  if (!text && event.type !== 'attachment') return;
  const key = event._turnId ?? event.timestamp;
  let turn = state.turns.find(turn => turn.key === key);
  if (!turn && (text || event._turnId)) {
    turn = { key, atMs, text: '', images: 0 };
    state.turns.push(turn);
    state.turns = state.turns.slice(-50);
  }
  if (text && turn) turn.text = excerpt(turn.text ? `${turn.text}\n${text}` : text, 300);
  if (event.type === 'attachment') {
    if (turn && event.mediaType?.startsWith('image/')) turn.images++;
    const attachment: SessionAttachment = {
      ...(event.path ? { path: event.path } : {}),
      ...(event.name ? { name: event.name } : {}),
      mediaType: event.mediaType ?? 'application/octet-stream',
      ...(event.sizeBytes !== undefined ? { sizeBytes: event.sizeBytes } : {}),
    };
    state.attachments.push({ attachment, turnKey: key });
    state.attachments = state.attachments.slice(-50);
  }
}

export function deriveGlance(events: SessionEvent[]): GlanceState {
  const state = emptyGlanceState();
  for (const event of events) foldGlanceEvent(state, event);
  return state;
}

export function projectGlance(state: GlanceState): SessionGlance {
  const userTurns = state.turns.map(({ key: _key, ...turn }) => turn);
  const attachments = state.attachments.map(({ attachment, turnKey }) => {
    const turnIndex = state.turns.findIndex(turn => turn.key === turnKey);
    return { ...attachment, ...(turnIndex >= 0 ? { turnIndex } : {}) };
  });
  const result: SessionGlance = {
    ...(state.model ? { model: state.model } : {}),
    ...(state.failures.length ? { failures: state.failures } : {}),
    ...(userTurns.length ? { userTurns } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
  if (state.startMs !== undefined && state.endMs !== undefined) {
    const buckets = Array.from({ length: 48 }, () => ({ tools: 0, failed: 0, blocked: 0 }));
    const span = state.endMs - state.startMs;
    for (const [atMs, tools, failed, blocked] of state.counts) {
      const index = span === 0 ? 0 : Math.max(0, Math.min(47, Math.floor((atMs - state.startMs) * 48 / span)));
      buckets[index].tools += tools;
      buckets[index].failed += failed;
      buckets[index].blocked += blocked;
    }
    result.activityHistogram = { startMs: state.startMs, endMs: state.endMs, buckets, userAtMs: userTurns.map(turn => turn.atMs) };
  }
  return result;
}

