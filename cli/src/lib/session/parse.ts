/**
 * Session file parsers for Claude, Codex, Gemini, and OpenCode.
 *
 * Each agent stores sessions in a different format (JSONL, JSON, SQLite).
 * This module normalizes all of them into a flat array of SessionEvent
 * objects suitable for rendering, filtering, and summarization.
 */

import * as fs from 'fs';
import { truncate } from '../format.js';
import { sanitizeForTerminal } from '../redact.js';
import * as path from 'path';
import Database from '../sqlite.js';
import { isSyntheticUserMessage, extractSlashCommandName, extractSlashCommandFromToolInput, unwrapUserQuery } from './prompt.js';
import type { SessionAgentId, SessionEvent, SessionVerbClass } from './types.js';
import { structuredToolResult, commandsFromCodexExec } from './tool-calls.js';
import { isCloudSessionPath } from './cloud.js';

/**
 * Largest session file we will load into memory. Above this we throw a clean
 * error instead of OOMing or hitting V8's ERR_STRING_TOO_LONG. Aligns with
 * Node's ~512MB string ceiling with a healthy margin.
 */
export const SESSION_FILE_MAX_BYTES = 200_000_000;

/**
 * Strip terminal control sequences that a malicious session file could use to
 * hijack the user's terminal (clipboard via OSC 52, scrollback wipe, alt-screen
 * takeover, cursor moves, etc.). Allowed through: tab (0x09), newline (0x0a),
 * carriage return (0x0d). Everything else in the C0/C1 range and every CSI/OSC
 * escape is dropped.
 */
export { sanitizeForTerminal } from '../redact.js';

/** Recursively sanitize every string value within a tool-args object. */
function sanitizeArgsDeep(value: any): any {
  if (typeof value === 'string') return sanitizeForTerminal(value);
  if (Array.isArray(value)) return value.map(sanitizeArgsDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value)) out[k] = sanitizeArgsDeep(value[k]);
    return out;
  }
  return value;
}

/** In-place sanitize every user-visible string field on a list of events. */
export function sanitizeEvents(events: SessionEvent[]): void {
  for (const e of events) sanitizeEvent(e);
}

/** In-place sanitize all user-visible string fields on an event. */
function sanitizeEvent(e: SessionEvent): void {
  if (e.content) e.content = sanitizeForTerminal(e.content);
  if (e.command) e.command = sanitizeForTerminal(e.command);
  if (e.path) e.path = sanitizeForTerminal(e.path);
  if (e.name) e.name = sanitizeForTerminal(e.name);
  if (e.output) e.output = sanitizeForTerminal(e.output);
  if (e.tool) e.tool = sanitizeForTerminal(e.tool);
  if (e.model) e.model = sanitizeForTerminal(e.model);
  if (e.mediaType) e.mediaType = sanitizeForTerminal(e.mediaType);
  if (e.hookName) e.hookName = sanitizeForTerminal(e.hookName);
  if (e.hookEvent) e.hookEvent = sanitizeForTerminal(e.hookEvent);
  // The harness's own per-call label and turn phase are free text from the same
  // untrusted transcript, and the timeline ships them straight to a terminal.
  if (e.label) e.label = sanitizeForTerminal(e.label);
  if (e.phase) e.phase = sanitizeForTerminal(e.phase);
  if (e.args) e.args = sanitizeArgsDeep(e.args);
}

/**
 * Did this Claude tool_result record fail, or was it never allowed to run?
 *
 * Two distinct signals, both on the record ENCLOSING the `tool_result` block:
 * `toolDenialKind` when a permission rule or hook refused the call, and
 * `toolUseResult.interrupted` when the operator cut it short with Ctrl-C.
 * Neither is a failure of the work, so both land on `blocked`, which is what
 * separates "this agent is failing" from "this agent is being stopped".
 */
function isBlockedToolResult(raw: any): boolean {
  if (typeof raw?.toolDenialKind === 'string' && raw.toolDenialKind) return true;
  return raw?.toolUseResult?.interrupted === true;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function attachmentPath(block: any, source: any): string | undefined {
  return firstString(
    source?.path,
    source?.file_path,
    source?.filePath,
    source?.url,
    source?.ref,
    block?.path,
    block?.file_path,
    block?.filePath,
    block?.ref,
  );
}

function attachmentName(block: any, source: any, filePath: string | undefined): string | undefined {
  return firstString(
    block?.name,
    block?.title,
    source?.name,
    source?.filename,
    source?.file_name,
    source?.fileName,
    filePath ? path.basename(filePath) : undefined,
  );
}

function normalizedAttachmentEvent(
  agent: SessionAgentId,
  timestamp: string,
  block: any,
  source: any,
  defaultMediaType: string,
  sizeBytes: number,
): SessionEvent {
  const filePath = attachmentPath(block, source);
  const name = attachmentName(block, source, filePath);
  const explicitSize =
    typeof source?.sizeBytes === 'number' ? source.sizeBytes :
    typeof source?.size === 'number' ? source.size :
    typeof block?.sizeBytes === 'number' ? block.sizeBytes :
    undefined;
  return {
    type: 'attachment',
    agent,
    timestamp,
    path: filePath,
    name,
    mediaType: firstString(source?.media_type, source?.mediaType, block?.media_type, block?.mediaType) || defaultMediaType,
    sizeBytes: sizeBytes || explicitSize || 0,
  };
}

/**
 * Read a session file, refusing files above maxBytes. Bounded read protects
 * against multi-GB session blobs that would OOM the CLI or exceed V8's
 * ERR_STRING_TOO_LONG ceiling.
 */
export function safeReadSessionFile(filePath: string, maxBytes: number = SESSION_FILE_MAX_BYTES): string {
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) {
    throw new Error(
      `Session file too large: ${filePath} is ${stat.size} bytes (limit ${maxBytes}). Refusing to load.`,
    );
  }
  return fs.readFileSync(filePath, 'utf-8');
}

export interface ParseSessionOptions {
  /** Keep normalized tool results compact by default; renderers can request full output. */
  maxToolOutputChars?: number;
  /** Opt-in because interrupts are not user messages and would change the published event stream. */
  includeInterrupts?: boolean;
  /**
   * Opt-in `file_change` events from the harness's own file ledger (Claude
   * `file-history-delta`). Opt-in for the same reason as
   * {@link includeInterrupts}: they are not tool calls, and emitting them by
   * default would change every published event stream (message counts, digests,
   * trajectories) for a signal only the timeline fold consumes.
   */
  includeFileHistory?: boolean;
}

function truncateNormalizedToolOutput(output: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || output.length <= maxChars) return output;
  return `${output.slice(0, maxChars)}\n\n[Output truncated: ${output.length - maxChars} characters omitted.]`;
}

/** Separate from HarnessAdapter because offline transcripts include session-only agents such as Rush. */
const TRANSCRIPT_PARSERS: Record<SessionAgentId, (filePath: string, opts: ParseSessionOptions) => SessionEvent[]> = {
  claude: (filePath, opts) => parseClaude(filePath, opts),
  codex: (filePath) => parseCodex(filePath),
  gemini: (filePath) => parseGemini(filePath),
  antigravity: (filePath) => parseAntigravity(filePath),
  // Cloud-captured opencode sessions are normalized JSONL (produced by the
  // factory at capture time), NOT the local `opencode.db#<session>` SQLite
  // composite the offline parser reads — route by whether the path is in the
  // cloud session cache (PHNX-3845).
  opencode: (filePath) =>
    isCloudSessionPath(filePath) ? parseOpencodeCloud(filePath) : parseOpenCode(filePath),
  grok: (filePath) => parseGrok(filePath),
  rush: (filePath) => parseRush(filePath),
  openclaw: () => [], // OpenClaw sessions don't have parseable files yet
  hermes: (filePath) => parseHermes(filePath),
  kimi: (filePath) => parseKimi(filePath),
  droid: (filePath) => parseDroid(filePath),
  cursor: (filePath) => parseCursor(filePath),
  muse: (filePath) => parseMuse(filePath),
};

export function parseSession(
  filePath: string,
  agent?: SessionAgentId,
  opts: ParseSessionOptions = {},
): SessionEvent[] {
  const detected = agent || detectAgent(filePath);
  if (!detected) {
    throw new Error(`Cannot detect agent type from path: ${filePath}`);
  }

  const events: SessionEvent[] = TRANSCRIPT_PARSERS[detected](filePath, opts);

  // Sanitize untrusted strings and identify synthetic user scaffolding once for every consumer.
  const maxToolOutputChars = opts.maxToolOutputChars ?? 500;
  for (const e of events) {
    if (e.type === 'tool_result' && e.output) {
      e.output = truncateNormalizedToolOutput(e.output, maxToolOutputChars);
    }
    sanitizeEvent(e);
    if (e.type === 'message' && e.role === 'user' && isSyntheticUserMessage(e.content)) {
      e._synthetic = true;
    }
  }
  return events;
}

/** Infer the agent type from a session file path using known directory conventions. */
export function detectAgent(filePath: string): SessionAgentId | null {
  if (filePath.includes('/.claude/') || filePath.includes('\\.claude\\')) return 'claude';
  if (filePath.includes('/.codex/') || filePath.includes('\\.codex\\')) return 'codex';
  // Antigravity lives under ~/.gemini/antigravity-cli/conversations/<uuid>.db, so
  // it must be matched BEFORE the generic /.gemini/ check below or it would be
  // misdetected as Gemini.
  if ((filePath.includes('/antigravity-cli/conversations/') || filePath.includes('\\antigravity-cli\\conversations\\'))
      && filePath.endsWith('.db')) return 'antigravity';
  if (filePath.includes('/.gemini/') || filePath.includes('\\.gemini\\')) return 'gemini';
  if (filePath.includes('/.grok/') || filePath.includes('\\.grok\\')) return 'grok';
  if (filePath.includes('/.rush/') || filePath.includes('\\.rush\\')) return 'rush';
  if (filePath.includes('/.hermes/') || filePath.includes('\\.hermes\\')) return 'hermes';
  if (filePath.includes('/.kimi-code/') || filePath.includes('\\.kimi-code\\')) return 'kimi';
  if (filePath.includes('/.factory/') || filePath.includes('\\.factory\\')) return 'droid';
  if (filePath.includes('/.cursor/') || filePath.includes('\\.cursor\\')) return 'cursor';
  // Muse sessions: ~/.local/share/muse/sessions/YYYY/MM/DD/<uuid>/session.jsonl
  if (
    filePath.includes('/muse/sessions/') ||
    filePath.includes('\\muse\\sessions\\') ||
    filePath.includes('/.local/share/muse/') ||
    filePath.includes('\\.local\\share\\muse\\')
  ) {
    return 'muse';
  }
  // Cloud convention: cloud-sessions/<id>/session.<format>.jsonl
  const cloudMatch = filePath.match(/session\.(claude|codex|rush|opencode)\.jsonl(?:$|[?#])/);
  if (cloudMatch) return cloudMatch[1] as SessionAgentId;
  if (filePath.includes('opencode.db')) return 'opencode';

  // Try file extension + content heuristic
  if (filePath.endsWith('.json')) return 'gemini';
  return null;
}

/**
 * Checklist-snapshot tool names across harnesses — each sends the WHOLE list on
 * every write, so the last call is the current checklist. Claude `TodoWrite`,
 * Kimi `TodoList`, Droid/OpenCode `todo_write`, Codex `update_plan`.
 */
export const SNAPSHOT_TODO_TOOLS = new Set(['TodoWrite', 'TodoList', 'todo_write', 'update_plan']);

/**
 * Whether a harness's checklist status means "finished". Claude/Codex write
 * `completed`; Kimi writes `done`.
 */
export function isCompletedTodoStatus(status: unknown): boolean {
  return status === 'completed' || status === 'done';
}

/**
 * Summarize a tool_use into a one-liner string.
 */
export function summarizeToolUse(tool: string, args?: Record<string, any>): string {
  if (!args) return tool;

  switch (tool) {
    case 'Bash':
      return `Bash: ${truncate(String(args.command || '').replace(/\n/g, ' ').trim(), 120)}`;
    // `path` is the Kimi spelling of Claude's `file_path` for the same tools.
    case 'Read':
      return `Read ${shortenPath(args.file_path || args.path || '')}`;
    case 'Write':
      return `Write ${shortenPath(args.file_path || args.path || '')}`;
    case 'Edit':
      return `Edit ${shortenPath(args.file_path || args.path || '')}`;
    case 'Glob':
      return `Glob ${args.pattern || ''}`;
    case 'Grep':
      return `Grep ${args.pattern || ''} ${args.path || ''}`.trim();
    case 'Agent':
      return `Agent: ${truncate(args.description || args.prompt || '', 80)}`;
    case 'WebSearch':
    case 'WebFetch':
      return `${tool}: ${truncate(args.query || args.url || '', 80)}`;
    // Codex plan tool: arrives as a function_call with {plan:[{step,status}]}.
    case 'update_plan': {
      const steps = Array.isArray(args.plan) ? args.plan.length : 0;
      return `Plan: ${steps} step${steps === 1 ? '' : 's'}`;
    }
    // Live checklist: show progress + the current step, not a bare "TodoWrite".
    // Claude writes `TodoWrite`, Kimi writes `TodoList`; both carry the whole list
    // under `todos`, with Kimi spelling the item text `title` and "done" `done`.
    case 'TodoWrite':
    case 'TodoList': {
      const todos = Array.isArray(args.todos) ? args.todos : [];
      if (todos.length === 0) return 'Plan: 0 steps';
      const done = todos.filter((t: any) => isCompletedTodoStatus(t?.status)).length;
      const active = todos.find((t: any) => t?.status === 'in_progress');
      const step = active?.activeForm || active?.content || active?.title;
      return step
        ? `Plan ${done}/${todos.length}: ${truncate(String(step), 80)}`
        : `Plan: ${done}/${todos.length} done`;
    }
    // Codex tools
    case 'exec_command':
      return `Bash: ${truncate(String(args.command || args.cmd || '').replace(/\n/g, ' ').trim(), 120)}`;
    // Newer Codex JS-cell shell wrapper: prefer the unwrapped command (set at parse
    // time), else the extracted command, else the raw cell code.
    case 'exec': {
      const cmd = args.command || codexExecCommand(String(args.input || ''));
      if (cmd) return `Bash: ${truncate(String(cmd).replace(/\n/g, ' ').trim(), 120)}`;
      const code = String(args.input || '').replace(/\n/g, ' ').trim();
      return code ? `exec: ${truncate(code, 100)}` : 'exec';
    }
    case 'read_file':
      return `Read ${shortenPath(args.file_path || args.path || '')}`;
    case 'write_file':
    case 'create_file':
      return `Write ${shortenPath(args.file_path || args.path || '')}`;
    case 'edit_file':
      return `Edit ${shortenPath(args.file_path || args.path || '')}`;
    // Gemini tools
    case 'run_shell_command':
      return `Bash: ${truncate(String(args.command || '').replace(/\n/g, ' ').trim(), 120)}`;
    case 'search_file_content':
      return `Search ${args.pattern || ''}`;
    default: {
      // Generic: show first meaningful arg
      for (const key of ['file_path', 'path', 'pattern', 'command', 'prompt', 'query', 'url']) {
        if (args[key]) return `${tool}: ${truncate(String(args[key]), 80)}`;
      }
      return tool;
    }
  }
}


/** Replace the home directory prefix with ~ for display. */
function shortenPath(p: string): string {
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

// ---------------------------------------------------------------------------
// Claude parser
// ---------------------------------------------------------------------------

/** Parse a Claude JSONL session file into normalized events. */
export function parseClaude(filePath: string, opts: ParseSessionOptions = {}): SessionEvent[] {
  return parseClaudeContent(safeReadSessionFile(filePath), opts);
}

/**
 * Parse Claude JSONL *content* (already read into a string) into normalized
 * events. Split from `parseClaude` so the tail reader can parse just the last
 * chunk of a file without re-reading the whole thing. Malformed leading lines
 * (a tail that starts mid-line) are skipped by the per-line try/catch below.
 */
export function parseClaudeContent(
  content: string,
  opts: ParseSessionOptions = {},
): SessionEvent[] {
  const lines = content.split('\n').filter(l => l.trim());
  const events: SessionEvent[] = [];

  // Map tool_use id -> {tool, args} for correlating with tool_result
  const toolUseMap = new Map<string, { tool: string; args: Record<string, any> }>();

  for (const line of lines) {
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      /* malformed JSONL line, skip */
      continue;
    }

    const type = raw.type;
    const timestamp = raw.timestamp || new Date().toISOString();

    // Claude's own file ledger: one record per file it backed up before changing
    // it. `trackingPath` is the exact path; the record carries no add/update/
    // delete verb, so the OPERATION still comes from the tool that touched it —
    // this supplies the authoritative path set and touch time, nothing more.
    if (type === 'file-history-delta' && opts.includeFileHistory) {
      const trackingPath = typeof raw.trackingPath === 'string' ? raw.trackingPath : '';
      if (trackingPath) {
        events.push({
          type: 'file_change',
          agent: 'claude',
          timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : timestamp,
          changes: [{ path: trackingPath, op: 'modified' }],
        });
      }
      continue;
    }

    if (type === 'assistant') {
      const contentBlocks = raw.message?.content || [];
      for (const block of contentBlocks) {
        if (block.type === 'thinking') {
          // Thinking content -- may be encrypted (has .signature field)
          const thinkingText = block.thinking || '';
          if (thinkingText) {
            events.push({
              type: 'thinking',
              agent: 'claude',
              timestamp,
              content: thinkingText,
            });
          }
        } else if (block.type === 'text') {
          const text = (block.text || '').trim();
          if (text) {
            events.push({
              type: 'message',
              agent: 'claude',
              timestamp,
              role: 'assistant',
              content: text,
            });
          }
        } else if (block.type === 'tool_use') {
          const toolName = block.name || 'unknown';
          const toolInput = block.input || {};
          const toolId = block.id;
          const isLocal = toolInput.is_local === true;

          if (toolId) {
            toolUseMap.set(toolId, { tool: toolName, args: toolInput });
          }

          const event: any = {
            type: 'tool_use',
            agent: 'claude' as const,
            timestamp,
            tool: toolName,
            callId: toolId,
            args: toolInput,
            path: toolInput.file_path || undefined,
            command: toolName === 'Bash' ? toolInput.command : undefined,
          };
          // Claude writes a human `description` on every Bash call (and on Agent
          // spawns) — the one-line label the model authored for exactly this
          // purpose. `summarizeToolUse` renders the command instead, so the label
          // was reaching no consumer; the timeline's now-line is written from it.
          if (typeof toolInput.description === 'string' && toolInput.description.trim()) {
            event.label = toolInput.description.trim();
          }
          if (isLocal) event._local = true;
          // SlashCommand: the MODEL invoking a slash command programmatically
          // (distinct from the <command-name> wrapper below, which is the
          // USER typing one) — see prompt.ts's extractSlashCommandFromToolInput.
          if (toolName === 'SlashCommand') {
            const slashCommand = extractSlashCommandFromToolInput(toolInput);
            if (slashCommand) event.slashCommand = slashCommand;
          }
          events.push(event);
        }
      }
      // Capture token usage and model from assistant turn
      if (raw.message?.usage) {
        const u = raw.message.usage;
        events.push({
          type: 'usage',
          agent: 'claude',
          timestamp,
          model: raw.message.model,
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheReadTokens: u.cache_read_input_tokens,
          cacheCreationTokens: u.cache_creation_input_tokens,
        });
      }
    } else if (type === 'user') {
      const contentBlocks = raw.message?.content;

      if (typeof contentBlocks === 'string') {
        // Simple user text
        const text = contentBlocks.trim();
        if (text) {
          const event: any = {
            type: 'message',
            agent: 'claude',
            timestamp,
            role: 'user',
            content: text,
          };
          // The USER typing a slash command — Claude injects a <command-name>
          // wrapper as the message content (see prompt.ts's
          // extractSlashCommandName; distinct from the SlashCommand tool-use
          // above, which is the model invoking one programmatically).
          const slashCommand = extractSlashCommandName(text);
          if (slashCommand) event.slashCommand = slashCommand;
          events.push(event);
        }
      } else if (Array.isArray(contentBlocks)) {
        for (const block of contentBlocks) {
          if (block.type === 'text') {
            const text = (block.text || '').trim();
            if (text.startsWith('[Request interrupted')) {
              // The harness's marker for a turn the user cut short, not a user
              // message. Surfaced only on request — see includeInterrupts for why
              // the default stream must stay byte-identical.
              if (opts.includeInterrupts) {
                events.push({ type: 'interrupt', agent: 'claude', timestamp, content: text });
              }
            } else if (text) {
              events.push({
                type: 'message',
                agent: 'claude',
                timestamp,
                role: 'user',
                content: text,
              });
            }
          } else if (block.type === 'image') {
            const source = block.source || {};
            if (source.type === 'base64') {
              const sizeBytes = Math.ceil(((source.data as string)?.length || 0) * 0.75);
              events.push(normalizedAttachmentEvent('claude', timestamp, block, source, 'image/png', sizeBytes));
            } else {
              events.push(normalizedAttachmentEvent('claude', timestamp, block, source, 'image/png', 0));
            }
          } else if (block.type === 'document') {
            const source = block.source || {};
            events.push(normalizedAttachmentEvent('claude', timestamp, block, source, 'application/pdf', 0));
          } else if (block.type === 'tool_result') {
            const toolId = block.tool_use_id;
            const toolInfo = toolId ? toolUseMap.get(toolId) : undefined;
            const isError = block.is_error === true;
            const structured = structuredToolResult(block);

            // Extract output text from tool result
            let output = '';
            if (typeof block.content === 'string') {
              output = block.content;
            } else if (Array.isArray(block.content)) {
              output = block.content
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.text || '')
                .join('\n');
            }

            if (isError) {
              events.push({
                type: 'error',
                agent: 'claude',
                timestamp,
                tool: toolInfo?.tool,
                callId: toolId,
                outcome: 'error',
                exitCode: structured.exitCode,
                statusCode: structured.statusCode,
                errorCode: structured.errorCode,
                content: output || 'Tool execution failed',
                // A permission rule or a hook denied the call, or the operator cut
                // it short with Ctrl-C: it never completed, so it is not a failure
                // of the work. Claude stamps the denial kind on the enclosing
                // record (`toolDenialKind: 'permission-rule'`) and the interrupt
                // on its result (`toolUseResult.interrupted: true`).
                ...(isBlockedToolResult(raw) ? { blocked: true } : {}),
              });
            } else {
              events.push({
                type: 'tool_result',
                agent: 'claude',
                timestamp,
                tool: toolInfo?.tool,
                callId: toolId,
                success: true,
                outcome: 'ok',
                exitCode: structured.exitCode,
                statusCode: structured.statusCode,
                errorCode: structured.errorCode,
                // Not truncated here: `parseSession` caps every event's `output`
                // centrally via `maxToolOutputChars` (default 500, the same
                // bound this site used to hardcode), so the render path can ask
                // for the full text with `Infinity`.
                output,
              });
            }

            if (toolId) toolUseMap.delete(toolId);
          }
        }
      }
    } else if (type === 'result') {
      events.push({
        type: 'result',
        agent: 'claude',
        timestamp,
        content: raw.subtype || 'success',
      });
    } else if (type === 'attachment') {
      // Hook firings are recorded as attachments: `hook_success` / `hook_error` /
      // `hook_blocked` per firing, plus a derivative `hook_additional_context`
      // record for the SAME firing (shared toolUseID) — skip the derivative or
      // every firing counts twice.
      const att = raw.attachment;
      const attType = att?.type;
      if (typeof attType === 'string' && attType.startsWith('hook_') && attType !== 'hook_additional_context') {
        events.push({
          type: 'hook',
          agent: 'claude',
          timestamp,
          hookName: typeof att.hookName === 'string' ? att.hookName : undefined,
          hookEvent: typeof att.hookEvent === 'string' ? att.hookEvent : undefined,
          success: attType === 'hook_success',
        });
      }
    }
    // Skip: permission-mode, non-hook attachments, and other line types
  }

  return events;
}

// ---------------------------------------------------------------------------
// Codex parser
// ---------------------------------------------------------------------------

/** Parse a Codex JSONL session file into normalized events. */
export function parseCodex(filePath: string): SessionEvent[] {
  return parseCodexContent(safeReadSessionFile(filePath));
}

/**
 * Extract target file path(s) from a Codex apply_patch envelope. The patch body
 * opens with `*** Begin Patch` and carries one or more file ops of the form
 * `*** Update File: <path>` / `*** Add File: <path>` / `*** Delete File: <path>`.
 * Returns every path in order (a multi-file patch emits multiple paths so
 * artifact discovery sees each file — RUSH-1410). Empty when unparseable.
 */
function applyPatchTargets(input: string): Array<{ path: string; op: 'Add' | 'Update' | 'Delete' }> {
  const targets: Array<{ path: string; op: 'Add' | 'Update' | 'Delete' }> = [];
  const re = /^\*\*\* (Update|Add|Delete) File: (.+)$/gm;
  for (const m of input.matchAll(re)) {
    const p = m[2].trim();
    if (p) targets.push({ path: p, op: m[1] as 'Add' | 'Update' | 'Delete' });
  }
  return targets;
}

export function applyPatchTargetPaths(input: string): string[] {
  return applyPatchTargets(input).map((target) => target.path);
}

/** @deprecated Prefer applyPatchTargetPaths — kept for single-file call sites. */
function applyPatchTargetPath(input: string): string | undefined {
  return applyPatchTargetPaths(input)[0];
}

/**
 * Newer Codex (gpt-5.6-sol / codex >=~0.145) runs every shell command inside a JS
 * cell: a `custom_tool_call` named `exec` whose `input` is code like
 * `const r = await tools.exec_command({cmd:"git status", "workdir":"…"});`. The real
 * shell command(s) are buried in those `cmd:"…"` literals. Reuse the canonical
 * acorn-based extractor (`commandsFromCodexExec` in `tool-calls.ts`, already used by
 * the tool-call index): it walks the whole AST — so a cell that runs several via
 * `Promise.all([tools.exec_command(...), tools.exec_command(...)])` yields every
 * command, not just the first — and matches only real `tools.exec_command` calls,
 * so a `cmd:"…"` string mentioned in a comment or docstring is never mistaken for an
 * invocation. Returns `undefined` for a non-shell cell (`tools.view_image(...)`, a
 * raw JS computation) so it stays labeled by its code, not faked into a shell step.
 */
function codexExecCommand(input: string): string | undefined {
  const commands = commandsFromCodexExec(input);
  return commands.length > 0 ? commands.join('\n') : undefined;
}

/**
 * Codex writes its turn TWICE in one rollout: the raw `response_item` records
 * the model exchanged, and a parallel `event_msg` / `item_completed` stream of
 * typed, already-classified items. The two overlap — on a 6,244-line rollout on
 * zion (2026-09-06) the same turn appears as 648 `custom_tool_call` +
 * 60 `function_call` records AND as 1,038 `CommandExecution` items — so the two
 * MUST NOT be merged into one event list: every consumer that counts tool calls
 * (digest, trajectory, insights, the tool index) would double-count.
 *
 * {@link parseCodexContent} therefore keeps reading `response_item` and this is
 * a SEPARATE reader over the item stream, for consumers that want the harness's
 * own classification instead of re-deriving it: the command as Codex parsed it
 * (`parsed_cmd.type`), its `exit_code`/`status`, the per-path `FileChange`
 * ledger, `AgentMessage.phase` (`commentary` is the narration between calls),
 * web searches, sub-agent activity and compactions. The timeline fold is the
 * consumer; `parseSession` is untouched.
 *
 * Version-tolerant by construction: an item type this does not know folds to a
 * generic `other` tool_use rather than throwing, so a Codex release that adds an
 * item type degrades to a counted step instead of an empty timeline.
 */
export function parseCodexItemsContent(content: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let raw: any;
    try { raw = JSON.parse(line); } catch { continue; }
    if (raw?.type !== 'event_msg') continue;
    const payload = raw.payload || {};
    const timestamp = raw.timestamp || new Date().toISOString();

    if (payload.type === 'turn_aborted') {
      events.push({ type: 'interrupt', agent: 'codex', timestamp, content: 'Turn interrupted by user' });
      continue;
    }
    if (payload.type !== 'item_completed') continue;
    const item = payload.item || {};
    const id = typeof item.id === 'string' ? item.id : undefined;

    switch (item.type) {
      case 'AgentMessage': {
        const text = codexItemText(item.content);
        if (!text) break;
        events.push({
          type: 'message', agent: 'codex', timestamp, role: 'assistant', content: text,
          ...(typeof item.phase === 'string' ? { phase: item.phase } : {}),
        });
        break;
      }
      case 'UserMessage': {
        const text = codexItemText(item.content);
        if (text) events.push({ type: 'message', agent: 'codex', timestamp, role: 'user', content: text });
        break;
      }
      case 'CommandExecution': {
        const command = codexItemCommand(item.command);
        const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd[0] : undefined;
        const parsedType = parsed && typeof parsed === 'object' ? (parsed as any).type : undefined;
        const verbClass = CODEX_PARSED_CMD_VERBS[String(parsedType)];
        events.push({
          type: 'tool_use', agent: 'codex', timestamp, tool: 'Bash', callId: id,
          args: { command }, command,
          label: truncate(command.replace(/\n/g, ' ').trim(), 120),
          ...(verbClass ? { verbClass } : {}),
        });
        const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined;
        const failedStatus = item.status === 'failed' || item.status === 'error';
        // A search that matched nothing exits 1 and is not a failure — the same
        // rule the fold applies to Claude, kept here so the two agree.
        const benign = exitCode === 1 && CODEX_BENIGN_EXIT1_RE.test(command);
        if (failedStatus || (exitCode !== undefined && exitCode !== 0 && !benign)) {
          events.push({
            type: 'error', agent: 'codex', timestamp, tool: 'Bash', callId: id,
            outcome: 'error', ...(exitCode !== undefined ? { exitCode } : {}),
            content: 'Command failed',
          });
        } else if (exitCode !== undefined || item.status) {
          events.push({
            type: 'tool_result', agent: 'codex', timestamp, tool: 'Bash', callId: id,
            success: true, outcome: 'ok', ...(exitCode !== undefined ? { exitCode } : {}),
          });
        }
        break;
      }
      case 'FileChange': {
        const changes = codexFileChanges(item.changes);
        if (!changes.length) break;
        events.push({ type: 'file_change', agent: 'codex', timestamp, callId: id, changes });
        break;
      }
      case 'Extension': {
        const query = typeof item.query === 'string' ? item.query : '';
        events.push({
          type: 'tool_use', agent: 'codex', timestamp, tool: 'WebSearch', callId: id,
          args: { query }, verbClass: 'browser',
          label: `web search: ${truncate(query, 60)}`,
        });
        break;
      }
      case 'SubAgentActivity': {
        // `started` opens a sub-agent; the matching `completed` would count the
        // same spawn twice, so only the opening edge is a call.
        if (item.kind !== 'started') break;
        events.push({
          type: 'tool_use', agent: 'codex', timestamp, tool: 'Agent', callId: id,
          args: { path: item.agent_path }, verbClass: 'agent',
          label: `subagent ${String(item.agent_path ?? '').replace(/^\//, '') || 'started'}`,
        });
        break;
      }
      case 'McpToolCall': {
        const label = `${item.server ?? ''}.${item.tool ?? ''}`.replace(/^\.|\.$/g, '');
        events.push({
          type: 'tool_use', agent: 'codex', timestamp, tool: 'mcp', callId: id,
          args: {}, verbClass: 'other', label: label || 'mcp call',
        });
        break;
      }
      case 'ImageView': {
        events.push({
          type: 'tool_use', agent: 'codex', timestamp, tool: 'Read', callId: id,
          args: { path: item.path }, verbClass: 'read', label: 'viewed image',
        });
        break;
      }
      case 'ContextCompaction': {
        events.push({ type: 'hook', agent: 'codex', timestamp, hookName: 'ContextCompaction', content: 'context compacted' });
        break;
      }
      case 'Reasoning':
        // `summary_text` is empty on every rollout measured (13,461 items, 0 with
        // text — only `encrypted_content`), so there is nothing to read. Skipped
        // deliberately rather than emitted as an empty thinking event.
        break;
      default: {
        // Unknown item type from a newer Codex: counted, never dropped, never thrown.
        if (!item.type) break;
        events.push({
          type: 'tool_use', agent: 'codex', timestamp, tool: String(item.type), callId: id,
          args: {}, verbClass: 'other', label: String(item.type),
        });
        break;
      }
    }
  }
  return events;
}

/** Codex `parsed_cmd[0].type` → the timeline's verb class. Anything else is derived from the command. */
const CODEX_PARSED_CMD_VERBS: Record<string, SessionVerbClass | undefined> = {
  read: 'read',
  list_files: 'read',
  search: 'read',
};

/** Commands whose exit 1 means "no match", not "failed". */
const CODEX_BENIGN_EXIT1_RE = /^\s*(rg|grep|diff|test|\[)\b/;

/** Text of a Codex item's `content` array (`{ type, text }` blocks). */
function codexItemText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part: any) => (part && typeof part.text === 'string' ? part.text : ''))
    .join(' ')
    .trim();
}

/** `["/bin/zsh", "-lc", "git pull"]` → `git pull`; a plain string passes through. */
function codexItemCommand(command: unknown): string {
  if (typeof command === 'string') return command;
  if (!Array.isArray(command)) return '';
  const shellWrapped = command.length >= 3 && (command[1] === '-lc' || command[1] === '-c');
  return (shellWrapped ? command.slice(2) : command).map(String).join(' ');
}

/** Codex `FileChange.changes`: `{ "<path>": { type: "add" | "update" | "delete" } }`. */
function codexFileChanges(changes: unknown): Array<{ path: string; op: 'created' | 'modified' | 'deleted' }> {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return [];
  const ops: Record<string, 'created' | 'modified' | 'deleted'> = {
    add: 'created', update: 'modified', delete: 'deleted',
  };
  return Object.entries(changes as Record<string, any>).map(([filePath, change]) => ({
    path: filePath,
    op: ops[String(change?.type)] ?? 'modified',
  }));
}

/**
 * Parse Codex JSONL *content* (already read into a string) into normalized
 * events. Split from `parseCodex` so the tail reader can parse just the last
 * chunk without re-reading the whole file.
 */
export function parseCodexContent(content: string): SessionEvent[] {
  const lines = content.split('\n').filter(l => l.trim());
  const events: SessionEvent[] = [];

  // Track function_call id -> name for correlating with function_call_output
  const callMap = new Map<string, { name: string; args: any }>();

  for (const line of lines) {
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      /* malformed JSONL line, skip */
      continue;
    }

    const lineType = raw.type;
    const timestamp = raw.timestamp || new Date().toISOString();
    const payload = raw.payload || {};

    if (lineType === 'session_meta') {
      events.push({
        type: 'init',
        agent: 'codex',
        timestamp,
        content: `Codex ${payload.cli_version || ''} session in ${payload.cwd || ''}`.trim(),
      });
      continue;
    }

    if (lineType === 'event_msg') {
      // Web search is reported out-of-band as event_msg (not response_item).
      // The paired begin (`web_search_call`) has no query; only `web_search_end`
      // carries the resolved query string, so we emit exactly one tool_use per
      // search off the end event and ignore the begin to avoid duplicates.
      if (payload.type === 'web_search_end') {
        const query = typeof payload.query === 'string' ? payload.query : '';
        events.push({
          type: 'tool_use',
          agent: 'codex',
          timestamp,
          tool: 'WebSearch',
          args: { query },
        });
      }
      continue;
    }

    if (lineType === 'response_item') {
      const ptype = payload.type;

      if (ptype === 'message') {
        const contentBlocks = payload.content || [];
        const role = payload.role === 'user' || payload.role === 'developer' ? 'user' : 'assistant';

        for (const block of contentBlocks) {
          if (block.type === 'output_text') {
            const text = (block.text || '').trim();
            if (text) {
              events.push({
                type: 'message',
                agent: 'codex',
                timestamp,
                role: 'assistant',
                content: text,
              });
            }
          } else if (block.type === 'input_text') {
            // Developer/user input messages -- only include actual prompts, not system instructions
            const text = (block.text || '').trim();
            if (text && text.length < 2000 && !text.includes('<permissions instructions>')) {
              events.push({
                type: 'message',
                agent: 'codex',
                timestamp,
                role: 'user',
                content: text,
              });
            }
          }
        }
      } else if (ptype === 'function_call') {
        const name = payload.name || 'unknown';
        let args: any = {};
        try {
          args = typeof payload.arguments === 'string'
            ? JSON.parse(payload.arguments)
            : (payload.arguments || {});
        } catch {
          /* arguments not valid JSON, preserve raw */
          args = { raw: payload.arguments };
        }

        const callId = payload.call_id || payload.id;
        if (callId) {
          callMap.set(callId, { name, args });
        }

        events.push({
          type: 'tool_use',
          agent: 'codex',
          timestamp,
          tool: name,
          callId,
          args,
          command: name === 'exec_command' ? (args.command || args.cmd) : undefined,
          path: args.file_path || args.path || undefined,
        });
      } else if (ptype === 'function_call_output') {
        const callId = payload.call_id || payload.id;
        const callInfo = callId ? callMap.get(callId) : undefined;
        const result = structuredToolResult(payload.output);

        events.push({
          type: 'tool_result',
          agent: 'codex',
          timestamp,
          tool: callInfo?.name,
          callId,
          success: result.outcome === 'error' ? false : true,
          outcome: result.outcome,
          exitCode: result.exitCode,
          statusCode: result.statusCode,
          errorCode: result.errorCode,
          output: result.text,
        });

        if (callId) callMap.delete(callId);
      } else if (ptype === 'custom_tool_call') {
        // Codex edits arrive as custom_tool_call (apply_patch), NOT function_call.
        const rawName = payload.name || 'unknown';
        const input = typeof payload.input === 'string' ? payload.input : '';
        const isApplyPatch = rawName === 'apply_patch';
        // Newer Codex wraps shell in a JS `exec` cell — unwrap the real command so
        // the step reads by its program instead of a bare "exec" (see extractor).
        const execCommand = rawName === 'exec' ? codexExecCommand(input) : undefined;
        // Multi-file patches: one tool_use per file so artifact discovery sees
        // every path (RUSH-1410). Single-file / non-patch keep one event.
        const patchTargets = isApplyPatch ? applyPatchTargets(input) : [];
        const tool = isApplyPatch ? 'Edit' : rawName;
        const truncatedInput = input.length > 500 ? input.slice(0, 497) + '...' : input;

        const emitOne = (patchPath: string | undefined, patchOp?: 'Add' | 'Update' | 'Delete') => {
          const args: any = { input: truncatedInput };
          if (patchPath) args.file_path = patchPath;
          if (patchOp) args.patch_op = patchOp;
          if (execCommand) args.command = execCommand;
          const callId = payload.call_id || payload.id;
          if (callId) callMap.set(callId, { name: tool, args });
          events.push({
            type: 'tool_use',
            agent: 'codex',
            timestamp,
            tool,
            callId,
            args,
            command: execCommand,
            path: patchPath,
          });
        };

        if (isApplyPatch && patchTargets.length > 0) {
          for (const target of patchTargets) emitOne(target.path, target.op);
        } else {
          emitOne(undefined);
        }
      } else if (ptype === 'custom_tool_call_output') {
        const callId = payload.call_id || payload.id;
        const callInfo = callId ? callMap.get(callId) : undefined;
        const result = structuredToolResult(payload.output);

        events.push({
          type: 'tool_result',
          agent: 'codex',
          timestamp,
          tool: callInfo?.name,
          callId,
          success: result.outcome === 'error' ? false : true,
          outcome: result.outcome,
          exitCode: result.exitCode,
          statusCode: result.statusCode,
          errorCode: result.errorCode,
          output: result.text,
        });

        if (callId) callMap.delete(callId);
      } else if (ptype === 'reasoning') {
        // Codex reasoning -- try to get the readable summary
        const summaries = payload.summary || [];
        const text = summaries.length > 0
          ? summaries.map((s: any) => s.text || '').join('\n')
          : (payload.text || '');
        if (text.trim()) {
          events.push({
            type: 'thinking',
            agent: 'codex',
            timestamp,
            content: text.trim(),
          });
        }
      }
    }
    // Skip: event_msg (token_count, etc.), turn_context
  }

  return events;
}

// ---------------------------------------------------------------------------
// Gemini parser
// ---------------------------------------------------------------------------

/** Parse a Gemini JSON session file into normalized events. */
export function parseGemini(filePath: string): SessionEvent[] {
  const content = safeReadSessionFile(filePath);
  let session: any;
  try {
    session = JSON.parse(content);
  } catch {
    /* Gemini session file is not valid JSON */
    throw new Error(`Failed to parse Gemini session: ${filePath}`);
  }

  const messages = session.messages || [];
  const events: SessionEvent[] = [];

  events.push({
    type: 'init',
    agent: 'gemini',
    timestamp: session.startTime || new Date().toISOString(),
    content: `Gemini session ${session.sessionId || ''}`.trim(),
  });

  for (const msg of messages) {
    const timestamp = msg.timestamp || session.startTime || new Date().toISOString();

    if (msg.type === 'user') {
      const text = extractGeminiContent(msg.content);
      if (text) {
        events.push({
          type: 'message',
          agent: 'gemini',
          timestamp,
          role: 'user',
          content: text,
        });
      }
    } else if (msg.type === 'gemini') {
      // Reasoning thoughts
      if (Array.isArray(msg.thoughts)) {
        for (const thought of msg.thoughts) {
          const text = thought.description || thought.subject || '';
          if (text.trim()) {
            const subject = thought.subject ? `**${thought.subject}**: ` : '';
            events.push({
              type: 'thinking',
              agent: 'gemini',
              timestamp: thought.timestamp || timestamp,
              content: `${subject}${thought.description || ''}`.trim(),
            });
          }
        }
      }

      // Assistant text
      const text = extractGeminiContent(msg.content);
      if (text) {
        events.push({
          type: 'message',
          agent: 'gemini',
          timestamp,
          role: 'assistant',
          content: text,
        });
      }

      // Tool calls (Gemini inlines call + result on the same message)
      if (Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          const toolName = tc.name || 'unknown';
          const args = tc.args || {};

        events.push({
          type: 'tool_use',
          agent: 'gemini',
          timestamp: tc.timestamp || timestamp,
          tool: toolName,
          callId: typeof tc.id === 'string' ? tc.id : undefined,
          args,
            command: ['run_shell_command', 'shell', 'bash'].includes(toolName) ? args.command : undefined,
            path: args.file_path || args.path || undefined,
          });

          // Inline result
          if (tc.result || tc.status) {
            let output = '';
            if (Array.isArray(tc.result)) {
              for (const r of tc.result) {
                const resp = r?.functionResponse?.response;
                if (resp?.output) {
                  output += String(resp.output);
                }
              }
            } else if (typeof tc.result === 'string') {
              output = tc.result;
            }

            events.push({
              type: 'tool_result',
              agent: 'gemini',
              timestamp: tc.timestamp || timestamp,
              tool: toolName,
              callId: typeof tc.id === 'string' ? tc.id : undefined,
              success: tc.status === 'success',
              output,
            });
          }
        }
      }
    }
  }

  return events;
}

/**
 * Extract text content from Gemini's content field,
 * which can be a string or an array of {text: string} parts.
 */
function extractGeminiContent(content: any): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

// Antigravity's undocumented protobuf stores tool name in f2, JSON args in f3,
// and repeats request/completion with the same f1 call id, which must be deduplicated.

/** One decoded protobuf field at a single nesting level. */
type ProtoField = { field: number; wire: number; value: number | Uint8Array };

/** Read a base-128 varint from `b` at offset `i`; returns [value, nextOffset]. */
function readVarint(b: Uint8Array, i: number): [number, number] {
  let shift = 0;
  let val = 0;
  for (;;) {
    const byte = b[i++];
    val += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [val, i];
}

/** Decode a protobuf message into a flat list of fields (one nesting level). */
function decodeProtoMessage(b: Uint8Array): ProtoField[] {
  const out: ProtoField[] = [];
  let i = 0;
  while (i < b.length) {
    let tag: number;
    [tag, i] = readVarint(b, i);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      let v: number;
      [v, i] = readVarint(b, i);
      out.push({ field, wire, value: v });
    } else if (wire === 2) {
      let len: number;
      [len, i] = readVarint(b, i);
      out.push({ field, wire, value: b.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      i += 4; // fixed32 — skipped
      out.push({ field, wire, value: 0 });
    } else if (wire === 1) {
      i += 8; // fixed64 — skipped
      out.push({ field, wire, value: 0 });
    } else {
      break; // unknown wire type — stop to avoid runaway reads
    }
  }
  return out;
}

const ANTIGRAVITY_TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

/** A tool-call node recovered from a step payload. */
interface AntigravityToolCall {
  id?: string;
  name: string;
  args: Record<string, any>;
  summary?: string;
  action?: string;
}

/**
 * Recursively locate the tool-call node: the first sub-message that carries an
 * f2 string tool-name AND an f3 JSON-args string. Also captures the f1 call id
 * (used to dedupe the request + completion steps) and the f30/f31 human labels.
 */
function findAntigravityToolCall(fields: ProtoField[]): AntigravityToolCall | null {
  let id: string | undefined;
  let name: string | undefined;
  let argsJson: string | undefined;
  let summary: string | undefined;
  let action: string | undefined;
  const subs: ProtoField[][] = [];

  for (const f of fields) {
    if (f.wire !== 2) continue;
    const bytes = f.value as Uint8Array;
    const s = ANTIGRAVITY_TEXT_DECODER.decode(bytes);
    if (f.field === 1 && !id && /^[a-z0-9]{4,16}$/.test(s)) id = s;
    else if (f.field === 2 && !name && /^[a-z][a-z_]{2,30}$/.test(s)) name = s;
    else if (f.field === 3 && !argsJson && s.startsWith('{') && s.includes('"toolAction"')) argsJson = s;
    else if (f.field === 30 && !summary) summary = s;
    else if (f.field === 31 && !action) action = s;
    else {
      try {
        subs.push(decodeProtoMessage(bytes));
      } catch {
        /* not a nested message */
      }
    }
  }

  if (name && argsJson) {
    let args: Record<string, any> = {};
    try {
      args = JSON.parse(argsJson);
    } catch {
      args = { _raw: argsJson };
    }
    return { id, name, args, summary, action };
  }
  for (const sub of subs) {
    const hit = findAntigravityToolCall(sub);
    if (hit) return hit;
  }
  return null;
}

/**
 * Map an Antigravity tool name onto the shared normalized vocabulary that the
 * renderer already handles (so no render.ts changes are needed). Unknown tools
 * pass through untouched (with their JSON args) so future tools are captured.
 */
const ANTIGRAVITY_TOOL_MAP: Record<string, string> = {
  run_command: 'Bash',
  view_file: 'Read',
  read_file: 'Read',
  list_dir: 'LS',
  grep_search: 'Grep',
  replace_file_content: 'Edit',
  write_to_file: 'Write',
  // Web tools surface identically once observed:
  search_web: 'WebSearch',
  read_url: 'WebFetch',
  execute_url: 'WebFetch',
};

/**
 * Parse an Antigravity conversation SQLite DB into normalized tool_use events.
 * Deduped by the tool-call id so each tool appears once (Antigravity writes a
 * request step and a completion step that share the id).
 */
export function parseAntigravity(dbPath: string): SessionEvent[] {
  // Read the raw BLOB payloads through the node/bun SQLite wrapper (not the
  // `sqlite3` CLI) so this works on every OS — the CLI is absent on Windows.
  let rows: Array<{ step_payload: unknown }>;
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath);
    rows = db
      .prepare('SELECT idx, step_type, step_payload FROM steps ORDER BY idx;')
      .all() as Array<{ step_payload: unknown }>;
  } catch {
    /* DB not accessible, sqlite module unavailable, or query failed */
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort close */
    }
  }

  // Single timestamp for the whole session: the steps table carries no per-step
  // time column, so fall back to the DB file's mtime for a stable, sortable value.
  let timestamp = new Date().toISOString();
  try {
    timestamp = fs.statSync(dbPath).mtime.toISOString();
  } catch {
    /* file vanished between query and stat — keep now() */
  }

  const events: SessionEvent[] = [];
  const seenCallIds = new Set<string>();

  for (const row of rows) {
    const payload = row.step_payload;
    // Both node:sqlite and bun:sqlite return a BLOB as a Uint8Array (Buffer is
    // a subclass). NULL / non-blob payloads are skipped.
    if (!(payload instanceof Uint8Array)) continue;
    const bytes = payload;
    let fields: ProtoField[];
    try {
      fields = decodeProtoMessage(bytes);
    } catch {
      continue;
    }
    const call = findAntigravityToolCall(fields);
    if (!call) continue;

    // Dedupe: the request + completion steps of one tool share the f1 call id.
    if (call.id) {
      if (seenCallIds.has(call.id)) continue;
      seenCallIds.add(call.id);
    }

    const norm = ANTIGRAVITY_TOOL_MAP[call.name] || call.name;
    const a = call.args || {};
    events.push({
      type: 'tool_use',
      agent: 'antigravity',
      timestamp,
      tool: norm,
      callId: call.id,
      args: a,
      command: norm === 'Bash' ? a.CommandLine : undefined,
      // Antigravity uses PascalCase arg keys; probe the known path-bearing ones.
      path: a.AbsolutePath || a.TargetFile || a.DirectoryPath || a.SearchPath || undefined,
      // Antigravity's own short human label — free, high quality. It surfaces
      // either as the f30 string or (more reliably) as `toolSummary` inside the
      // f3 JSON args.
      content: call.summary || (typeof a.toolSummary === 'string' ? a.toolSummary : undefined) || undefined,
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Composite session file paths
// ---------------------------------------------------------------------------

/**
 * Separator between a container file and the id it holds inside a *composite*
 * session `file_path`. Some harnesses keep every session in ONE file (OpenCode's
 * single `opencode.db`), so the index stores `<container>#<session-id>` rather
 * than one path per session — e.g.
 * `/home/u/.local/share/opencode/opencode.db#ses_02410a2c…`.
 */
const SESSION_FILE_PATH_SEP = '#';

/**
 * Split a stored session `file_path` into its on-disk container and the optional
 * in-container fragment. For a plain per-session file the container is the path
 * itself and `fragment` is undefined; for a composite path it is the part before
 * the first `#` and the id after it.
 */
export function splitSessionFilePath(filePath: string): { container: string; fragment: string | undefined } {
  const hash = filePath.indexOf(SESSION_FILE_PATH_SEP);
  if (hash < 0) return { container: filePath, fragment: undefined };
  return { container: filePath.slice(0, hash), fragment: filePath.slice(hash + 1) || undefined };
}

/**
 * The filesystem path whose existence/stat decides whether a session row is
 * stale. For a composite `file_path` this is the CONTAINER file — the row is a
 * record inside it, never a filesystem entry of its own — so a composite session
 * is stale only when its container is gone. For a plain path it is the path
 * itself. Keying off the composite FORM (a `#` fragment), not any harness name,
 * means any future single-file-DB harness inherits the correct behavior.
 */
export function sessionFilePathContainer(filePath: string): string {
  return splitSessionFilePath(filePath).container;
}

// ---------------------------------------------------------------------------
// OpenCode parser
// ---------------------------------------------------------------------------

/**
 * Parse an OpenCode session from its SQLite database.
 * filePath format: "/path/to/opencode.db#session_id"
 *
 * Data model: session -> message -> part
 * Messages have role (user/assistant) and metadata.
 * Parts contain the actual content: text, tool, reasoning, patch, step-start/finish.
 */
/**
 * Parse a Grok (xAI CLI) session into normalized events.
 *
 * A Grok session dir holds several files; the conversation transcript is
 * `chat_history.jsonl`, one JSON object per line with a `type`:
 *   - `system`       — the system prompt (skipped; not conversational)
 *   - `user`         — `content` is an array of `{ type: 'text', text }` blocks
 *   - `assistant`    — `content` is a string, plus a `tool_calls[]` array of
 *                      `{ id, name, arguments }` (arguments is a JSON string)
 *   - `reasoning`    — chain-of-thought; text (when present) lives in `summary`
 *   - `tool_result`  — `{ tool_call_id, content }`, correlated back to the call
 *
 * The scanner records `summary.json` as the session's filePath (see
 * `readGrokMeta` in discover.ts), so resolve `chat_history.jsonl` from the same
 * dir; also accept being handed the transcript file directly. Per-line
 * timestamps aren't stored, so every event carries the session's `created_at`
 * (from summary.json), falling back to the transcript's mtime.
 */
/**
 * Counters Grok writes beside its transcript in `signals.json` — the only place
 * a Grok session records milestones and failures, since `chat_history.jsonl`
 * carries no timestamps and no exit codes. Read by the timeline fold to mark a
 * session that committed / opened / merged a PR and to report a tool-failure
 * count the event stream cannot supply.
 */
interface GrokSessionSignals {
  gitCommitCount: number;
  prCreatedCount: number;
  prMergedCount: number;
  toolFailureCount: number;
}

/**
 * Read `signals.json` next to a Grok transcript. Returns `undefined` when the
 * file is absent or unreadable — a Grok session simply has no signals then, and
 * the fold reports what it does have rather than inventing zeros.
 */
export function readGrokSignals(filePath: string): GrokSessionSignals | undefined {
  const signalsPath = filePath.endsWith('signals.json')
    ? filePath
    : path.join(path.dirname(filePath), 'signals.json');
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(signalsPath, 'utf-8'));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
  return {
    gitCommitCount: count(raw.gitCommitCount),
    prCreatedCount: count(raw.prCreatedCount),
    prMergedCount: count(raw.prMergedCount),
    toolFailureCount: count(raw.toolFailureCount),
  };
}

export function parseGrok(filePath: string): SessionEvent[] {
  const sessionDir = path.dirname(filePath);
  const historyPath = filePath.endsWith('chat_history.jsonl')
    ? filePath
    : path.join(sessionDir, 'chat_history.jsonl');
  if (!fs.existsSync(historyPath)) return [];

  let timestamp: string | undefined;
  try {
    const summaryPath = filePath.endsWith('summary.json')
      ? filePath
      : path.join(sessionDir, 'summary.json');
    if (fs.existsSync(summaryPath)) {
      const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
      if (typeof summary?.created_at === 'string') timestamp = summary.created_at;
    }
  } catch { /* fall back to mtime below */ }
  if (!timestamp) {
    let mtime: Date | null = null;
    try { mtime = fs.statSync(historyPath).mtime; } catch { mtime = null; }
    timestamp = (mtime ?? new Date()).toISOString();
  }

  const content = safeReadSessionFile(historyPath);
  const lines = content.split('\n').filter(l => l.trim());
  const events: SessionEvent[] = [];
  const toolCallMap = new Map<string, string>();

  // Grok text is either a plain string (assistant) or an array of typed blocks
  // (user: `{ type: 'text', text }`; reasoning summary: `{ text | summary_text }`).
  const extractText = (raw: any): string => {
    if (typeof raw === 'string') return raw.trim();
    if (Array.isArray(raw)) {
      return raw
        .map((part: any) =>
          typeof part?.text === 'string'
            ? part.text
            : typeof part?.summary_text === 'string'
              ? part.summary_text
              : '')
        .join('')
        .trim();
    }
    return '';
  };

  for (const line of lines) {
    let msg: any;
    try { msg = JSON.parse(line); } catch { continue; }
    const type = msg?.type;

    if (type === 'user') {
      const text = extractText(msg.content);
      if (text) events.push({ type: 'message', agent: 'grok', timestamp, role: 'user', content: text });
    } else if (type === 'assistant') {
      const text = extractText(msg.content);
      if (text) events.push({ type: 'message', agent: 'grok', timestamp, role: 'assistant', content: text });

      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      for (const call of calls) {
        const toolName = typeof call?.name === 'string' ? call.name : 'unknown';
        let args: Record<string, any> = {};
        if (call?.arguments && typeof call.arguments === 'object') {
          args = call.arguments;
        } else if (typeof call?.arguments === 'string') {
          try { args = JSON.parse(call.arguments); } catch { args = { _raw: call.arguments }; }
        }
        if (typeof call?.id === 'string') toolCallMap.set(call.id, toolName);
        events.push({
          type: 'tool_use',
          agent: 'grok',
          timestamp,
          tool: toolName,
          callId: typeof call?.id === 'string' ? call.id : undefined,
          args,
          path: args.path || args.file_path || undefined,
          command: typeof args.command === 'string' ? args.command : undefined,
        });
      }
    } else if (type === 'reasoning') {
      const text = extractText(msg.summary);
      if (text) events.push({ type: 'thinking', agent: 'grok', timestamp, content: text });
    } else if (type === 'tool_result') {
      const callId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : undefined;
      const toolName = (callId && toolCallMap.get(callId)) || 'unknown';
      const output = typeof msg.content === 'string' ? msg.content : extractText(msg.content);
      const structuredError = msg.is_error === true;
      const structuredSuccess = msg.is_error === false;
      const displayAsError = structuredError || (typeof output === 'string' && output.startsWith('Error:'));
      events.push({
        type: displayAsError ? 'error' : 'tool_result',
        agent: 'grok',
        timestamp,
        tool: toolName,
        callId,
        success: structuredError ? false : structuredSuccess ? true : undefined,
        outcome: structuredError ? 'error' : structuredSuccess ? 'ok' : 'unknown',
        output: output,
      });
      if (callId) toolCallMap.delete(callId);
    }
    // `system` lines are the system prompt — intentionally skipped.
  }

  return events;
}

/**
 * Byte/char caps for the OpenCode tool-part projection below. Numeric
 * constants, interpolated into the SQL — never user input.
 */
const OPENCODE_OUTPUT_MAX_CHARS = 2000;
const OPENCODE_INPUT_MAX_BYTES = 4000;

/**
 * The transcript query {@link parseOpenCode} runs, exported so a test can assert
 * the projection's real cost against a database instead of re-typing the SQL.
 *
 * A tool part is PROJECTED to exactly the fields the `case 'tool'` branch below
 * reads — `tool`, `callID`, `state.status`, `state.input`, `state.output` —
 * rather than carried whole. Two things this has to get right at once:
 *
 *   - Keep `state.input`. It carries `filePath` / `command`, and losing it is
 *     what left `recentDirectoriesTouched` empty (RUSH-2358).
 *   - Stay bounded. A tool part is not bounded by its output: on a real
 *     `opencode.db` the largest part is 1,346,068 bytes of which
 *     `state.attachments` (a base64 data URL from `read`) is 1,345,674, while
 *     `state.output` is 23. Truncating only `state.output` therefore bounded
 *     nothing — it took one session's loaded tool payload from 299,365 to
 *     1,911,209 bytes. The projection drops `attachments` (and every other
 *     unread key) outright, caps `state.output`, and collapses an oversized
 *     `state.input` to just its addressing fields. Those are the keys the
 *     enrichment reads — `filePath`/`path` for an edit and `cwd`/`workdir`/
 *     `working_directory` for a shell (`extractRecentDirectoriesTouched` in
 *     state.ts), plus `command`/`description`, themselves capped since a command
 *     can be arbitrarily long. Above the cap every other input key (an `edit`'s
 *     `oldString`/`newString`) is gone, deliberately — nothing downstream reads
 *     them, and they are the weight.
 *
 * `json_valid` guards every `json_extract`: SQLite raises "malformed JSON" on a
 * non-JSON value, which aborts the WHOLE query, so one bad `part` row would
 * otherwise cost the entire transcript. Note the single-argument form is
 * RFC-8259-strict — it rejects a JSONB blob that `json_extract` would accept.
 * That is correct for today's schema (`part.data` / `message.data` are TEXT on
 * a real database); if OpenCode ever migrates them to JSONB, these guards must
 * move to `json_valid(data, 6)` or they will drop every row.
 *
 * The session id is bound as a parameter; the two caps are numeric literals.
 */
export const OPENCODE_TRANSCRIPT_QUERY = `
  SELECT
    CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') END AS role,
    CASE WHEN json_valid(p.data) THEN json_extract(p.data, '$.type') END AS part_type,
    CASE
      WHEN json_valid(p.data) AND json_extract(p.data, '$.type') = 'tool'
      THEN json_object(
        'type', 'tool',
        'tool', json_extract(p.data, '$.tool'),
        'callID', json_extract(p.data, '$.callID'),
        'state', json_object(
          'status', json_extract(p.data, '$.state.status'),
          /* state.title is the human label OpenCode writes per call ("Read
             src/index.ts") — kept so the timeline now-line reads as the harness
             wrote it (PHNX-3939). A BLOCK comment, never a line comment: this
             template is flattened to one line below, so a line comment would
             swallow the rest of the query. */
          'title', json_extract(p.data, '$.state.title'),
          'input', CASE
            WHEN LENGTH(CAST(COALESCE(json_extract(p.data, '$.state.input'), '') AS BLOB)) > ${OPENCODE_INPUT_MAX_BYTES}
            THEN json_object(
              'filePath', json_extract(p.data, '$.state.input.filePath'),
              'path', json_extract(p.data, '$.state.input.path'),
              'command', substr(COALESCE(json_extract(p.data, '$.state.input.command'), ''), 1, ${OPENCODE_OUTPUT_MAX_CHARS}),
              'description', substr(COALESCE(json_extract(p.data, '$.state.input.description'), ''), 1, ${OPENCODE_OUTPUT_MAX_CHARS}),
              'cwd', json_extract(p.data, '$.state.input.cwd'),
              'workdir', json_extract(p.data, '$.state.input.workdir'),
              'working_directory', json_extract(p.data, '$.state.input.working_directory')
            )
            ELSE json_extract(p.data, '$.state.input')
          END,
          'output', substr(COALESCE(json_extract(p.data, '$.state.output'), ''), 1, ${OPENCODE_OUTPUT_MAX_CHARS})
        )
      )
      ELSE p.data
    END AS part_data,
    m.time_created AS time_created
  FROM message m
  JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
  WHERE m.session_id = ?
  ORDER BY m.time_created ASC, p.time_created ASC;
`.replace(/\n/g, ' ');

export function parseOpenCode(filePath: string): SessionEvent[] {
  const { container: dbPath, fragment: sessionId } = splitSessionFilePath(filePath);
  if (!dbPath || !sessionId) return [];

  const events: SessionEvent[] = [];

  // Read through the node/bun SQLite wrapper (not the `sqlite3` CLI) so this
  // works on every OS — the CLI is absent on Windows.
  let rows: Array<{ role: unknown; part_type: unknown; part_data: unknown; time_created: unknown }>;
  // OpenCode stores the session's checklist in its own `todo` table (the current
  // snapshot, not a history). Emitted below as one `todo_write` tool_use event so
  // the shared enrichment (`extractTodoProgressFromEvents`) computes `todos`
  // uniformly with every other harness (RUSH-2358).
  let todoRows: Array<{ content: unknown; status: unknown; time_updated: unknown }> = [];
  let db: Database.Database | undefined;
  try {
    // Messages with their parts, ordered chronologically. The query — and why
    // the tool part is projected rather than carried whole — is documented on
    // OPENCODE_TRANSCRIPT_QUERY above.
    db = new Database(dbPath);
    rows = db.prepare(OPENCODE_TRANSCRIPT_QUERY).all(sessionId) as Array<{
      role: unknown;
      part_type: unknown;
      part_data: unknown;
      time_created: unknown;
    }>;
    // The `todo` table is a newer OpenCode addition. Probe for it the same way
    // the scanner probes newer `session` columns, rather than wrapping the read
    // in a blanket catch — a catch there reported a locked, corrupt, or
    // permission-denied database as "this session has no todos".
    //
    // Row COUNT, not an empty-`get()` sentinel: the two production runtimes
    // disagree on what `get()` returns for no row — node:sqlite gives
    // `undefined`, bun:sqlite gives `null` (both ship; see sqlite.ts). A check
    // written against either sentinel is always-true on the other runtime,
    // which would run the `todo` SELECT on a schema that has no such table,
    // throw, and hand the whole transcript to the outer catch — an empty
    // session, silently, and only in the shipped Bun binary. `.all().length`
    // cannot express that disagreement.
    const hasTodoTable = (db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'todo';`)
      .all() as unknown[]).length > 0;
    if (hasTodoTable) {
      todoRows = db
        .prepare('SELECT content, status, time_updated FROM todo WHERE session_id = ? ORDER BY position ASC;')
        .all(sessionId) as Array<{ content: unknown; status: unknown; time_updated: unknown }>;
    }
  } catch {
    /* DB not accessible, sqlite module unavailable, or query failed */
    return events;
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort close */
    }
  }

  try {
    for (const row of rows) {
      const role = typeof row.role === 'string' ? row.role : '';
      const partType = typeof row.part_type === 'string' ? row.part_type : '';
      const partDataStr = typeof row.part_data === 'string' ? row.part_data : '';

      const timeMs = typeof row.time_created === 'number' ? row.time_created : parseInt(String(row.time_created), 10);
      const timestamp = isNaN(timeMs) ? new Date().toISOString() : new Date(timeMs).toISOString();

      let partData: any;
      try {
        partData = JSON.parse(partDataStr);
      } catch {
        /* malformed part data, skip */
        continue;
      }

      switch (partType) {
        case 'text': {
          const text = (partData.text || '').trim();
          if (text) {
            events.push({
              type: 'message',
              agent: 'opencode',
              timestamp,
              role: role === 'user' ? 'user' : 'assistant',
              content: text,
            });
          }
          break;
        }
        case 'reasoning': {
          const text = (partData.text || '').trim();
          if (text) {
            events.push({
              type: 'thinking',
              agent: 'opencode',
              timestamp,
              content: text,
            });
          }
          break;
        }
        case 'tool': {
          const toolName = partData.tool || 'unknown';
          const state = partData.state || {};
          const input = state.input || {};
          const output = state.output || '';
          const callId = typeof partData.callID === 'string' ? partData.callID : undefined;

          // OpenCode writes both a per-call `input.description` and a rendered
          // `state.title`; either is the label a person would read.
          const label = typeof input.description === 'string' && input.description.trim()
            ? input.description.trim()
            : typeof state.title === 'string' && state.title.trim()
              ? state.title.trim()
              : undefined;
          events.push({
            type: 'tool_use',
            agent: 'opencode',
            timestamp,
            tool: toolName,
            callId,
            args: input,
            command: toolName === 'shell' ? input.command : undefined,
            path: input.filePath || input.path || undefined,
            ...(label ? { label } : {}),
          });

          if (state.status === 'completed' || state.status === 'error') {
            const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
            events.push({
              type: state.status === 'error' ? 'error' : 'tool_result',
              agent: 'opencode',
              timestamp,
              tool: toolName,
              callId,
              success: state.status === 'completed',
              output: outputStr,
            });
          }
          break;
        }
        case 'patch': {
          // OpenCode's own edit ledger for one step: the exact paths it wrote.
          // The part records no add/update/delete verb, so the operation still
          // comes from the tool that produced it (see foldSessionFiles).
          const files = Array.isArray(partData.files) ? partData.files : [];
          const changes = files
            .map((file: any) => (typeof file === 'string' ? file : file?.path))
            .filter((filePath: unknown): filePath is string => typeof filePath === 'string' && filePath.length > 0)
            .map((filePath: string) => ({ path: filePath, op: 'modified' as const }));
          if (changes.length) {
            events.push({ type: 'file_change', agent: 'opencode', timestamp, changes });
          }
          break;
        }
        case 'compaction': {
          events.push({
            type: 'hook', agent: 'opencode', timestamp,
            hookName: 'ContextCompaction', content: 'context compacted',
          });
          break;
        }
        // Skip step-start, step-finish, file — not needed for transcript/trace
      }
    }
  } catch {
    /* malformed row payload — return what we parsed so far */
  }

  // Emit the OpenCode `todo` table as one `todo_write` snapshot so the shared
  // enrichment layer derives `todos` the same way it does for every harness that
  // records a checklist tool. `todo_write` is in SNAPSHOT_TODO_TOOLS, and the
  // enrichment reads `args.todos`, so the shape matches without special-casing.
  const todos = todoRows
    .map(t => ({
      content: typeof t.content === 'string' ? t.content : '',
      status: typeof t.status === 'string' ? t.status : 'pending',
    }))
    .filter(t => t.content.trim());
  if (todos.length) {
    const lastTodoMs = todoRows.reduce((max, t) => {
      const ms = typeof t.time_updated === 'number' ? t.time_updated : parseInt(String(t.time_updated), 10);
      return Number.isFinite(ms) && ms > max ? ms : max;
    }, 0);
    events.push({
      type: 'tool_use',
      agent: 'opencode',
      timestamp: lastTodoMs > 0 ? new Date(lastTodoMs).toISOString() : new Date().toISOString(),
      tool: 'todo_write',
      args: { todos },
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// OpenCode parser — cloud (normalized JSONL)
// ---------------------------------------------------------------------------
//
// OpenCode stores sessions in a SQLite DB, so the offline path reads a
// `opencode.db#<session>` composite (parseOpenCode above). The CLOUD path is
// different: the factory converts that DB into a flat, normalized JSONL
// transcript at capture time (prix/factory opencode-capture.ts, PHNX-3845), so
// the whole cloud pipeline stays SQLite-free downstream. This parser reads that
// JSONL; it's routed from TRANSCRIPT_PARSERS only when the file lives in the
// cloud session cache (isCloudSessionPath).
//
// Each line is one of:
//   transcript row:
//     { role: "user"|"assistant", part_type: "text"|"reasoning"|"tool",
//       part_data: <json string>, time_created: <ms number> }
//   todo snapshot (at most one, emitted last):
//     { part_type: "todo", todos: [{content,status}], time_created: <ms> }
//
// The per-part logic mirrors parseOpenCode's post-query switch (and prix/api's
// server-side parseOpencode) so the event stream is identical to the offline
// path. NOTE: the shell tool is named `bash` on real opencode (>=1.18.x), not
// `shell` — map `command` for both so a shell step reads by its command line.
export function parseOpencodeCloud(filePath: string): SessionEvent[] {
  const content = safeReadSessionFile(filePath);
  const lines = content.split('\n').filter(l => l.trim());
  const events: SessionEvent[] = [];

  for (const line of lines) {
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      /* malformed JSONL line, skip */
      continue;
    }

    const partType = typeof raw.part_type === 'string' ? raw.part_type : '';
    const timeMs = typeof raw.time_created === 'number'
      ? raw.time_created
      : parseInt(String(raw.time_created), 10);
    const timestamp = Number.isFinite(timeMs)
      ? new Date(timeMs).toISOString()
      : new Date().toISOString();

    // Todo snapshot: emit one `todo_write` tool_use so the shared enrichment
    // (`extractTodoProgressFromEvents`) derives `todos` the same way it does for
    // every other harness — the offline parser emits the identical event.
    if (partType === 'todo') {
      const todos = Array.isArray(raw.todos) ? raw.todos : [];
      if (todos.length) {
        events.push({
          type: 'tool_use',
          agent: 'opencode',
          timestamp,
          tool: 'todo_write',
          args: { todos },
        });
      }
      continue;
    }

    let partData: any;
    try {
      partData = JSON.parse(typeof raw.part_data === 'string' ? raw.part_data : '');
    } catch {
      /* malformed part data, skip */
      continue;
    }

    switch (partType) {
      case 'text': {
        const text = (partData.text || '').trim();
        if (text) {
          events.push({
            type: 'message',
            agent: 'opencode',
            timestamp,
            role: raw.role === 'user' ? 'user' : 'assistant',
            content: text,
          });
        }
        break;
      }
      case 'reasoning': {
        const text = (partData.text || '').trim();
        if (text) {
          events.push({
            type: 'thinking',
            agent: 'opencode',
            timestamp,
            content: text,
          });
        }
        break;
      }
      case 'tool': {
        const toolName = partData.tool || 'unknown';
        const state = partData.state || {};
        const input = state.input || {};
        const output = state.output || '';
        const callId = typeof partData.callID === 'string' ? partData.callID : undefined;

        events.push({
          type: 'tool_use',
          agent: 'opencode',
          timestamp,
          tool: toolName,
          callId,
          args: input,
          command: toolName === 'bash' || toolName === 'shell' ? input.command : undefined,
          path: input.filePath || input.path || undefined,
        });

        if (state.status === 'completed' || state.status === 'error') {
          const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
          events.push({
            type: state.status === 'error' ? 'error' : 'tool_result',
            agent: 'opencode',
            timestamp,
            tool: toolName,
            callId,
            success: state.status === 'completed',
            output: outputStr,
          });
        }
        break;
      }
      // step-start / step-finish / patch / file never reach the JSONL (dropped
      // at capture time) — nothing to handle here.
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Rush parser
//
// Rush messages.jsonl format is flat: one JSON object per line with
//   { id, session_id, role, type, content, created_at, tool_call_id?, name? }
// type ∈ {message, tool_call, tool_result}
// content varies by type:
//   message     -> { text: string }
//   tool_call   -> { input: {...} }
//   tool_result -> { input, output } (output.success === false marks an error)
// ---------------------------------------------------------------------------

/** Parse a Rush JSONL session file into normalized events. */
export function parseRush(filePath: string): SessionEvent[] {
  const content = safeReadSessionFile(filePath);
  const lines = content.split('\n').filter(l => l.trim());
  const events: SessionEvent[] = [];

  // Map tool_call id -> {tool, args} for correlating with tool_result.
  const toolCallMap = new Map<string, { tool: string; args: Record<string, any> }>();

  for (const line of lines) {
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      /* malformed JSONL line, skip */
      continue;
    }

    const type = raw.type;
    const timestamp = typeof raw.created_at === 'string' ? raw.created_at : new Date().toISOString();
    const content = raw.content && typeof raw.content === 'object' && !Array.isArray(raw.content)
      ? raw.content
      : {};

    if (type === 'message') {
      const text = typeof content.text === 'string' ? content.text.trim() : '';
      if (!text) continue;

      const role: 'user' | 'assistant' = raw.role === 'user' ? 'user' : 'assistant';
      // Rush wraps the first user turn in <user_input>...</user_input> — strip.
      const cleaned = text
        .replace(/^<user_input>/, '')
        .replace(/<\/user_input>$/, '')
        .trim();

      // Skip sentinel execution-start marker that isn't human-readable.
      if (raw.role === 'system' && cleaned === 'execution_start') continue;

      events.push({
        type: 'message',
        agent: 'rush',
        timestamp,
        role,
        content: cleaned,
      });
    } else if (type === 'tool_call') {
      const toolName = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : 'unknown';
      const args = content.input && typeof content.input === 'object' && !Array.isArray(content.input)
        ? content.input
        : {};
      const callId = typeof raw.tool_call_id === 'string' ? raw.tool_call_id : undefined;
      if (callId) toolCallMap.set(callId, { tool: toolName, args });

      events.push({
        type: 'tool_use',
        agent: 'rush',
        timestamp,
        tool: toolName,
        callId,
        args,
        path: args.file_path || args.path || undefined,
        command: (toolName === 'Bash' || toolName === 'shell') ? args.command : undefined,
      });
    } else if (type === 'tool_result') {
      const callId = typeof raw.tool_call_id === 'string' ? raw.tool_call_id : undefined;
      const info = callId ? toolCallMap.get(callId) : undefined;
      const output = content.output;

      let outputStr = '';
      if (typeof output === 'string') {
        outputStr = output;
      } else if (output !== undefined) {
        try {
          outputStr = JSON.stringify(output);
        } catch {
          outputStr = String(output);
        }
      }

      const success = output?.success !== false;
      events.push({
        type: success ? 'tool_result' : 'error',
        agent: 'rush',
        timestamp,
        tool: info?.tool ?? (typeof raw.name === 'string' ? raw.name : 'unknown'),
        callId,
        success,
        output: outputStr,
      });

      if (callId) toolCallMap.delete(callId);
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Hermes parser
//
// Hermes stores one JSON file per session at ~/.hermes/sessions/session_<id>.json:
//   { session_id, model, platform, session_start, last_updated,
//     system_prompt, message_count, messages: [{role, content}, ...] }
// Content may be a string or an array of text parts.
// ---------------------------------------------------------------------------

/**
 * Muse Code session.jsonl → normalized events.
 *
 * Muse records an append-only event log. We map:
 *   - runtime.command_intake.received / turn_submit → user message
 *   - assistant_message_committed → assistant message
 *   - model_completed.usage → usage
 *   - tool-related events when present
 */
function parseMuse(filePath: string): SessionEvent[] {
  const content = safeReadSessionFile(filePath);
  const lines = content.split('\n').filter((l) => l.trim());
  const events: SessionEvent[] = [];

  const museTs = (raw: any): string => {
    if (typeof raw?.recorded_at === 'number') {
      const v = raw.recorded_at as number;
      const ms = v > 1e14 ? Math.floor(v / 1000) : v;
      return new Date(ms).toISOString();
    }
    return new Date().toISOString();
  };

  for (const line of lines) {
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }

    const timestamp = museTs(raw);
    const payloadType = raw.payload_type as string | undefined;
    const payload = raw.payload;
    const event = payload?.event ?? payload;

    if (payloadType === 'runtime.command_intake.received') {
      const cmd = payload?.record?.command;
      if (cmd?.kind === 'turn_submit' && typeof cmd.prompt === 'string' && cmd.prompt.trim()) {
        events.push({
          type: 'message',
          agent: 'muse',
          timestamp,
          role: 'user',
          content: cmd.prompt.trim(),
        });
      }
      continue;
    }

    if (event?.kind === 'assistant_message_committed' && typeof event.text === 'string') {
      events.push({
        type: 'message',
        agent: 'muse',
        timestamp,
        role: 'assistant',
        content: event.text,
      });
      continue;
    }

    if (event?.kind === 'model_completed' && event.usage && typeof event.usage === 'object') {
      const u = event.usage;
      events.push({
        type: 'usage',
        agent: 'muse',
        timestamp,
        content: JSON.stringify({
          input_tokens: u.input_tokens ?? 0,
          output_tokens: u.output_tokens ?? 0,
          cached_tokens: u.cached_tokens ?? 0,
          reasoning_tokens: u.reasoning_tokens ?? 0,
        }),
      });
      continue;
    }

    // Tool call / result shapes when Muse records them under task events
    if (event?.kind === 'tool_call' || event?.kind === 'tool.called') {
      const tool = event.tool || event.name || event.tool_name;
      if (typeof tool === 'string') {
        events.push({
          type: 'tool_use',
          agent: 'muse',
          timestamp,
          tool,
          args: typeof event.args === 'object' ? event.args : undefined,
          callId: typeof event.call_id === 'string' ? event.call_id : undefined,
        });
      }
    }
  }

  return events;
}

/** Parse a Hermes session JSON file into normalized events. */
function parseHermes(filePath: string): SessionEvent[] {
  let session: any;
  try {
    session = JSON.parse(safeReadSessionFile(filePath));
  } catch {
    return [];
  }

  const messages = Array.isArray(session.messages) ? session.messages : [];
  const timestamp = typeof session.session_start === 'string'
    ? session.session_start
    : new Date().toISOString();

  const events: SessionEvent[] = [];
  for (const msg of messages) {
    const role = msg?.role === 'user' ? 'user' : 'assistant';
    const text = hermesContentToText(msg?.content);
    if (!text) continue;
    events.push({
      type: 'message',
      agent: 'hermes',
      timestamp,
      role,
      content: text,
    });
  }

  return events;
}

function hermesContentToText(content: any): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part: any) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      return '';
    })
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Kimi parser
//
// Kimi stores session metadata in state.json and the conversation transcript
// in agents/main/wire.jsonl under ~/.kimi-code/sessions/<workdir>/session_<uuid>/.
// wire.jsonl uses a role-based schema:
//   - "context.append_message" with role=user/assistant -> messages
//   - "context.append_loop_event" with content.part type=text/think -> message/thinking
//   - "context.append_loop_event" with event.type=tool.call -> tool_use
//   - "context.append_loop_event" with event.type=tool.result -> tool_result
//   - "usage.record" -> usage
// ---------------------------------------------------------------------------

/** Parse a Kimi session state.json file by reading its agents/main/wire.jsonl. */
export function parseKimi(filePath: string): SessionEvent[] {
  const sessionDir = path.dirname(filePath);
  const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  if (!fs.existsSync(wirePath)) {
    return [];
  }

  const content = safeReadSessionFile(wirePath);
  const lines = content.split('\n').filter(l => l.trim());
  const events: SessionEvent[] = [];

  // Map tool.call uuid -> tool name so tool.result can carry the tool name.
  const toolCallMap = new Map<string, string>();

  function extractMessageText(rawContent: any): string {
    if (typeof rawContent === 'string') return rawContent.trim();
    if (Array.isArray(rawContent)) {
      return rawContent
        .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
        .join('')
        .trim();
    }
    return '';
  }

  function timestampFrom(raw: any): string {
    const t = raw?.time;
    if (typeof t === 'number' && t > 0) {
      return new Date(t).toISOString();
    }
    return new Date().toISOString();
  }

  for (const line of lines) {
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }

    const type = raw?.type;
    const timestamp = timestampFrom(raw);

    if (type === 'context.append_message') {
      const message = raw.message || {};
      const role = message.role === 'user' ? 'user' : 'assistant';
      const text = extractMessageText(message.content);
      if (!text) continue;

      events.push({
        type: 'message',
        agent: 'kimi',
        timestamp,
        role,
        content: text,
      });
    } else if (type === 'context.append_loop_event') {
      const event = raw.event || {};
      const eventType = event.type;

      if (eventType === 'content.part') {
        const part = event.part || {};
        const partType = part.type;

        if (partType === 'text') {
          const text = typeof part.text === 'string' ? part.text.trim() : '';
          if (text) {
            events.push({
              type: 'message',
              agent: 'kimi',
              timestamp,
              role: 'assistant',
              content: text,
            });
          }
        } else if (partType === 'think') {
          const think = typeof part.think === 'string' ? part.think.trim() : '';
          if (think) {
            events.push({
              type: 'thinking',
              agent: 'kimi',
              timestamp,
              content: think,
            });
          }
        }
      } else if (eventType === 'tool.call') {
        const fn = event.function || {};
        const toolName = typeof event.name === 'string'
          ? event.name
          : typeof fn.name === 'string' ? fn.name : 'unknown';
        let args: Record<string, any> = {};
        if (event.args && typeof event.args === 'object' && !Array.isArray(event.args)) {
          args = event.args;
        } else if (typeof fn.arguments === 'string') {
          try {
            args = JSON.parse(fn.arguments);
          } catch {
            args = { _raw: fn.arguments };
          }
        } else if (fn.arguments && typeof fn.arguments === 'object' && !Array.isArray(fn.arguments)) {
          args = fn.arguments;
        }

        const rawCallId = event.toolCallId || event.uuid;
        const callId = typeof rawCallId === 'string' ? rawCallId : undefined;
        if (callId) {
          toolCallMap.set(callId, toolName);
        }

        // Kimi writes a per-call `description` on the wire event (and sometimes
        // inside the args) — the same human label Claude puts on a Bash call.
        const kimiLabel = typeof event.description === 'string' && event.description.trim()
          ? event.description.trim()
          : typeof args.description === 'string' && args.description.trim()
            ? args.description.trim()
            : undefined;
        events.push({
          type: 'tool_use',
          agent: 'kimi',
          timestamp,
          tool: toolName,
          callId,
          args,
          path: args.path || args.file_path || undefined,
          command: toolName === 'Bash' ? args.command : undefined,
          ...(kimiLabel ? { label: kimiLabel } : {}),
        });
      } else if (eventType === 'tool.result') {
        const rawCallId = event.toolCallId || event.parentUuid;
        const callId = typeof rawCallId === 'string' ? rawCallId : undefined;
        const toolName = (callId && toolCallMap.get(callId)) || 'unknown';
        const result = event.result || {};
        const output = typeof result.output === 'string' ? result.output : '';
        const structuredError = result.isError === true;
        const structuredSuccess = result.isError === false;
        const displayAsError = structuredError || (output && output.startsWith('Error:'));

        events.push({
          type: displayAsError ? 'error' : 'tool_result',
          agent: 'kimi',
          timestamp,
          tool: toolName,
          callId,
          success: structuredError ? false : structuredSuccess ? true : undefined,
          outcome: structuredError ? 'error' : structuredSuccess ? 'ok' : 'unknown',
          output: output,
        });

        if (callId) {
          toolCallMap.delete(callId);
        }
      }
    } else if (type === 'usage.record') {
      const usage = raw.usage || {};
      const inputTokens = usage.inputOther ?? usage.input_tokens;
      const outputTokens = usage.output ?? usage.output_tokens;
      if (
        (typeof inputTokens === 'number' && inputTokens >= 0) ||
        (typeof outputTokens === 'number' && outputTokens >= 0)
      ) {
        events.push({
          type: 'usage',
          agent: 'kimi',
          timestamp,
          model: raw.model || usage.model,
          inputTokens: typeof inputTokens === 'number' ? inputTokens : undefined,
          outputTokens: typeof outputTokens === 'number' ? outputTokens : undefined,
        });
      }
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Cursor and Droid (Factory) parsers
// ---------------------------------------------------------------------------

/** Parse Cursor's Anthropic-shaped message JSONL transcript. */
export function parseCursor(filePath: string): SessionEvent[] {
  return parseAnthropicMessageJsonl(filePath, 'cursor');
}

/**
 * Cursor stamps the first user turn as
 * `<timestamp>Sunday, Aug 2, 2026, 3:51 AM (UTC-7)</timestamp>` followed by the
 * real question in `<user_query>`. `Date.parse` silently DISCARDS the `(UTC-7)`
 * parenthetical and reads the rest as local time, so the offset has to be applied
 * by hand — otherwise the recovered instant is wrong on every machine whose zone
 * differs from the one that wrote the transcript.
 */
function parseCursorUserText(text: string): { text: string; timestamp?: string } {
  const stamp = text.match(/<timestamp>\s*([\s\S]*?)\s*<\/timestamp>/)?.[1]?.trim();
  return { text: unwrapUserQuery(text), timestamp: parseCursorTimestamp(stamp) };
}

function parseCursorTimestamp(stamp: string | undefined): string | undefined {
  if (!stamp) return undefined;
  const offset = stamp.match(/\(UTC([+-])(\d{1,2})(?::(\d{2}))?\)/);
  // Without a declared offset there is no instant to recover -- guessing the
  // local zone would be worse than falling back to the file mtime.
  if (!offset) return undefined;
  const wall = Date.parse(`${stamp.replace(/\s*\(UTC[^)]*\)\s*/, " ").trim()} UTC`);
  if (Number.isNaN(wall)) return undefined;
  const offsetMs = (Number(offset[2]) * 60 + Number(offset[3] ?? 0)) * 60_000;
  return new Date(offset[1] === "-" ? wall + offsetMs : wall - offsetMs).toISOString();
}

function parseAnthropicMessageJsonl(filePath: string, agent: 'cursor' | 'droid'): SessionEvent[] {
  const content = safeReadSessionFile(filePath);
  const lines = content.split('\n').filter(l => l.trim());
  const events: SessionEvent[] = [];
  const toolUseMap = new Map<string, { tool: string; args: Record<string, any> }>();
  const fallbackTimestamp = fs.statSync(filePath).mtime.toISOString();

  for (const line of lines) {
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }

    if (raw.type === 'turn_ended' || (agent === 'droid' && raw.type !== 'message')) continue;
    const message = raw.message;
    const wireRole = agent === 'cursor' ? raw.role : message?.role;
    if (!message || (agent === 'cursor' && !['user', 'assistant'].includes(wireRole))) continue;

    const role = wireRole === 'user' ? 'user' : 'assistant';
    let timestamp = raw.timestamp || fallbackTimestamp;
    const blocks = message.content;

    if (typeof blocks === 'string') {
      const parsed = agent === 'cursor' && role === 'user'
        ? parseCursorUserText(blocks)
        : { text: blocks.trim(), timestamp: undefined };
      const text = parsed.text;
      timestamp = parsed.timestamp || timestamp;
      if (text) events.push({ type: 'message', agent, timestamp, role, content: text });
      continue;
    }
    if (!Array.isArray(blocks)) continue;

    for (const block of blocks) {
      if (block.type === 'text') {
        const parsed = agent === 'cursor' && role === 'user'
          ? parseCursorUserText(block.text || '')
          : { text: (block.text || '').trim(), timestamp: undefined };
        const text = parsed.text;
        timestamp = parsed.timestamp || timestamp;
        if (text && !(role === 'user' && text.startsWith('<system-reminder>'))) {
          events.push({ type: 'message', agent, timestamp, role, content: text });
        }
      } else if (block.type === 'thinking') {
        const thinkingText = (block.thinking || '').trim();
        if (thinkingText) events.push({ type: 'thinking', agent, timestamp, content: thinkingText });
      } else if (block.type === 'tool_use') {
        const toolName = block.name || 'unknown';
        const toolInput = block.input || {};
        if (block.id) toolUseMap.set(block.id, { tool: toolName, args: toolInput });
        const event: SessionEvent = {
          type: 'tool_use',
          agent,
          timestamp,
          tool: toolName,
          callId: typeof block.id === 'string' ? block.id : undefined,
          args: toolInput,
          path: toolInput.file_path || toolInput.path || undefined,
          command: (toolName === 'Bash' || toolName === 'Execute' || toolName === 'Shell') ? toolInput.command : undefined,
        };
        // Both harnesses on this parser write the same per-call human label
        // under different keys — Cursor `description`, Droid `summary` — so the
        // timeline's now-line reads "List files" rather than `ls -la`, exactly
        // as it does for the Claude arm above.
        const label = firstString(toolInput.description, toolInput.summary);
        if (label) event.label = label;
        events.push(event);
      } else if (block.type === 'tool_result') {
        const toolId = block.tool_use_id;
        const toolInfo = toolId ? toolUseMap.get(toolId) : undefined;
        const isError = block.is_error === true;
        const output = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.filter((c: any) => c.type === 'text').map((c: any) => c.text || '').join('\n')
            : '';

        if (isError) {
          events.push({
            type: 'error', agent, timestamp, tool: toolInfo?.tool,
            callId: toolId, outcome: 'error', content: output || 'Tool execution failed',
          });
        } else {
          events.push({
            type: 'tool_result', agent, timestamp, tool: toolInfo?.tool, callId: toolId, success: true,
            output: output,
          });
        }
        if (toolId) toolUseMap.delete(toolId);
      } else if (block.type === 'image') {
        const source = block.source || {};
        const sizeBytes = source.type === 'base64' ? Math.ceil(((source.data as string)?.length || 0) * 0.75) : 0;
        events.push(normalizedAttachmentEvent(agent, timestamp, block, source, 'image/png', sizeBytes));
      }
    }
  }

  return events;
}

/**
 * Parse a Droid (Factory) JSONL session file into normalized events. Droid
 * wraps each turn in a `{type:'message', message:{role, content, modelId}}`
 * envelope; the content blocks are Anthropic-shaped (text/thinking/tool_use/
 * tool_result), so block handling mirrors the Claude parser.
 */
export function parseDroid(filePath: string): SessionEvent[] {
  return parseAnthropicMessageJsonl(filePath, 'droid');
}
