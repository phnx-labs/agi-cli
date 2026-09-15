/**
 * Agent event stream parsers.
 *
 * Normalizes the heterogeneous JSON event formats emitted by each agent CLI
 * (Claude, Codex, Cursor, OpenCode, Grok, Antigravity, Kimi) into a unified
 * event schema with consistent types: init, message, tool_use, bash,
 * file_read, file_write, file_create, file_delete, result, error, and others.
 */
import { extractFileOpsFromBash } from './file_ops.js';

/** Supported agent CLI types for team spawning. */
export type AgentType = 'codex' | 'cursor' | 'claude' | 'opencode' | 'grok' | 'antigravity' | 'kimi' | 'droid' | 'warp';

const claudeToolUseMap = new Map<string, { tool: string; command?: string; path?: string }>();
const droidToolUseMap = new Map<string, { tool: string; args: Record<string, any> }>();

/**
 * Registry-dispatch table: each teams `AgentType` to its live team-event
 * normalizer. Replaces the per-type name-chain — the harness axis of Move 3.
 * warp (and any unlisted type) is absent, so it falls through to the generic
 * unknown-event shape below, exactly as the old `else` did.
 */
const TEAM_EVENT_NORMALIZERS: Partial<Record<AgentType, (raw: any) => any[]>> = {
  codex: normalizeCodex,
  cursor: normalizeCursor,
  claude: normalizeClaude,
  opencode: normalizeOpencode,
  grok: normalizeGrok,
  antigravity: normalizeAntigravity,
  kimi: normalizeKimi,
  droid: normalizeDroid,
};

/** Normalize a raw JSON event from any agent type into an array of unified event objects. */
export function normalizeEvents(agentType: AgentType, raw: any): any[] {
  const normalizer = TEAM_EVENT_NORMALIZERS[agentType];
  if (normalizer) {
    return normalizer(raw);
  }

  const timestamp = new Date().toISOString();
  return [{
    type: raw.type || 'unknown',
    agent: agentType,
    raw: raw,
    timestamp: timestamp,
  }];
}

/** Normalize a raw JSON event, returning only the first unified event (convenience wrapper). */
export function normalizeEvent(agentType: AgentType, raw: any): any {
  const events = normalizeEvents(agentType, raw);
  if (events.length > 0) {
    return events[0];
  }

  return {
    type: raw.type || 'unknown',
    agent: agentType,
    raw: raw,
    timestamp: new Date().toISOString(),
  };
}

function normalizeCodex(raw: any): any[] {
  if (!raw || typeof raw !== 'object') {
    return [{
      type: 'unknown',
      agent: 'codex',
      raw: raw,
      timestamp: new Date().toISOString(),
    }];
  }

  const eventType = raw.type || 'unknown';
  const timestamp = new Date().toISOString();

  if (eventType === 'thread.started') {
    return [{
      type: 'init',
      agent: 'codex',
      session_id: raw.thread_id || null,
      timestamp: timestamp,
    }];
  } else if (eventType === 'turn.started') {
    return [{
      type: 'turn_start',
      agent: 'codex',
      timestamp: timestamp,
    }];
  } else if (eventType === 'item.completed') {
    const item = raw.item || {};
    const itemType = item?.type;

    if (itemType === 'agent_message') {
      return [{
        type: 'message',
        agent: 'codex',
        content: item?.text || '',
        complete: true,
        timestamp: timestamp,
      }];
    } else if (itemType === 'command_execution') {
      const command = item?.command || '';
      if (!command.trim()) {
        return [];
      }
      const events: any[] = [{
        type: 'bash',
        agent: 'codex',
        tool: 'command_execution',
        command: command,
        timestamp: timestamp,
      }];

      const [filesRead, filesWritten, filesDeleted] = extractFileOpsFromBash(command);
      for (const path of filesRead) {
        events.push({
          type: 'file_read',
          agent: 'codex',
          tool: 'bash',
          path,
          command,
          timestamp,
        });
      }
      for (const path of filesWritten) {
        events.push({
          type: 'file_write',
          agent: 'codex',
          tool: 'bash',
          path,
          command,
          timestamp,
        });
      }
      for (const path of filesDeleted) {
        events.push({
          type: 'file_delete',
          agent: 'codex',
          tool: 'bash',
          path,
          command,
          timestamp,
        });
      }

      return events;
    } else if (itemType === 'file_change') {
      const changes = Array.isArray(item?.changes) ? item.changes : [];
      const changeEvents: any[] = [];

      for (const change of changes) {
        const path = change?.path || change?.file_path || '';
        if (!path) {
          continue;
        }

        const kind = String(change?.kind || change?.status || '').toLowerCase();
        const baseEvent = {
          agent: 'codex',
          tool: 'file_change',
          path,
          timestamp,
        };

        if (['add', 'create', 'new'].includes(kind)) {
          changeEvents.push({ ...baseEvent, type: 'file_create' });
        } else if (['delete', 'remove'].includes(kind)) {
          changeEvents.push({ ...baseEvent, type: 'file_delete' });
        } else {
          changeEvents.push({ ...baseEvent, type: 'file_write' });
        }
      }

      if (changeEvents.length > 0) {
        return changeEvents;
      }
    } else if (itemType === 'tool_call') {
      const toolName = item?.name || 'unknown';
      const toolArgs = item?.arguments || {};

      if (toolName === 'create_file') {
        const path = toolArgs?.path || toolArgs?.file_path || '';
        if (!path) {
          return [];
        }
        return [{
          type: 'file_create',
          agent: 'codex',
          tool: toolName,
          path: path,
          timestamp: timestamp,
        }];
      } else if (toolName === 'write_file' || toolName === 'edit_file') {
        const path = toolArgs?.path || toolArgs?.file_path || '';
        if (!path) {
          return [];
        }
        return [{
          type: 'file_write',
          agent: 'codex',
          tool: toolName,
          path: path,
          timestamp: timestamp,
        }];
      } else if (toolName === 'read_file') {
        const path = toolArgs?.path || toolArgs?.file_path || '';
        if (!path) {
          return [];
        }
        return [{
          type: 'file_read',
          agent: 'codex',
          tool: toolName,
          path: path,
          timestamp: timestamp,
        }];
      } else if (toolName === 'delete_file' || toolName === 'remove_file') {
        const path = toolArgs?.path || toolArgs?.file_path || '';
        if (!path) {
          return [];
        }
        return [{
          type: 'file_delete',
          agent: 'codex',
          tool: toolName,
          path: path,
          timestamp: timestamp,
        }];
      } else if (toolName === 'shell' || toolName === 'bash' || toolName === 'execute') {
        const command = toolArgs?.command || '';
        if (!command.trim()) {
          return [];
        }
        return [{
          type: 'bash',
          agent: 'codex',
          tool: toolName,
          command: command,
          timestamp: timestamp,
        }];
      } else {
        return [{
          type: 'tool_use',
          agent: 'codex',
          tool: toolName,
          args: toolArgs,
          timestamp: timestamp,
        }];
      }
    }
  } else if (eventType === 'turn.completed') {
    const usage = raw.usage || {};
    return [{
      type: 'result',
      agent: 'codex',
      status: 'success',
      usage: {
        input_tokens: usage?.input_tokens || 0,
        output_tokens: usage?.output_tokens || 0,
      },
      timestamp: timestamp,
    }];
  }

  return [{
    type: eventType,
    agent: 'codex',
    raw: raw,
    timestamp: timestamp,
  }];
}

function normalizeCursor(raw: any): any[] {
  const eventType = raw.type || 'unknown';
  const subtype = raw.subtype;
  const timestamp = new Date().toISOString();

  if (eventType === 'system' && subtype === 'init') {
    return [{
      type: 'init',
      agent: 'cursor',
      model: raw.model,
      session_id: raw.session_id,
      timestamp: timestamp,
    }];
  } else if (eventType === 'thinking') {
    if (subtype === 'delta') {
      const text = raw.text || '';
      if (!text.trim()) {
        return [];
      }
    }
    return [{
      type: 'thinking',
      agent: 'cursor',
      content: raw.text || '',
      complete: subtype === 'completed',
      timestamp: timestamp,
    }];
  } else if (eventType === 'assistant') {
    const message = raw.message || {};
    const contentBlocks = message.content || [];
    const events: any[] = [];
    let textContent = '';

    for (const block of contentBlocks) {
      if (block.type === 'text') {
        textContent += block.text || '';
      } else if (block.type === 'tool_use') {
        events.push({
          type: 'tool_use',
          agent: 'cursor',
          tool: block.name || 'unknown',
          args: block.input || {},
          timestamp: timestamp,
        });
      }
    }

    if (textContent) {
      events.push({
        type: 'message',
        agent: 'cursor',
        content: textContent,
        complete: true,
        timestamp: timestamp,
      });
    }

    if (events.length === 0) {
      events.push({
        type: 'message',
        agent: 'cursor',
        content: '',
        complete: true,
        timestamp: timestamp,
      });
    }

    return events;
  } else if (eventType === 'result') {
    return [{
      type: 'result',
      agent: 'cursor',
      status: subtype || 'success',
      duration_ms: raw.duration_ms,
      timestamp: timestamp,
    }];
  } else if (eventType === 'tool_result') {
    return [{
      type: 'tool_result',
      agent: 'cursor',
      tool: raw.tool_name || 'unknown',
      success: raw.success !== false,
      timestamp: timestamp,
    }];
  } else if (eventType === 'tool_call' && subtype === 'completed') {
    const toolCall = raw.tool_call;

    if (toolCall?.shellToolCall) {
      const command = toolCall.shellToolCall.args?.command || '';
      return [{
        type: 'bash',
        agent: 'cursor',
        tool: 'shell',
        command: command,
        timestamp: timestamp,
      }];
    } else if (toolCall?.editToolCall) {
      const filePath = toolCall.editToolCall.args?.path || '';
      return [{
        type: 'file_write',
        agent: 'cursor',
        tool: 'edit',
        path: filePath,
        timestamp: timestamp,
      }];
    } else if (toolCall?.readToolCall) {
      const filePath = toolCall.readToolCall.args?.path || '';
      return [{
        type: 'file_read',
        agent: 'cursor',
        tool: 'read',
        path: filePath,
        timestamp: timestamp,
      }];
    } else if (toolCall?.deleteToolCall) {
      const filePath = toolCall.deleteToolCall.args?.path || '';
      return [{
        type: 'file_delete',
        agent: 'cursor',
        tool: 'delete',
        path: filePath,
        timestamp: timestamp,
      }];
    } else if (toolCall?.listToolCall) {
      const dirPath = toolCall.listToolCall.args?.path || '';
      return [{
        type: 'directory_list',
        agent: 'cursor',
        tool: 'list',
        path: dirPath,
        timestamp: timestamp,
      }];
    }

    return [{
      type: 'tool_use',
      agent: 'cursor',
      tool: Object.keys(toolCall || {})[0] || 'unknown',
      timestamp: timestamp,
    }];
  }

  return [{
    type: eventType,
    agent: 'cursor',
    raw: raw,
    timestamp: timestamp,
  }];
}

function normalizeClaude(raw: any): any[] {
  const eventType = raw.type || 'unknown';
  const subtype = raw.subtype;
  const timestamp = new Date().toISOString();

  if (eventType === 'system' && subtype === 'init') {
    return [{
      type: 'init',
      agent: 'claude',
      model: raw.model,
      session_id: raw.session_id,
      timestamp: timestamp,
    }];
  } else if (eventType === 'assistant') {
    const message = raw.message || {};
    const contentBlocks = message.content || [];
    const events: any[] = [];
    let textContent = '';

    for (const block of contentBlocks) {
      if (block.type === 'text') {
        textContent += block.text || '';
      } else if (block.type === 'tool_use') {
        const toolName = block.name || 'unknown';
        const toolId = block.id;
        const toolInput = block.input || {};
        
        if (toolId) {
          if (toolName === 'Bash' && toolInput.command) {
            claudeToolUseMap.set(toolId, { tool: toolName, command: toolInput.command });
          } else if ((toolName === 'Edit' || toolName === 'Write') && toolInput.file_path) {
            claudeToolUseMap.set(toolId, { tool: toolName, path: toolInput.file_path });
          } else if (toolName === 'Read' && toolInput.file_path) {
            claudeToolUseMap.set(toolId, { tool: toolName, path: toolInput.file_path });
          }
        }
        
        events.push({
          type: 'tool_use',
          agent: 'claude',
          tool: toolName,
          args: toolInput,
          timestamp: timestamp,
        });
      }
    }

    if (textContent) {
      events.push({
        type: 'message',
        agent: 'claude',
        content: textContent,
        complete: true,
        timestamp: timestamp,
      });
    }

    if (events.length === 0) {
      events.push({
        type: 'message',
        agent: 'claude',
        content: '',
        complete: true,
        timestamp: timestamp,
      });
    }

    return events;
  } else if (eventType === 'user') {
    const message = raw.message || {};
    const contentBlocks = message.content || [];
    const toolUseResult = raw.tool_use_result;
    const events: any[] = [];

    for (const block of contentBlocks) {
      if (block.type === 'tool_result') {
        const toolUseId = block.tool_use_id;

        if (toolUseResult?.file) {
          events.push({
            type: 'file_read',
            agent: 'claude',
            path: toolUseResult.file.filePath,
            timestamp: timestamp,
          });
        } else if (toolUseResult?.stdout !== undefined) {
          const toolUseInfo = claudeToolUseMap.get(toolUseId);
          const command = toolUseInfo?.command || '';
          events.push({
            type: 'bash',
            agent: 'claude',
            command: command,
            timestamp: timestamp,
          });
          claudeToolUseMap.delete(toolUseId);
        } else if (!block.is_error && typeof toolUseResult !== 'string') {
          const toolUseInfo = claudeToolUseMap.get(toolUseId);
          if (toolUseInfo && (toolUseInfo.tool === 'Edit' || toolUseInfo.tool === 'Write') && toolUseInfo.path) {
            events.push({
              type: 'file_write',
              agent: 'claude',
              path: toolUseInfo.path,
              timestamp: timestamp,
            });
            claudeToolUseMap.delete(toolUseId);
          } else {
            events.push({
              type: 'tool_result',
              agent: 'claude',
              tool_use_id: toolUseId,
              success: true,
              timestamp: timestamp,
            });
            if (toolUseInfo) {
              claudeToolUseMap.delete(toolUseId);
            }
          }
        } else if (block.is_error || (typeof toolUseResult === 'string' && toolUseResult.startsWith('Error:'))) {
          events.push({
            type: 'error',
            agent: 'claude',
            message: block.content || (typeof toolUseResult === 'string' ? toolUseResult : ''),
            timestamp: timestamp,
          });
        } else {
          const toolUseInfo = claudeToolUseMap.get(toolUseId);
          events.push({
            type: 'tool_result',
            agent: 'claude',
            tool_use_id: toolUseId,
            success: !block.is_error,
            timestamp: timestamp,
          });
          if (toolUseInfo) {
            claudeToolUseMap.delete(toolUseId);
          }
        }
      }
    }

    return events.length > 0 ? events : [{
      type: eventType,
      agent: 'claude',
      raw: raw,
      timestamp: timestamp,
    }];
  } else if (eventType === 'result') {
    return [{
      type: 'result',
      agent: 'claude',
      status: subtype || 'success',
      duration_ms: raw.duration_ms,
      timestamp: timestamp,
    }];
  }

  return [{
    type: eventType,
    agent: 'claude',
    raw: raw,
    timestamp: timestamp,
  }];
}

// --- OpenCode parsing ---
// OpenCode outputs JSON events with step_start, tool_use, text, step_finish types

function normalizeOpencode(raw: any): any[] {
  if (!raw || typeof raw !== 'object') {
    return [{
      type: 'unknown',
      agent: 'opencode',
      raw: raw,
      timestamp: new Date().toISOString(),
    }];
  }

  const eventType = raw?.type || 'unknown';
  const timestamp = raw?.timestamp ? new Date(raw.timestamp).toISOString() : new Date().toISOString();
  const part = raw?.part || {};

  if (eventType === 'step_start' || eventType === 'step-start') {
    return [{
      type: 'init',
      agent: 'opencode',
      session_id: part?.sessionID || null,
      timestamp: timestamp,
    }];
  }

  if (eventType === 'tool_use') {
    const toolName = part?.tool || 'unknown';
    const state = part?.state || {};
    const input = state?.input || {};
    const status = state?.status || 'unknown';

    const events: any[] = [];

    if (toolName === 'bash' && input?.command) {
      events.push({
        type: 'bash',
        agent: 'opencode',
        tool: toolName,
        command: input.command,
        timestamp: timestamp,
      });

      const [filesRead, filesWritten, filesDeleted] = extractFileOpsFromBash(input.command);
      for (const path of filesRead) {
        events.push({ type: 'file_read', agent: 'opencode', tool: 'bash', path, command: input.command, timestamp });
      }
      for (const path of filesWritten) {
        events.push({ type: 'file_write', agent: 'opencode', tool: 'bash', path, command: input.command, timestamp });
      }
      for (const path of filesDeleted) {
        events.push({ type: 'file_delete', agent: 'opencode', tool: 'bash', path, command: input.command, timestamp });
      }

      return events;
    }

    const filePath = input?.path || input?.file_path || '';

    if (toolName === 'edit_file' || toolName === 'write_file' || toolName === 'create_file') {
      if (filePath.trim()) {
        return [{
          type: 'file_write',
          agent: 'opencode',
          tool: toolName,
          path: filePath,
          timestamp: timestamp,
        }];
      }
    }

    if (toolName === 'read_file' || toolName === 'view_file') {
      if (filePath.trim()) {
        return [{
          type: 'file_read',
          agent: 'opencode',
          tool: toolName,
          path: filePath,
          timestamp: timestamp,
        }];
      }
    }

    if (toolName === 'delete_file' || toolName === 'remove_file') {
      if (filePath.trim()) {
        return [{
          type: 'file_delete',
          agent: 'opencode',
          tool: toolName,
          path: filePath,
          timestamp: timestamp,
        }];
      }
    }

    return [{
      type: 'tool_use',
      agent: 'opencode',
      tool: toolName,
      args: input,
      timestamp: timestamp,
    }];
  }

  if (eventType === 'text') {
    const text = part?.text || '';
    return [{
      type: 'message',
      agent: 'opencode',
      content: text,
      complete: true,
      timestamp: timestamp,
    }];
  }

  if (eventType === 'step_finish' || eventType === 'step-finish') {
    const reason = part?.reason || 'unknown';
    const status = reason === 'stop' ? 'success' : (reason === 'error' ? 'error' : 'success');
    return [{
      type: 'result',
      agent: 'opencode',
      status: status,
      cost: part?.cost || 0,
      tokens: part?.tokens || {},
      timestamp: timestamp,
    }];
  }

  return [{
    type: eventType,
    agent: 'opencode',
    raw: raw,
    timestamp: timestamp,
  }];
}

// --- Grok parsing ---
// Grok's streaming-json mode emits one JSON object per token, with three event
// types:
//   {"type":"thought","data":"<chunk>"}   — reasoning tokens (many, small)
//   {"type":"text","data":"<chunk>"}      — visible response tokens (many, small)
//   {"type":"end","stopReason":"EndTurn","sessionId":"<uuid>","requestId":"<uuid>"}
//
// Tool calls are NOT exposed as separate events in this format; they appear
// inside the `thought` text as XML-like markup. Extracting them reliably would
// require running a streaming XML/markup parser over concatenated thought
// chunks, which is out of scope for v1. The teams summary will show grok
// teammates' bash/file ops as empty — known limitation, fixable later by
// switching to grok's `agent` subcommand (richer event stream) once stable.
//
// Tokens are emitted as `message` events with `complete: false` so the
// summarizer can concatenate them into a final message; `thinking` events are
// already collapsed by the summarizer's groupAndFlattenEvents pathway.
function normalizeGrok(raw: any): any[] {
  if (!raw || typeof raw !== 'object') {
    return [{
      type: 'unknown',
      agent: 'grok',
      raw: raw,
      timestamp: new Date().toISOString(),
    }];
  }

  const eventType = raw.type || 'unknown';
  const timestamp = new Date().toISOString();

  if (eventType === 'thought') {
    const data = typeof raw.data === 'string' ? raw.data : '';
    if (!data) return [];
    return [{
      type: 'thinking',
      agent: 'grok',
      content: data,
      timestamp: timestamp,
    }];
  }

  if (eventType === 'text') {
    const data = typeof raw.data === 'string' ? raw.data : '';
    if (!data) return [];
    return [{
      type: 'message',
      agent: 'grok',
      content: data,
      complete: false,
      timestamp: timestamp,
    }];
  }

  if (eventType === 'end') {
    const stopReason = typeof raw.stopReason === 'string' ? raw.stopReason : '';
    const status = stopReason === 'EndTurn' || stopReason === 'StopSequence' || stopReason === ''
      ? 'success'
      : 'error';
    return [{
      type: 'result',
      agent: 'grok',
      status: status,
      stop_reason: stopReason || null,
      session_id: typeof raw.sessionId === 'string' ? raw.sessionId : null,
      timestamp: timestamp,
    }];
  }

  return [{
    type: eventType,
    agent: 'grok',
    raw: raw,
    timestamp: timestamp,
  }];
}

// --- Kimi parsing ---
// Kimi's `--output-format stream-json` emits one JSON object per line with a
// simple `role`-based schema:
//   - {"role":"assistant","content":"..."}                          → final message
//   - {"role":"assistant","tool_calls":[{"function":{"name":"Bash","arguments":"<json>"}}]} → tool use
//   - {"role":"tool","tool_call_id":"...","content":"..."}            → tool result
//   - {"role":"meta","type":"session.resume_hint","session_id":"..."} → terminal/result
// Kimi emits NO dedicated result/turn-complete event and NO init event. The
// `session.resume_hint` meta is its terminal marker: emitted exactly once, as
// the LAST line, on clean completion (it carries the `kimi -r <id>` resume
// command). We map it to a success `result` so the team runner resolves status
// from the stream; the run's exit code remains the safety net for crashes that
// never reach the hint. Tool arguments are JSON-stringified inside
// `function.arguments` and must be parsed before extracting paths/commands.
// Verified against live `kimi` runs (no-tool and tool-using) — see
// __tests__/testdata/kimi-stream-*.jsonl.
function normalizeKimi(raw: any): any[] {
  const timestamp = new Date().toISOString();

  if (!raw || typeof raw !== 'object') {
    return [{
      type: 'unknown',
      agent: 'kimi',
      raw: raw,
      timestamp: timestamp,
    }];
  }

  const role = typeof raw.role === 'string' ? raw.role : '';

  // Assistant message (final answer or tool-call request).
  if (role === 'assistant') {
    const events: any[] = [];

    if (typeof raw.content === 'string' && raw.content) {
      events.push({
        type: 'message',
        agent: 'kimi',
        content: raw.content,
        complete: true,
        timestamp: timestamp,
      });
    }

    const toolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
    for (const toolCall of toolCalls) {
      const fn = toolCall?.function || {};
      const toolName = typeof fn.name === 'string' ? fn.name : 'unknown';
      let toolArgs: any = {};
      if (typeof fn.arguments === 'string') {
        try {
          toolArgs = JSON.parse(fn.arguments);
        } catch {
          toolArgs = { _raw: fn.arguments };
        }
      } else if (fn.arguments && typeof fn.arguments === 'object') {
        toolArgs = fn.arguments;
      }

      const filePath = toolArgs?.path || toolArgs?.file_path || '';
      const command = toolArgs?.command || '';

      // Map known tools to structured events. If a known tool is missing the
      // fields we need (e.g. unparseable arguments), fall back to tool_use so
      // the event is still visible in summaries rather than dropped.
      let normalized: any[] | null = null;
      if (toolName === 'Bash' && command) {
        const bashEvents: any[] = [{
          type: 'bash',
          agent: 'kimi',
          tool: toolName,
          command: command,
          timestamp: timestamp,
        }];
        const [filesRead, filesWritten, filesDeleted] = extractFileOpsFromBash(command);
        for (const p of filesRead) {
          bashEvents.push({ type: 'file_read', agent: 'kimi', tool: 'bash', path: p, command, timestamp });
        }
        for (const p of filesWritten) {
          bashEvents.push({ type: 'file_write', agent: 'kimi', tool: 'bash', path: p, command, timestamp });
        }
        for (const p of filesDeleted) {
          bashEvents.push({ type: 'file_delete', agent: 'kimi', tool: 'bash', path: p, command, timestamp });
        }
        normalized = bashEvents;
      } else if (toolName === 'Read' && filePath) {
        normalized = [{
          type: 'file_read',
          agent: 'kimi',
          tool: toolName,
          path: filePath,
          timestamp: timestamp,
        }];
      } else if (toolName === 'Edit' && filePath) {
        normalized = [{
          type: 'file_write',
          agent: 'kimi',
          tool: toolName,
          path: filePath,
          timestamp: timestamp,
        }];
      } else if (toolName === 'Write' && filePath) {
        normalized = [{
          type: 'file_create',
          agent: 'kimi',
          tool: toolName,
          path: filePath,
          timestamp: timestamp,
        }];
      }

      if (normalized) {
        events.push(...normalized);
      } else {
        events.push({
          type: 'tool_use',
          agent: 'kimi',
          tool: toolName,
          args: toolArgs,
          timestamp: timestamp,
        });
      }
    }

    return events.length > 0 ? events : [];
  }

  // Tool result (response to an assistant tool_call).
  if (role === 'tool') {
    const content = typeof raw.content === 'string' ? raw.content : '';
    const success = raw.isError !== true && !(content && content.startsWith('Error:'));
    return [{
      type: 'tool_result',
      agent: 'kimi',
      tool_call_id: typeof raw.tool_call_id === 'string' ? raw.tool_call_id : null,
      success: success,
      content: content,
      timestamp: timestamp,
    }];
  }

  // Meta events (session lifecycle).
  if (role === 'meta') {
    const metaType = typeof raw.type === 'string' ? raw.type : '';
    if (metaType === 'session.resume_hint') {
      // Kimi's terminal marker (see header). Emit a success `result` so the
      // team runner's terminal-event detection resolves the teammate to
      // COMPLETED from the stream. session_id is preserved for cross-
      // referencing — readNewEvents() captures it off any event.
      return [{
        type: 'result',
        agent: 'kimi',
        status: 'success',
        session_id: typeof raw.session_id === 'string' ? raw.session_id : null,
        timestamp: timestamp,
      }];
    }
    return [{
      type: 'meta',
      agent: 'kimi',
      meta_type: metaType,
      raw: raw,
      timestamp: timestamp,
    }];
  }

  return [{
    type: raw.type || 'unknown',
    agent: 'kimi',
    raw: raw,
    timestamp: timestamp,
  }];
}

// --- Droid parsing ---
// Droid's `droid exec -o stream-json` stream mirrors the Factory session JSONL
// envelope: session_start records plus Anthropic-shaped message content blocks.
// Tool blocks carry the actionable file path / command in `input`; result blocks
// only carry `tool_use_id`, so keep a small id map just like normalizeClaude.
function normalizeDroid(raw: any): any[] {
  const timestamp = typeof raw?.timestamp === 'string' ? raw.timestamp : new Date().toISOString();

  if (!raw || typeof raw !== 'object') {
    return [{
      type: 'unknown',
      agent: 'droid',
      raw: raw,
      timestamp: timestamp,
    }];
  }

  const eventType = typeof raw.type === 'string' ? raw.type : 'unknown';

  if (eventType === 'session_start') {
    return [{
      type: 'init',
      agent: 'droid',
      session_id: typeof raw.id === 'string' ? raw.id : null,
      timestamp: timestamp,
    }];
  }

  if (eventType === 'result') {
    return [{
      type: 'result',
      agent: 'droid',
      status: raw.is_error === true ? 'error' : 'success',
      message: typeof raw.result === 'string' ? raw.result : undefined,
      timestamp: timestamp,
    }];
  }

  if (eventType !== 'message') {
    return [{
      type: eventType,
      agent: 'droid',
      raw: raw,
      timestamp: timestamp,
    }];
  }

  const message = raw.message || {};
  const role = message.role === 'user' ? 'user' : 'assistant';
  const blocks = message.content;

  if (typeof blocks === 'string') {
    const content = blocks.trim();
    if (!content) return [];
    return role === 'assistant'
      ? [{ type: 'message', agent: 'droid', content, complete: true, timestamp }]
      : [{ type: 'user_message', agent: 'droid', content, timestamp }];
  }

  if (!Array.isArray(blocks)) return [];

  const events: any[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text.trim() : '';
      if (!text) continue;
      if (role === 'assistant') {
        events.push({
          type: 'message',
          agent: 'droid',
          content: text,
          complete: true,
          timestamp: timestamp,
        });
      } else if (!text.startsWith('<system-reminder>') && !text.startsWith('Hook execution:')) {
        events.push({
          type: 'user_message',
          agent: 'droid',
          content: text,
          timestamp: timestamp,
        });
      }
      continue;
    }

    if (block.type === 'thinking') {
      const thinking = typeof block.thinking === 'string' ? block.thinking.trim() : '';
      if (thinking) {
        events.push({
          type: 'thinking',
          agent: 'droid',
          content: thinking,
          timestamp: timestamp,
        });
      }
      continue;
    }

    if (block.type === 'tool_use') {
      events.push(...normalizeDroidToolUse(block, timestamp));
      continue;
    }

    if (block.type === 'tool_result') {
      const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
      const toolInfo = toolUseId ? droidToolUseMap.get(toolUseId) : undefined;
      if (toolUseId) droidToolUseMap.delete(toolUseId);

      const content = extractDroidToolResultContent(block.content);
      if (block.is_error === true) {
        events.push({
          type: 'error',
          agent: 'droid',
          tool: toolInfo?.tool,
          content: content || 'Tool execution failed',
          timestamp: timestamp,
        });
      } else {
        events.push({
          type: 'tool_result',
          agent: 'droid',
          tool: toolInfo?.tool,
          tool_call_id: toolUseId,
          success: true,
          content: content.length > 500 ? content.slice(0, 497) + '...' : content,
          timestamp: timestamp,
        });
      }
    }
  }

  return events;
}

function normalizeDroidToolUse(block: any, timestamp: string): any[] {
  const toolName = typeof block.name === 'string' ? block.name : 'unknown';
  const toolInput = block.input && typeof block.input === 'object' ? block.input : {};
  if (typeof block.id === 'string') {
    droidToolUseMap.set(block.id, { tool: toolName, args: toolInput });
  }

  const filePath = toolInput.file_path || toolInput.path || '';
  const command = toolInput.command || '';

  if ((toolName === 'Execute' || toolName === 'Bash') && command) {
    const events: any[] = [{
      type: 'bash',
      agent: 'droid',
      tool: toolName,
      command: command,
      timestamp: timestamp,
    }];
    const [filesRead, filesWritten, filesDeleted] = extractFileOpsFromBash(command);
    for (const path of filesRead) {
      events.push({ type: 'file_read', agent: 'droid', tool: 'bash', path, command, timestamp });
    }
    for (const path of filesWritten) {
      events.push({ type: 'file_write', agent: 'droid', tool: 'bash', path, command, timestamp });
    }
    for (const path of filesDeleted) {
      events.push({ type: 'file_delete', agent: 'droid', tool: 'bash', path, command, timestamp });
    }
    return events;
  }

  if (toolName === 'Read' && filePath) {
    return [{
      type: 'file_read',
      agent: 'droid',
      tool: toolName,
      path: filePath,
      timestamp: timestamp,
    }];
  }

  if ((toolName === 'Create' || toolName === 'Write') && filePath) {
    return [{
      type: 'file_create',
      agent: 'droid',
      tool: toolName,
      path: filePath,
      timestamp: timestamp,
    }];
  }

  if ((toolName === 'Edit' || toolName === 'MultiEdit') && filePath) {
    return [{
      type: 'file_write',
      agent: 'droid',
      tool: toolName,
      path: filePath,
      timestamp: timestamp,
    }];
  }

  if ((toolName === 'Delete' || toolName === 'Remove') && filePath) {
    return [{
      type: 'file_delete',
      agent: 'droid',
      tool: toolName,
      path: filePath,
      timestamp: timestamp,
    }];
  }

  return [{
    type: 'tool_use',
    agent: 'droid',
    tool: toolName,
    args: toolInput,
    timestamp: timestamp,
  }];
}

function extractDroidToolResultContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part && typeof part === 'object' && part.type === 'text')
      .map((part: any) => typeof part.text === 'string' ? part.text : '')
      .join('\n');
  }
  return '';
}

// --- Antigravity parsing ---
// Intentionally conservative. Antigravity's `agy` binary advertises an
// `--output-format json` flag in its docs, but the released binary errors with
// `flags provided but not defined: -output-format` (tracked upstream as
// google-antigravity/antigravity-cli#7, open as of May 2026). Until JSON
// streaming stabilizes, this parser treats agy output as a black box:
//   - non-object input (a plain string line, or null/number) becomes a single
//     `message` event with the full content and complete:true so the
//     summarizer captures it without token-level concatenation
//   - objects with a recognizable `type` field (e.g. `init`, `message`,
//     `result`) get a minimal shape-preserving normalization
//   - everything else falls through to the generic unknown-event shape
// Once agy ships stable streaming JSON, replace this with proper event
// mapping mirroring normalizeGrok / normalizeClaude.
function normalizeAntigravity(raw: any): any[] {
  const timestamp = new Date().toISOString();

  if (typeof raw === 'string') {
    if (!raw) return [];
    return [{
      type: 'message',
      agent: 'antigravity',
      content: raw,
      complete: true,
      timestamp: timestamp,
    }];
  }

  if (!raw || typeof raw !== 'object') {
    return [{
      type: 'unknown',
      agent: 'antigravity',
      raw: raw,
      timestamp: timestamp,
    }];
  }

  const eventType = raw.type || 'unknown';

  if (eventType === 'init') {
    return [{
      type: 'init',
      agent: 'antigravity',
      session_id: typeof raw.sessionId === 'string' ? raw.sessionId : null,
      timestamp: timestamp,
    }];
  }

  if (eventType === 'message') {
    const content = typeof raw.content === 'string' ? raw.content : '';
    if (!content) return [];
    return [{
      type: 'message',
      agent: 'antigravity',
      content: content,
      complete: raw.complete !== false,
      timestamp: timestamp,
    }];
  }

  if (eventType === 'result') {
    return [{
      type: 'result',
      agent: 'antigravity',
      status: raw.status === 'error' ? 'error' : 'success',
      session_id: typeof raw.sessionId === 'string' ? raw.sessionId : null,
      timestamp: timestamp,
    }];
  }

  return [{
    type: eventType,
    agent: 'antigravity',
    raw: raw,
    timestamp: timestamp,
  }];
}

/** Parse a single JSONL line into normalized events. Returns null if the line is not valid JSON. */
export function parseEvent(agentType: AgentType, line: string): any[] | null {
  try {
    const raw = JSON.parse(line);
    return normalizeEvents(agentType, raw);
  } catch {
    return null;
  }
}
