import * as fs from 'node:fs';
import type { ActiveSession } from './active.js';

export interface PendingWorkItem {
  id: string;
  description: string;
  startedAtMs?: number;
}

export interface SessionPendingWork {
  subagents: PendingWorkItem[];
  shells: PendingWorkItem[];
  monitors: PendingWorkItem[];
}

export type SessionEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const EFFORTS: ReadonlySet<string> = new Set<SessionEffort>(['low', 'medium', 'high', 'xhigh', 'max']);

interface BackgroundTask {
  kind: 'shell' | 'monitor';
  toolUseId: string;
  taskId?: string;
  description: string;
  startedAtMs?: number;
  timeoutMs?: number;
  persistent?: boolean;
}

interface PendingFold {
  agent: 'claude' | 'codex';
  offset: number;
  partial: string;
  ino: number;
  tasks: Map<string, BackgroundTask>;
  bashCalls: Map<string, { description: string; startedAtMs?: number }>;
  stopCalls: Map<string, string>;
  lastAssistant?: string;
  effort?: SessionEffort;
  fast?: boolean;
}

const folds = new Map<string, PendingFold>();

export const PENDING_COLD_TAIL_BYTES = 64 * 1024 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_PARTIAL_BYTES = 1024 * 1024;
const MAX_BASH_CALLS = 256;
const MAX_FOLDS = 512;

const NOTIFICATION_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g;

function tag(body: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(body);
  return match?.[1]?.trim() || undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim().slice(0, 200) : undefined;
}

function epoch(value: unknown): number | undefined {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

function endTask(fold: PendingFold, id: string | undefined): void {
  if (!id) return;
  if (fold.tasks.delete(id)) return;
  for (const [key, task] of fold.tasks) {
    if (task.taskId === id) { fold.tasks.delete(key); return; }
  }
}

function contentBlocks(record: Record<string, unknown>): Array<Record<string, unknown>> {
  const message = record.message as { content?: unknown } | undefined;
  return Array.isArray(message?.content) ? message.content.filter((b): b is Record<string, unknown> => !!b && typeof b === 'object') : [];
}

function foldClaudeToolUses(fold: PendingFold, record: Record<string, unknown>): void {
  const startedAtMs = epoch(record.timestamp);
  for (const block of contentBlocks(record)) {
    if (block.type !== 'tool_use' || typeof block.id !== 'string') continue;
    const input = (block.input ?? {}) as Record<string, unknown>;
    const description = text(input.description) ?? text(input.command);
    if (block.name === 'Bash') {
      if (input.run_in_background === true) {
        fold.tasks.set(block.id, { kind: 'shell', toolUseId: block.id, description: description ?? 'Background command', ...(startedAtMs !== undefined ? { startedAtMs } : {}) });
      } else {
        fold.bashCalls.set(block.id, { description: description ?? 'Background command', ...(startedAtMs !== undefined ? { startedAtMs } : {}) });
        if (fold.bashCalls.size > MAX_BASH_CALLS) fold.bashCalls.delete(fold.bashCalls.keys().next().value!);
      }
    } else if (block.name === 'Monitor') {
      fold.tasks.set(block.id, {
        kind: 'monitor', toolUseId: block.id, description: description ?? 'Monitor',
        ...(startedAtMs !== undefined ? { startedAtMs } : {}),
        ...(typeof input.timeout_ms === 'number' ? { timeoutMs: input.timeout_ms } : {}),
        ...(input.persistent === true ? { persistent: true } : {}),
      });
    } else if (block.name === 'TaskStop' || block.name === 'KillShell') {
      const target = text(input.task_id) ?? text(input.shell_id);
      if (target) fold.stopCalls.set(block.id, target);
    }
  }
}

function foldClaudeToolResults(fold: PendingFold, record: Record<string, unknown>): void {
  const result = (record.toolUseResult ?? {}) as Record<string, unknown>;
  const taskId = text(result.backgroundTaskId) ?? text(result.taskId);
  for (const block of contentBlocks(record)) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
    const id = block.tool_use_id;
    const stopTarget = fold.stopCalls.get(id);
    if (stopTarget !== undefined) {
      fold.stopCalls.delete(id);
      if (block.is_error !== true) endTask(fold, stopTarget);
      continue;
    }
    let task = fold.tasks.get(id);
    if (!task && taskId && fold.bashCalls.has(id)) {
      const call = fold.bashCalls.get(id)!;
      task = { kind: 'shell', toolUseId: id, description: call.description, ...(call.startedAtMs !== undefined ? { startedAtMs: call.startedAtMs } : {}) };
      fold.tasks.set(id, task);
    }
    fold.bashCalls.delete(id);
    if (!task) continue;
    if (block.is_error === true || !taskId) { fold.tasks.delete(id); continue; }
    task.taskId = taskId;
    if (task.kind === 'monitor') {
      if (typeof result.timeoutMs === 'number') task.timeoutMs = result.timeoutMs;
      if (result.persistent === true) task.persistent = true;
    }
  }
}

function foldNotifications(fold: PendingFold, line: string): void {
  for (const match of line.matchAll(NOTIFICATION_RE)) {
    const body = match[1];
    if (!tag(body, 'status') && !body.includes('Monitor expired')) continue;
    endTask(fold, tag(body, 'tool-use-id'));
    endTask(fold, tag(body, 'task-id'));
  }
}

function foldClaudeRunSettings(fold: PendingFold, record: Record<string, unknown>): void {
  if (typeof record.effort === 'string' && EFFORTS.has(record.effort)) fold.effort = record.effort as SessionEffort;
  const speed = ((record.message as { usage?: { speed?: unknown } } | undefined)?.usage)?.speed;
  if (speed === 'fast') fold.fast = true;
  else if (speed === 'standard') fold.fast = false;
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

const PROCESS_START_RE = /"hookName":"SessionStart:(?:startup|resume)"/;

function isProcessBoundary(line: string): boolean {
  return line.startsWith('{"type":"cost-state"') || PROCESS_START_RE.test(line);
}

function foldClaudeLine(fold: PendingFold, line: string): void {
  if (isProcessBoundary(line)) {
    fold.tasks.clear();
    fold.bashCalls.clear();
    fold.stopCalls.clear();
    return;
  }
  if (line.includes('<task-notification>')) foldNotifications(fold, line);
  const isAssistant = line.includes('"type":"assistant"');
  if (isAssistant && line.includes('"effort":"')) fold.lastAssistant = line;
  if (isAssistant && line.includes('"tool_use"') && (line.includes('"name":"Bash"') || line.includes('"name":"Monitor"') || line.includes('"name":"TaskStop"') || line.includes('"name":"KillShell"'))) {
    const record = parse(line);
    if (record) foldClaudeToolUses(fold, record);
  } else if (!isAssistant && line.includes('"tool_result"') && (line.includes('"backgroundTaskId"') || line.includes('"taskId"') || line.includes('"is_error":true') || [...fold.stopCalls.keys()].some((id) => line.includes(id)))) {
    const record = parse(line);
    if (record) foldClaudeToolResults(fold, record);
  }
}

function foldCodexLine(fold: PendingFold, line: string): void {
  if (!line.includes('"type":"turn_context"')) return;
  const effort = (parse(line)?.payload as { effort?: unknown } | undefined)?.effort;
  if (typeof effort === 'string' && EFFORTS.has(effort)) fold.effort = effort as SessionEffort;
}

function readAppended(file: string, fold: PendingFold, onLine: (line: string) => void): boolean {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return false; }
  try {
    const st = fs.fstatSync(fd);
    let skipFirst = false;
    if (st.ino !== fold.ino || st.size < fold.offset) {
      fold.ino = st.ino;
      fold.offset = Math.max(0, st.size - PENDING_COLD_TAIL_BYTES);
      fold.partial = '';
      fold.tasks.clear();
      fold.bashCalls.clear();
      fold.stopCalls.clear();
      delete fold.lastAssistant;
      delete fold.effort;
      delete fold.fast;
      skipFirst = fold.offset > 0;
    }
    while (fold.offset < st.size) {
      const length = Math.min(MAX_READ_BYTES, st.size - fold.offset);
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(fd, buffer, 0, length, fold.offset);
      if (read <= 0) break;
      fold.offset += read;
      const chunk = fold.partial + buffer.subarray(0, read).toString('utf8');
      const parts = chunk.split('\n');
      fold.partial = parts.pop() ?? '';
      if (fold.partial.length > MAX_PARTIAL_BYTES) fold.partial = '';
      if (skipFirst) { parts.shift(); skipFirst = false; }
      for (const part of parts) if (part) onLine(part);
    }
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

function foldFor(file: string, agent: 'claude' | 'codex'): PendingFold | undefined {
  let fold = folds.get(file);
  if (!fold || fold.agent !== agent) {
    if (folds.size >= MAX_FOLDS) folds.clear();
    fold = { agent, offset: 0, partial: '', ino: -1, tasks: new Map(), bashCalls: new Map(), stopCalls: new Map() };
    folds.set(file, fold);
  }
  const target = fold;
  const ok = readAppended(file, target, agent === 'claude' ? (line) => foldClaudeLine(target, line) : (line) => foldCodexLine(target, line));
  if (!ok) { folds.delete(file); return undefined; }
  if (target.lastAssistant) {
    const record = parse(target.lastAssistant);
    delete target.lastAssistant;
    if (record) foldClaudeRunSettings(target, record);
  }
  return target;
}

function items(tasks: BackgroundTask[]): PendingWorkItem[] {
  return tasks.map((task) => ({
    id: task.taskId ?? task.toolUseId,
    description: task.description,
    ...(task.startedAtMs !== undefined ? { startedAtMs: task.startedAtMs } : {}),
  }));
}

export interface SessionLiveWork {
  pending?: SessionPendingWork;
  effort?: SessionEffort;
  fast?: boolean;
}

export function readSessionLiveWork(
  row: Pick<ActiveSession, 'kind' | 'sessionFile' | 'pidAlive' | 'subagents' | 'processStartedAtMs'>,
  nowMs = Date.now(),
): SessionLiveWork {
  const alive = row.pidAlive === true;
  const current = (startedAtMs: number | undefined) =>
    row.processStartedAtMs === undefined || startedAtMs === undefined || startedAtMs >= row.processStartedAtMs;
  const subagents: PendingWorkItem[] = (alive ? row.subagents ?? [] : [])
    .filter((agent) => agent.status === 'running' && current(agent.startedAtMs))
    .map((agent) => ({ id: agent.id, description: agent.description, ...(agent.startedAtMs !== undefined ? { startedAtMs: agent.startedAtMs } : {}) }));
  const agent = row.kind === 'claude' || row.kind === 'codex' ? row.kind : undefined;
  const fold = agent && row.sessionFile ? foldFor(row.sessionFile, agent) : undefined;
  const live = alive ? [...(fold?.tasks.values() ?? [])].filter((task) => current(task.startedAtMs)) : [];
  const shells = items(live.filter((task) => task.kind === 'shell'));
  const monitors = items(live.filter((task) => task.kind === 'monitor'
    && (task.persistent || task.timeoutMs === undefined || task.startedAtMs === undefined || task.startedAtMs + task.timeoutMs > nowMs)));
  const out: SessionLiveWork = {};
  if (subagents.length || shells.length || monitors.length) out.pending = { subagents, shells, monitors };
  if (fold?.effort) out.effort = fold.effort;
  if (fold?.fast !== undefined) out.fast = fold.fast;
  return out;
}

export function enrichLiveWork(rows: ActiveSession[], nowMs = Date.now()): void {
  for (const row of rows) {
    const work = readSessionLiveWork(row, nowMs);
    if (work.pending) row.pending = work.pending; else delete row.pending;
    if (work.effort) row.effort = work.effort; else delete row.effort;
    if (work.fast !== undefined) row.fast = work.fast; else delete row.fast;
  }
}

export function resetPendingWorkFolds(): void {
  folds.clear();
}
