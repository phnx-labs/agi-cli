import { createHash } from 'crypto';
import { parse, type Node as JavaScriptNode } from 'acorn';
import { knownSecretValuesFromEnv, redactSecrets, sanitizeForTerminal } from '../redact.js';
import type { SessionEvent } from './types.js';
import { extractShellPrograms, isShellExecTool, type ShellProgramOccurrence } from './shell-programs.js';

export const TOOL_INPUT_MAX_BYTES = 16 * 1024;
export const TOOL_SUCCESS_OUTPUT_MAX_BYTES = 1024;
export const TOOL_ERROR_OUTPUT_MAX_BYTES = 4 * 1024;
export const TOOL_SESSION_EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;
export const TOOL_PENDING_MAX_BYTES = 1024 * 1024;
export const TOOL_PENDING_MAX_CALLS = 256;
export const TOOL_CHANGED_MAX_CALLS = 10_000;
export const TOOL_INDEX_LIMIT_ORDINAL = Number.MAX_SAFE_INTEGER;
export const TOOL_TEXT_PROCESSING_MAX_BYTES = 64 * 1024;
export const TOOL_SHELL_PARSE_MAX_BYTES = 64 * 1024;
// Bumped to 9 for Codex tool-outcome classification (PHNX-3761): Codex results
// arrive as a string or input_text[] rather than an object, so every one used to
// store as 'unknown' and error rates read 0%. A re-index re-derives outcome for
// rows stored by an older extractor.
// (8 added the per-call end timestamp, PHNX-3437.)
export const TOOL_INDEX_VERSION = 9;

const BASE64_BLOCK = /(?:[A-Za-z0-9+/]{256,}={0,2})/g;
const SECRET_FIELD = /(?:token|secret|password|authorization|cookie|api[_-]?key|private[_-]?key)$/i;
const KNOWN_SECRET_VALUES = knownSecretValuesFromEnv();

export type ToolCallOutcome = 'ok' | 'error' | 'unknown';

export interface IndexedToolCall {
  ordinal: number;
  sourceCallId?: string;
  timestamp: string;
  /**
   * When the call's RESULT record arrived — the call's own end time, taken from
   * the tool_result transcript record at `finish()` (PHNX-3437). `timestamp` is
   * the start; `endTimestamp - timestamp` is the call's own blocking duration,
   * which the traces insight engine attributes as a failed call's wasted time.
   * Undefined for a call that never produced a result (still pending at scan end)
   * and for rows produced by an older extractor.
   */
  endTimestamp?: string;
  tool: string;
  programs: string[];
  programOccurrences: ShellProgramOccurrence[];
  input: string;
  outcome: ToolCallOutcome;
  exitCode?: number;
  statusCode?: number;
  errorCode?: string;
  output?: string;
  error?: string;
  parseError?: string;
}

export interface ToolCallCollectorSnapshot {
  v: 1;
  nextOrdinal: number;
  pending: IndexedToolCall[];
}

function byteBound(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffix = '\n[truncated]';
  const limit = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  let end = Math.min(value.length, limit);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > limit) end--;
  return value.slice(0, end) + suffix;
}

function bytePrefix(value: string, maxBytes: number): string {
  if (value.length <= maxBytes && Buffer.byteLength(value) <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > maxBytes) end--;
  return value.slice(0, end);
}

/**
 * Bound regex/parser work while retaining enough look-ahead to redact a secret
 * that crosses the 64 KiB persistence boundary. An oversized configured secret
 * makes a large source wholly opaque rather than risking a partial disclosure.
 */
function processingWindow(value: string, knownValues: readonly string[]): string {
  if (value.length <= TOOL_TEXT_PROCESSING_MAX_BYTES
    && Buffer.byteLength(value) <= TOOL_TEXT_PROCESSING_MAX_BYTES) return value;
  const maxKnownBytes = knownValues.reduce((max, secret) => Math.max(max, Buffer.byteLength(secret)), 0);
  if (maxKnownBytes > TOOL_TEXT_PROCESSING_MAX_BYTES) return '[REDACTED oversized evidence]\n[truncated]';
  const boundaryLookahead = Math.max(4096, maxKnownBytes);
  return bytePrefix(value, TOOL_TEXT_PROCESSING_MAX_BYTES + boundaryLookahead);
}

export function sanitizeToolEvidenceText(
  value: string,
  maxBytes: number,
  knownValues: readonly string[] = KNOWN_SECRET_VALUES,
): string {
  const binaryMarked = processingWindow(value, knownValues)
    .replace(BASE64_BLOCK, (token) => `[base64:${token.length} chars]`);
  return byteBound(sanitizeForTerminal(redactSecrets(binaryMarked, knownValues)), maxBytes);
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value.length <= 512 && Buffer.byteLength(value) <= 512) {
    return sanitizeToolEvidenceText(value, 512);
  }
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `${sanitizeToolEvidenceText(value, 480)}#${digest}`;
}

function boundedStableJson(value: unknown, maxBytes: number): string {
  const suffix = '\n[truncated]';
  const capacity = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  const seen = new WeakSet<object>();
  let out = '';
  let bytes = 0;
  let truncated = false;

  const append = (text: string): void => {
    if (truncated || text.length === 0) return;
    const available = capacity - bytes;
    if (available <= 0) {
      truncated = true;
      return;
    }
    const prefix = bytePrefix(text, available);
    out += prefix;
    bytes += Buffer.byteLength(prefix);
    if (prefix.length < text.length) truncated = true;
  };

  const write = (item: unknown, depth: number): void => {
    if (truncated) return;
    if (depth > 64) {
      append(JSON.stringify('[depth limit]'));
      truncated = true;
      return;
    }
    if (typeof item === 'string') {
      const prefix = bytePrefix(item, Math.max(0, capacity - bytes));
      append(JSON.stringify(prefix));
      if (prefix.length < item.length) truncated = true;
      return;
    }
    if (item === null || typeof item === 'number' || typeof item === 'boolean') {
      append(JSON.stringify(item));
      return;
    }
    if (typeof item !== 'object') {
      append(JSON.stringify(String(item)));
      return;
    }
    if (seen.has(item)) {
      append(JSON.stringify('[circular]'));
      return;
    }
    seen.add(item);
    if (Array.isArray(item)) {
      append('[');
      for (let i = 0; i < item.length && !truncated; i++) {
        if (i > 0) append(',');
        write(item[i], depth + 1);
      }
      append(']');
      return;
    }

    const record = item as Record<string, unknown>;
    const keys: string[] = [];
    let keyBytes = 0;
    let keysTruncated = false;
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      keyBytes += Buffer.byteLength(key) + 4;
      if (keys.length >= 1024 || keyBytes > capacity - bytes) {
        keysTruncated = true;
        break;
      }
      keys.push(key);
    }
    keys.sort((a, b) => a.localeCompare(b));
    append('{');
    for (let i = 0; i < keys.length && !truncated; i++) {
      const key = keys[i];
      if (i > 0) append(',');
      append(JSON.stringify(key));
      append(':');
      write(SECRET_FIELD.test(key) ? '[REDACTED]' : record[key], depth + 1);
    }
    append('}');
    if (keysTruncated) truncated = true;
  };

  write(value, 0);
  return truncated ? bytePrefix(out, capacity) + suffix : out;
}

function canonicalInput(tool: string, args?: Record<string, unknown>, command?: string): string {
  const shellCommand = command
    ?? (typeof args?.command === 'string' ? args.command : undefined)
    ?? (typeof args?.cmd === 'string' ? args.cmd : undefined);
  if (shellCommand) return sanitizeToolEvidenceText(shellCommand, TOOL_INPUT_MAX_BYTES);
  if (!args) return tool;
  let hasArgs = false;
  for (const key in args) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
    hasArgs = true;
    break;
  }
  if (!hasArgs) return tool;
  try {
    return sanitizeToolEvidenceText(
      boundedStableJson(args, TOOL_TEXT_PROCESSING_MAX_BYTES),
      TOOL_INPUT_MAX_BYTES,
    );
  } catch {
    return sanitizeToolEvidenceText(String(args), TOOL_INPUT_MAX_BYTES);
  }
}

/** Extract literal shell commands from the Codex orchestration tool without evaluating transcript code. */
export function commandsFromCodexExec(source: string): string[] {
  const commands: string[] = [];
  let root: JavaScriptNode;
  try {
    root = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true });
  } catch {
    return commands;
  }

  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Record<string, any>;
    if (node.type === 'CallExpression'
      && node.callee?.type === 'MemberExpression'
      && node.callee.computed === false
      && node.callee.object?.type === 'Identifier'
      && node.callee.object.name === 'tools'
      && node.callee.property?.type === 'Identifier'
      && node.callee.property.name === 'exec_command'
      && node.arguments?.[0]?.type === 'ObjectExpression') {
      const property = node.arguments[0].properties.find((candidate: Record<string, any>) =>
        candidate.type === 'Property'
        && candidate.kind === 'init'
        && ((candidate.key.type === 'Identifier' && candidate.key.name === 'cmd')
          || (candidate.key.type === 'Literal' && candidate.key.value === 'cmd')));
      const commandValue = property?.value;
      if (commandValue?.type === 'Literal' && typeof commandValue.value === 'string') {
        commands.push(commandValue.value);
      } else if (commandValue?.type === 'TemplateLiteral' && commandValue.expressions.length === 0) {
        commands.push(commandValue.quasis[0]?.value.cooked ?? commandValue.quasis[0]?.value.raw ?? '');
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(root);
  return commands;
}

function commandFor(tool: string, args?: Record<string, unknown>, command?: string): string | undefined {
  if (!isShellExecTool(tool)) return undefined;
  const direct = command
    ?? (typeof args?.command === 'string' ? args.command : undefined)
    ?? (typeof args?.cmd === 'string' ? args.cmd : undefined);
  if (direct !== undefined) return direct;
  const input = typeof args?.input === 'string' ? args.input : undefined;
  if (!input || tool.toLowerCase() !== 'exec') return input;
  const boundedInput = bytePrefix(input, TOOL_SHELL_PARSE_MAX_BYTES);
  const commands = commandsFromCodexExec(boundedInput);
  if (commands.length > 0) return commands.join('\n');
  return /\btools\s*\./.test(input) ? undefined : input;
}

function resultObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function structuredField(source: Record<string, unknown> | undefined, name: string): unknown {
  const metadata = resultObject(source?.metadata);
  return source?.[name] ?? metadata?.[name];
}

function structuredNumber(source: Record<string, unknown> | undefined, name: string): number | undefined {
  const value = structuredField(source, name);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function structuredString(source: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = structuredField(source, name);
  return typeof value === 'string' ? value : undefined;
}

// Codex tool results arrive as a plain string or an array of {type:'input_text',
// text} blocks (never a plain object), so the text lives across the blocks and
// the only outcome signal is the leading "Script completed"/"Script failed"
// marker the exec harness prefixes onto the first block.
function textSegments(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value
      .map((block) =>
        block && typeof block === 'object' && typeof (block as Record<string, unknown>).text === 'string'
          ? (block as Record<string, unknown>).text as string
          : '',
      )
      .filter((text) => text.length > 0);
  }
  return [];
}

function codexScriptOutcome(value: unknown): ToolCallOutcome | undefined {
  const lead = textSegments(value)[0]?.trimStart();
  if (!lead) return undefined;
  if (lead.startsWith('Script failed')) return 'error';
  if (lead.startsWith('Script completed')) return 'ok';
  return undefined;
}

function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return textSegments(value).join('\n');
  const object = resultObject(value);
  if (object) {
    for (const key of ['output', 'stdout', 'content', 'text', 'message']) {
      if (typeof object[key] === 'string') return object[key] as string;
    }
    try {
      return boundedStableJson(object, TOOL_TEXT_PROCESSING_MAX_BYTES);
    } catch {
      return String(value);
    }
  }
  return value == null ? '' : String(value);
}

export function structuredToolResult(value: unknown): {
  text: string;
  outcome: ToolCallOutcome;
  exitCode?: number;
  statusCode?: number;
  errorCode?: string;
} {
  const structured = resultObject(value);
  const success = structuredField(structured, 'success');
  const isError = success === false || structuredField(structured, 'is_error') === true;
  const outcome: ToolCallOutcome = isError
    ? 'error'
    : success === true
      ? 'ok'
      : codexScriptOutcome(value) ?? 'unknown';
  return {
    text: resultText(value),
    outcome,
    exitCode: structuredNumber(structured, 'exit_code'),
    statusCode: structuredNumber(structured, 'status_code'),
    errorCode: structuredString(structured, 'error_code'),
  };
}

function buildCall(
  ordinal: number,
  timestamp: string,
  tool: string,
  args?: Record<string, unknown>,
  command?: string,
  sourceCallId?: string,
): IndexedToolCall {
  const rawShellCommand = commandFor(tool, args, command);
  const shellCommand = rawShellCommand
    ? sanitizeToolEvidenceText(rawShellCommand, TOOL_SHELL_PARSE_MAX_BYTES)
    : undefined;
  const shell = shellCommand
    ? extractShellPrograms(shellCommand)
    : { programs: [], occurrences: [], diagnostics: [] };
  return {
    ordinal,
    sourceCallId: safeIdentifier(sourceCallId),
    timestamp: sanitizeToolEvidenceText(timestamp, 128),
    tool: sanitizeToolEvidenceText(tool, 512),
    programs: shell.programs.map((program) => sanitizeToolEvidenceText(program, 512)),
    programOccurrences: shell.occurrences.map((occurrence) => ({
      program: sanitizeToolEvidenceText(occurrence.program, 512),
      role: occurrence.role,
    })),
    input: canonicalInput(tool, args, command),
    outcome: 'unknown',
    parseError: shell.diagnostics.length > 0 ? sanitizeToolEvidenceText(shell.diagnostics.join('; '), 1024) : undefined,
  };
}

export function toolCallEvidenceBytes(call: IndexedToolCall): number {
  return Buffer.byteLength([
    call.sourceCallId, call.timestamp, call.endTimestamp, call.tool, call.input, call.errorCode,
    call.output, call.error, call.parseError, ...call.programs,
    ...call.programOccurrences.map((occurrence) => `${occurrence.role}:${occurrence.program}`),
  ].filter((value): value is string => typeof value === 'string').join('\0'));
}

function collectionLimitCall(timestamp: string): IndexedToolCall {
  return {
    ordinal: TOOL_INDEX_LIMIT_ORDINAL,
    timestamp,
    tool: 'index_limit',
    programs: [],
    programOccurrences: [],
    input: 'Tool evidence collection stopped at the 5 MiB or 10,000-call scan limit.',
    outcome: 'unknown',
    parseError: 'Additional tool calls were not retained during this scan.',
  };
}

const COLLECTION_LIMIT_RESERVE_BYTES = toolCallEvidenceBytes(
  collectionLimitCall('1970-01-01T00:00:00.000Z'),
);

export class ToolCallCollector {
  private nextOrdinal: number;
  private readonly pendingById = new Map<string, IndexedToolCall>();
  private readonly pendingOrder: IndexedToolCall[] = [];
  private readonly changed = new Map<number, IndexedToolCall>();
  private readonly changedSizes = new Map<number, number>();
  private pendingBytes = 0;
  private changedBytes = 0;
  private changedTruncated = false;

  constructor(snapshot?: ToolCallCollectorSnapshot) {
    this.nextOrdinal = snapshot?.nextOrdinal ?? 0;
    for (const call of snapshot?.pending ?? []) this.rememberPending({ ...call });
  }

  start(args: {
    timestamp: string;
    tool: string;
    input?: Record<string, unknown>;
    command?: string;
    sourceCallId?: string;
  }): IndexedToolCall {
    const sourceCallId = safeIdentifier(args.sourceCallId);
    if (sourceCallId) {
      const existing = this.pendingById.get(sourceCallId);
      if (existing) return existing;
    }
    const timestamp = typeof args.timestamp === 'string' ? args.timestamp : '';
    const tool = typeof args.tool === 'string' && args.tool.length > 0 ? args.tool : 'unknown';
    const input = resultObject(args.input);
    const command = typeof args.command === 'string' ? args.command : undefined;
    const call = buildCall(
      this.nextOrdinal++,
      timestamp,
      tool,
      input,
      command,
      sourceCallId,
    );
    if (this.markChanged(call)) this.rememberPending(call);
    return call;
  }

  finish(args: {
    timestamp: string;
    sourceCallId?: string;
    tool?: string;
    success?: boolean;
    outcome?: ToolCallOutcome;
    exitCode?: number;
    statusCode?: number;
    errorCode?: string;
    output?: string;
    error?: string;
  }): IndexedToolCall | undefined {
    const tool = typeof args.tool === 'string' ? args.tool : undefined;
    const call = this.takePending(args.sourceCallId, tool);
    if (!call) return undefined;
    if (typeof args.timestamp === 'string' && args.timestamp.length > 0) {
      call.endTimestamp = sanitizeToolEvidenceText(args.timestamp, 128);
    }
    const outcome = args.outcome === 'ok' || args.outcome === 'error' || args.outcome === 'unknown'
      ? args.outcome
      : undefined;
    const error = typeof args.error === 'string' ? args.error : undefined;
    const output = typeof args.output === 'string' ? args.output : undefined;
    const success = typeof args.success === 'boolean' ? args.success : undefined;
    const isError = outcome === 'error' || success === false || error !== undefined;
    const raw = error ?? output ?? '';
    call.outcome = isError ? 'error' : outcome ?? (success === true ? 'ok' : 'unknown');
    call.exitCode = Number.isSafeInteger(args.exitCode) && (args.exitCode as number) >= 0 ? args.exitCode : undefined;
    call.statusCode = Number.isSafeInteger(args.statusCode) && (args.statusCode as number) >= 0 ? args.statusCode : undefined;
    call.errorCode = safeIdentifier(args.errorCode);
    if (isError || call.outcome === 'error') {
      call.error = sanitizeToolEvidenceText(raw, TOOL_ERROR_OUTPUT_MAX_BYTES);
      call.output = undefined;
    } else {
      call.output = sanitizeToolEvidenceText(raw, TOOL_SUCCESS_OUTPUT_MAX_BYTES);
      call.error = undefined;
    }
    this.markChanged(call);
    return call;
  }

  drainChanged(): IndexedToolCall[] {
    const out = [...this.changed.values()];
    if (this.changedTruncated) {
      out.push(collectionLimitCall(new Date().toISOString()));
    }
    out.sort((a, b) => a.ordinal - b.ordinal);
    this.changed.clear();
    this.changedSizes.clear();
    this.changedBytes = 0;
    this.changedTruncated = false;
    return out;
  }

  snapshot(): ToolCallCollectorSnapshot {
    return {
      v: 1,
      nextOrdinal: this.nextOrdinal,
      pending: this.pendingOrder.map((call) => ({ ...call })),
    };
  }

  recordIndexLimit(): void {
    this.changedTruncated = true;
  }

  private rememberPending(call: IndexedToolCall): void {
    this.pendingOrder.push(call);
    this.pendingBytes += toolCallEvidenceBytes(call);
    if (call.sourceCallId) this.pendingById.set(call.sourceCallId, call);
    while (this.pendingOrder.length > TOOL_PENDING_MAX_CALLS || this.pendingBytes > TOOL_PENDING_MAX_BYTES) {
      const dropped = this.pendingOrder.shift();
      if (!dropped) break;
      this.pendingBytes -= toolCallEvidenceBytes(dropped);
      if (dropped.sourceCallId) this.pendingById.delete(dropped.sourceCallId);
      dropped.parseError = 'Pending result correlation dropped at the 1 MiB continuation limit.';
      this.markChanged(dropped);
    }
  }

  private takePending(sourceCallId?: string, tool?: string): IndexedToolCall | undefined {
    const safeCallId = safeIdentifier(sourceCallId);
    const exact = safeCallId ? this.pendingById.get(safeCallId) : undefined;
    if (safeCallId) {
      if (!exact) return undefined;
      return this.removePending(exact);
    }
    const candidates = tool
      ? this.pendingOrder.filter((candidate) => candidate.tool === tool)
      : this.pendingOrder;
    // A missing harness id is safe only when one pending call can possibly own
    // the result. Do not attach concurrent same-tool output by arrival order.
    if (candidates.length !== 1) return undefined;
    return this.removePending(candidates[0]);
  }

  private removePending(call: IndexedToolCall): IndexedToolCall {
    const index = this.pendingOrder.indexOf(call);
    if (index >= 0) this.pendingOrder.splice(index, 1);
    this.pendingBytes -= toolCallEvidenceBytes(call);
    if (call.sourceCallId) this.pendingById.delete(call.sourceCallId);
    return call;
  }

  private markChanged(call: IndexedToolCall): boolean {
    const previousBytes = this.changedSizes.get(call.ordinal) ?? 0;
    const nextBytes = toolCallEvidenceBytes(call);
    const nextTotal = this.changedBytes - previousBytes + nextBytes;
    const isNew = !this.changed.has(call.ordinal);
    if (nextTotal > TOOL_SESSION_EVIDENCE_MAX_BYTES - COLLECTION_LIMIT_RESERVE_BYTES
      || (isNew && this.changed.size >= TOOL_CHANGED_MAX_CALLS)) {
      if (!isNew) {
        this.changed.delete(call.ordinal);
        this.changedSizes.delete(call.ordinal);
        this.changedBytes -= previousBytes;
      }
      this.changedTruncated = true;
      return false;
    }
    this.changed.set(call.ordinal, call);
    this.changedSizes.set(call.ordinal, nextBytes);
    this.changedBytes = nextTotal;
    return true;
  }
}

/** Fold one normalized event into a collector (the full-file harness contract). */
function foldEventIntoCollector(collector: ToolCallCollector, event: SessionEvent): void {
  if (event.type === 'tool_use') {
    collector.start({
      timestamp: event.timestamp,
      tool: event.tool || 'unknown',
      input: event.args,
      command: event.command,
      sourceCallId: event.callId,
    });
  } else if (event.type === 'tool_result') {
    collector.finish({
      timestamp: event.timestamp,
      sourceCallId: event.callId,
      tool: event.tool,
      success: event.success,
      outcome: event.outcome,
      exitCode: event.exitCode,
      statusCode: event.statusCode,
      errorCode: event.errorCode,
      output: event.output,
    });
  } else if (event.type === 'error' && event.tool) {
    const structuredError = event.outcome === 'error' || event.success === false;
    const evidence = event.content || event.output || 'Tool execution failed';
    collector.finish({
      timestamp: event.timestamp,
      sourceCallId: event.callId,
      tool: event.tool,
      success: structuredError ? false : undefined,
      outcome: event.outcome,
      exitCode: event.exitCode,
      statusCode: event.statusCode,
      errorCode: event.errorCode,
      error: structuredError ? evidence : undefined,
      output: structuredError ? undefined : evidence,
    });
  }
}

/** The prior scan's resume point for an append-only event stream. */
export interface EventToolScanResumePoint {
  /** ToolCallCollector snapshot after folding `eventCount` events. */
  snapshot: ToolCallCollectorSnapshot;
  /** How many events had been folded when the snapshot was taken. */
  eventCount: number;
}

export interface EventToolScanResult {
  /** The CHANGED calls — an append-safe upsert set, not the whole history. */
  calls: IndexedToolCall[];
  /** Serialized-ready snapshot to persist for the next incremental scan. */
  snapshot: ToolCallCollectorSnapshot;
  /** Events folded so far — the next scan's resume offset into `events`. */
  eventCount: number;
}

/**
 * Derive tool calls from a full-file harness's normalized events, optionally
 * RESUMING from a prior scan of the same append-only stream.
 *
 * Without `prior` this is a full parse from event 0 (identical to the legacy
 * {@link toolCallsFromEvents}). With `prior`, the collector is seeded from the
 * prior snapshot and only events at or after `prior.eventCount` are folded — so
 * an active session that grew by a few turns re-derives (and re-redacts) only
 * those new tool calls instead of re-sanitizing its entire history on every
 * daemon warm tick (PHNX-3411). The ordinals continue deterministically from the
 * snapshot, so folding [0..k) then [k..n) yields the same index as folding
 * [0..n) once, and the CHANGED set is safe to persist with `mode: 'append'`.
 *
 * The caller is responsible for only supplying `prior` when the stream is still
 * an append of what was scanned before (same source, un-truncated,
 * `prior.eventCount <= events.length`); anything else must full-scan.
 */
export function scanEventToolCalls(
  events: SessionEvent[],
  prior?: EventToolScanResumePoint,
): EventToolScanResult {
  const startIndex = prior ? Math.min(prior.eventCount, events.length) : 0;
  const collector = new ToolCallCollector(prior?.snapshot);
  for (let i = startIndex; i < events.length; i++) foldEventIntoCollector(collector, events[i]);
  return { calls: collector.drainChanged(), snapshot: collector.snapshot(), eventCount: events.length };
}

/** Build indexed calls from the normalized parser contract used by full-file harnesses. */
export function toolCallsFromEvents(events: SessionEvent[]): IndexedToolCall[] {
  return scanEventToolCalls(events).calls;
}

export function toolCallKey(sessionId: string, ordinal: number): string {
  return createHash('sha256').update(`${sessionId}\0${ordinal}`).digest('hex').slice(0, 20);
}

/** Fold one raw Claude record into the resumable call collector. */
export function collectClaudeToolCalls(collector: ToolCallCollector, parsed: any): void {
  const timestamp = typeof parsed?.timestamp === 'string' ? parsed.timestamp : new Date().toISOString();
  if (parsed?.type === 'assistant') {
    for (const block of parsed.message?.content ?? []) {
      if (block?.type !== 'tool_use') continue;
      collector.start({
        timestamp,
        tool: typeof block.name === 'string' ? block.name : 'unknown',
        input: block.input && typeof block.input === 'object' ? block.input : {},
        command: typeof block.input?.command === 'string' ? block.input.command : undefined,
        sourceCallId: typeof block.id === 'string' ? block.id : undefined,
      });
    }
  } else if (parsed?.type === 'user') {
    for (const block of Array.isArray(parsed.message?.content) ? parsed.message.content : []) {
      if (block?.type !== 'tool_result') continue;
      const text = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.filter((part: any) => part?.type === 'text').map((part: any) => part.text || '').join('\n')
          : '';
      const structured = resultObject(block);
      collector.finish({
        timestamp,
        sourceCallId: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
        success: block.is_error !== true,
        output: block.is_error === true ? undefined : text,
        error: block.is_error === true ? text || 'Tool execution failed' : undefined,
        exitCode: structuredNumber(structured, 'exit_code'),
        statusCode: structuredNumber(structured, 'status_code'),
        errorCode: structuredString(structured, 'error_code'),
      });
    }
  }
}

/** Fold one raw Codex rollout record into the resumable call collector. */
export function collectCodexToolCalls(collector: ToolCallCollector, parsed: any): void {
  const timestamp = typeof parsed?.timestamp === 'string' ? parsed.timestamp : new Date().toISOString();
  const payload = parsed?.payload ?? {};
  if (parsed?.type === 'event_msg' && payload.type === 'web_search_end') {
    collector.start({ timestamp, tool: 'WebSearch', input: { query: String(payload.query || '') } });
    return;
  }
  if (parsed?.type !== 'response_item') return;

  if (payload.type === 'function_call') {
    let input: Record<string, unknown> = {};
    try {
      input = typeof payload.arguments === 'string' ? JSON.parse(payload.arguments) : (payload.arguments || {});
    } catch {
      input = { raw: String(payload.arguments || '') };
    }
    collector.start({
      timestamp,
      tool: String(payload.name || 'unknown'),
      input,
      command: typeof input.command === 'string' ? input.command : typeof input.cmd === 'string' ? input.cmd : undefined,
      sourceCallId: typeof (payload.call_id || payload.id) === 'string' ? (payload.call_id || payload.id) : undefined,
    });
  } else if (payload.type === 'custom_tool_call') {
    collector.start({
      timestamp,
      tool: String(payload.name || 'unknown'),
      input: { input: String(payload.input || '') },
      sourceCallId: typeof (payload.call_id || payload.id) === 'string' ? (payload.call_id || payload.id) : undefined,
    });
  } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    const result = structuredToolResult(payload.output);
    const isError = result.outcome === 'error';
    collector.finish({
      timestamp,
      sourceCallId: typeof (payload.call_id || payload.id) === 'string' ? (payload.call_id || payload.id) : undefined,
      outcome: result.outcome,
      output: isError ? undefined : result.text,
      error: isError ? result.text || 'Tool execution failed' : undefined,
      exitCode: result.exitCode,
      statusCode: result.statusCode,
      errorCode: result.errorCode,
    });
  }
}
