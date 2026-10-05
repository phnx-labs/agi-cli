import { AgentType } from './parsers.js';
import { extractFileOpsFromBash } from './file_ops.js';

function extractErrorFromRawEvents(events: any[], maxChars: number = 500): string | null {
  const errorKeywords = ['error', 'Error', 'ERROR', 'failed', 'Failed', 'FAILED', 'exception', 'Exception'];

  for (let i = events.length - 1; i >= Math.max(0, events.length - 20); i--) {
    const event = events[i];
    if (event.type === 'raw') {
      const content = event.content || '';
      if (typeof content === 'string') {
        const contentLower = content.toLowerCase();
        if (errorKeywords.some(keyword => contentLower.includes(keyword.toLowerCase()))) {
          let errorMsg = content.trim();
          if (errorMsg.length > maxChars) {
            errorMsg = errorMsg.substring(0, maxChars - 3) + '...';
          }
          return errorMsg;
        }
      }
    }
  }
  return null;
}

export const PRIORITY: Record<string, string[]> = {
  critical: [
    'error',
    'result',
    'file_write',
    'file_delete',
    'file_create',
  ],
  important: [
    'tool_use',
    'bash',
    'file_read',
    'thinking',
    'message',
  ],
  verbose: [
    'thinking_delta',
    'message_delta',
    'init',
    'turn_start',
    'user_message',
    'raw',
  ],
};

export function collapseEvents(events: any[], maxEvents: number = 20): any[] {
  if (events.length === 0) return [];

  const collapsed: any[] = [];
  let i = 0;

  while (i < events.length) {
    const event = events[i];
    const eventType = event.type || 'unknown';

    if (eventType === 'thinking') {
      let count = 1;
      let lastContent = event.content || '';
      let j = i + 1;

      while (j < events.length && events[j].type === 'thinking') {
        count++;
        if (events[j].content) {
          lastContent = events[j].content;
        }
        j++;
      }

      if (count > 1) {
        collapsed.push({
          type: 'thinking_summary',
          count: count,
          last_content: lastContent.length > 200 ? lastContent.slice(-200) : lastContent,
          timestamp: event.timestamp,
        });
      } else if (event.content) {
        collapsed.push(event);
      }
      i = j;
      continue;
    }

    if (eventType === 'message') {
      collapsed.push({
        type: 'message',
        content: event.content?.length > 500 ? event.content.slice(-500) : event.content,
        complete: event.complete,
        timestamp: event.timestamp,
      });
      i++;
      continue;
    }

    if (['bash', 'file_write', 'file_read', 'file_create', 'file_delete', 'tool_use'].includes(eventType)) {
      const cleaned = { ...event };
      if (cleaned.command && cleaned.command.length > 200) {
        cleaned.command = cleaned.command.slice(0, 200) + '...';
      }
      collapsed.push(cleaned);
      i++;
      continue;
    }

    if (['error', 'result'].includes(eventType)) {
      collapsed.push(event);
      i++;
      continue;
    }

    i++;
  }

  if (collapsed.length > maxEvents) {
    return collapsed.slice(-maxEvents);
  }

  return collapsed;
}

export function getToolBreakdown(events: any[]): Record<string, number> {
  const breakdown: Record<string, number> = {};

  for (const event of events) {
    const eventType = event.type || '';

    if (eventType === 'bash') {
      breakdown['bash'] = (breakdown['bash'] || 0) + 1;
    } else if (eventType === 'file_write') {
      breakdown['file_write'] = (breakdown['file_write'] || 0) + 1;
    } else if (eventType === 'file_read') {
      breakdown['file_read'] = (breakdown['file_read'] || 0) + 1;
    } else if (eventType === 'file_create') {
      breakdown['file_create'] = (breakdown['file_create'] || 0) + 1;
    } else if (eventType === 'file_delete') {
      breakdown['file_delete'] = (breakdown['file_delete'] || 0) + 1;
    } else if (eventType === 'tool_use') {
      const tool = event.tool || 'unknown';
      breakdown[tool] = (breakdown[tool] || 0) + 1;
    }
  }

  return breakdown;
}

export function groupAndFlattenEvents(events: any[]): any[] {
  if (events.length === 0) return [];

  const grouped: any[] = [];
  let i = 0;

  while (i < events.length) {
    const event = events[i];
    const eventType = event.type || 'unknown';

    if (eventType === 'message' || eventType === 'thinking') {
      let count = 1;
      let combinedContent = event.content || '';
      const isStreaming = event.complete === false;
      let j = i + 1;

      while (j < events.length && events[j].type === eventType) {
        count++;
        if (events[j].content) {
          const sep = isStreaming || events[j].complete === false
            ? ''
            : (combinedContent ? '\n' : '');
          combinedContent += sep + events[j].content;
        }
        j++;
      }

      const flattened: any = {
        type: eventType,
        content: combinedContent.length > 1000 ? combinedContent.slice(-1000) : combinedContent,
      };
      if (count > 1) {
        flattened.count = count;
      }
      grouped.push(flattened);
      i = j;
      continue;
    }

    if (['file_write', 'file_create', 'file_read', 'file_delete'].includes(eventType)) {
      const path = event.path || '';
      if (!path) {
        i++;
        continue;
      }

      const pathGroup: any = {
        type: eventType,
        path: path,
        count: 1,
      };

      let j = i + 1;
      while (j < events.length && events[j].type === eventType && events[j].path === path) {
        pathGroup.count++;
        j++;
      }

      grouped.push(pathGroup);
      i = j;
      continue;
    }

    if (eventType === 'bash') {
      const command = event.command || '';
      if (!command) {
        i++;
        continue;
      }

      const bashGroup: any = {
        type: 'bash',
        commands: [command],
        count: 1,
      };

      let j = i + 1;
      while (j < events.length && events[j].type === 'bash') {
        bashGroup.commands.push(events[j].command || '');
        bashGroup.count++;
        j++;
      }

      if (bashGroup.commands.length > 5) {
        bashGroup.commands = bashGroup.commands.slice(-5);
        bashGroup.truncated = bashGroup.count - 5;
      }

      grouped.push(bashGroup);
      i = j;
      continue;
    }

    if (eventType === 'tool_use') {
      const flattened: any = {
        type: 'tool_use',
        tool: event.tool || 'unknown',
      };
      if (event.name) flattened.name = event.name;
      if (event.input) {
        const inputStr = typeof event.input === 'string' ? event.input : JSON.stringify(event.input);
        flattened.input = inputStr.length > 200 ? inputStr.slice(0, 200) + '...' : inputStr;
      }
      grouped.push(flattened);
      i++;
      continue;
    }

    if (['error', 'result'].includes(eventType)) {
      const flattened: any = {
        type: eventType,
      };
      if (event.message) flattened.message = event.message;
      if (event.content) flattened.content = event.content;
      if (event.status) flattened.status = event.status;
      grouped.push(flattened);
      i++;
      continue;
    }

    i++;
  }

  return grouped;
}

export class AgentSummary {
  agentId: string;
  agentType: string;
  status: string;
  duration: string | null = null;

  filesModified: Set<string> = new Set();
  filesCreated: Set<string> = new Set();
  filesRead: Set<string> = new Set();
  filesDeleted: Set<string> = new Set();

  toolsUsed: Set<string> = new Set();
  toolCallCount: number = 0;
  bashCommands: string[] = [];

  errors: string[] = [];
  warnings: string[] = [];
  finalMessage: string | null = null;

  eventCount: number = 0;
  lastActivity: string | null = null;

  eventsCache: any[] = [];

  constructor(
    agentId: string,
    agentType: string,
    status: string,
    duration: string | null = null,
    eventCount: number = 0
  ) {
    this.agentId = agentId;
    this.agentType = agentType;
    this.status = status;
    this.duration = duration;
    this.eventCount = eventCount;
  }

  toDict(detailLevel: 'brief' | 'standard' | 'detailed' = 'standard'): any {
    const base: any = {
      agent_id: this.agentId,
      agent_type: this.agentType,
      status: this.status,
    };

    if (detailLevel === 'brief') {
      return {
        ...base,
        duration: this.duration,
        tool_call_count: this.toolCallCount,
        last_activity: this.lastActivity,
        files_modified: Array.from(this.filesModified).slice(0, 5),
        files_created: Array.from(this.filesCreated).slice(0, 5),
        has_errors: this.errors.length > 0,
      };
    } else if (detailLevel === 'standard') {
      return {
        ...base,
        duration: this.duration,
        files_modified: Array.from(this.filesModified),
        files_created: Array.from(this.filesCreated),
        tools_used: Array.from(this.toolsUsed),
        tool_call_count: this.toolCallCount,
        errors: this.errors.slice(0, 3),
        final_message: this.truncate(this.finalMessage, 2000),
      };
    } else {
      return {
        ...base,
        duration: this.duration,
        files_modified: Array.from(this.filesModified),
        files_created: Array.from(this.filesCreated),
        files_read: Array.from(this.filesRead),
        files_deleted: Array.from(this.filesDeleted),
        tools_used: Array.from(this.toolsUsed),
        tool_call_count: this.toolCallCount,
        bash_commands: this.bashCommands.slice(-10),
        errors: this.errors,
        warnings: this.warnings,
        final_message: this.finalMessage,
        event_count: this.eventCount,
        last_activity: this.lastActivity,
      };
    }
  }

  private truncate(text: string | null, maxLen: number): string | null {
    if (!text) return null;
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen - 3) + '...';
  }
}

export function summarizeEvents(
  agentId: string,
  agentType: string,
  status: string,
  events: any[],
  duration: string | null = null
): AgentSummary {
  const summary = new AgentSummary(agentId, agentType, status, duration, events.length);
  summary.eventsCache = events;
  summary.agentId = agentId;
  summary.agentType = agentType;
  summary.status = status;

  for (const event of events) {
    const eventType = event.type || 'unknown';
    summary.lastActivity = eventType;

    if (eventType === 'file_write') {
      const path = event.path || '';
      if (path) {
        summary.filesModified.add(path);
        summary.toolCallCount++;
      }
    } else if (eventType === 'file_create') {
      const path = event.path || '';
      if (path) {
        summary.filesCreated.add(path);
        summary.toolCallCount++;
      }
    } else if (eventType === 'file_read') {
      const path = event.path || '';
      if (path) {
        summary.filesRead.add(path);
        summary.toolCallCount++;
      }
    } else if (eventType === 'file_delete') {
      const path = event.path || '';
      if (path) {
        summary.filesDeleted.add(path);
        summary.toolCallCount++;
      }
    } else if (eventType === 'directory_list') {
      summary.toolCallCount++;
    } else if (eventType === 'tool_use') {
      const tool = event.tool || 'unknown';
      summary.toolsUsed.add(tool);
      summary.toolCallCount++;
    } else if (eventType === 'bash') {
      const command = event.command || '';
      summary.toolsUsed.add('bash');
      if (command) {
        summary.bashCommands.push(command);
        const [filesRead, filesWritten, filesDeleted] = extractFileOpsFromBash(command);
        for (const path of filesRead) {
          summary.filesRead.add(path);
        }
        for (const path of filesWritten) {
          summary.filesModified.add(path);
        }
        for (const path of filesDeleted) {
          summary.filesDeleted.add(path);
        }
      }
      summary.toolCallCount++;
    } else if (eventType === 'message') {
      const content = event.content || '';
      if (content) {
        if (event.complete === false) {
          summary.finalMessage = (summary.finalMessage || '') + content;
        } else {
          summary.finalMessage = content;
        }
      }
    } else if (eventType === 'error') {
      let errorMsg: string | null = null;
      for (const key of ['message', 'content', 'error', 'error_message', 'details']) {
        if (event[key]) {
          errorMsg = String(event[key]);
          break;
        }
      }

      if (!errorMsg) {
        errorMsg = extractErrorFromRawEvents(summary.eventsCache);
      }

      if (errorMsg) {
        if (errorMsg.length > 500) {
          errorMsg = errorMsg.substring(0, 497) + '...';
        }
        summary.errors.push(errorMsg);
      }
    } else if (eventType === 'warning') {
      const warningMsg = event.message || event.content || '';
      if (warningMsg) {
        summary.warnings.push(warningMsg);
      }
    } else if (eventType === 'result') {
      if (event.status === 'error') {
        let errorMsg: string | null = null;
        for (const key of ['message', 'error', 'error_message', 'error_details', 'details']) {
          if (event[key]) {
            errorMsg = String(event[key]);
            break;
          }
        }

        if (!errorMsg) {
          errorMsg = extractErrorFromRawEvents(summary.eventsCache);
        }

        if (errorMsg) {
          if (errorMsg.length > 500) {
            errorMsg = errorMsg.substring(0, 497) + '...';
          }
          summary.errors.push(errorMsg);
        }
      }
      if (!summary.duration && event.duration_ms) {
        const durationMs = event.duration_ms;
        const seconds = durationMs / 1000;
        if (seconds < 60) {
          if (seconds % 1 === 0) {
            summary.duration = `${Math.floor(seconds)} seconds`;
          } else {
            summary.duration = `${seconds.toFixed(1)} seconds`;
          }
        } else {
          const minutes = seconds / 60;
          summary.duration = `${minutes.toFixed(1)} minutes`;
        }
      }
    }
  }

  return summary;
}

export function getDelta(
  agentId: string,
  agentType: string,
  status: string,
  events: any[],
  since?: string | number
): any {
  let newEvents: any[];
  let sinceEvent = 0;

  if (since === undefined || since === null) {
    newEvents = events;
  } else if (typeof since === 'number') {
    sinceEvent = since;
    newEvents = events.slice(sinceEvent);
  } else if (typeof since === 'string') {
    const sinceDate = new Date(since);
    newEvents = events.filter((e: any) => {
      if (!e.timestamp) return false;
      const eventDate = new Date(e.timestamp);
      return eventDate > sinceDate;
    });
  } else {
    newEvents = events;
  }

  if (newEvents.length === 0) {
    return {
      agent_id: agentId,
      status: status,
      since_event: sinceEvent,
      new_events_count: 0,
      has_changes: false,
      new_files_created: [],
      new_files_modified: [],
      new_files_read: [],
      new_files_deleted: [],
      new_bash_commands: [],
      new_messages: [],
      new_tool_count: 0,
      new_errors: [],
    };
  }

  const summary = summarizeEvents(agentId, agentType, status, newEvents);

  return {
    agent_id: agentId,
    agent_type: agentType,
    status: status,
    since_event: sinceEvent,
    new_events_count: newEvents.length,
    current_event_count: sinceEvent + newEvents.length,
    has_changes: true,
    new_files_created: Array.from(summary.filesCreated),
    new_files_modified: Array.from(summary.filesModified),
    new_files_read: Array.from(summary.filesRead),
    new_files_deleted: Array.from(summary.filesDeleted),
    new_bash_commands: summary.bashCommands.slice(-15),
    new_messages: getLastMessages(newEvents, 5),
    new_tool_count: summary.toolCallCount,
    new_tool_calls: newEvents
      .filter((e: any) => ['tool_use', 'bash', 'file_write'].includes(e.type))
      .slice(-5)
      .map((e: any) => `${e.tool || 'unknown'}: ${e.command || e.path || ''}`),
    latest_message: summary.finalMessage,
    new_errors: summary.errors,
  };
}

export function filterEventsByPriority(
  events: any[],
  includeLevels: string[] | null = null
): any[] {
  if (!includeLevels) {
    includeLevels = ['critical', 'important'];
  }

  const allowedTypes = new Set<string>();
  for (const level of includeLevels) {
    const types = PRIORITY[level] || [];
    for (const type of types) {
      allowedTypes.add(type);
    }
  }

  return events.filter(e => allowedTypes.has(e.type));
}

export function getLastTool(events: any[]): string | null {
  if (events.length === 0) return null;

  const lastEvent = events[events.length - 1];
  const eventType = lastEvent.type || '';

  const validTypes = ['tool_use', 'bash', 'file_write', 'file_create', 'file_read', 'file_delete', 'message', 'error', 'result'];
  if (validTypes.includes(eventType)) {
    return eventType;
  }

  return null;
}

export interface QuickStatus {
  agent_id: string;
  agent_type: string;
  status: string;
  files_created: number;
  files_modified: number;
  files_deleted: number;
  files_read: number;
  tool_count: number;
  last_commands: string[];
  has_errors: boolean;
  last_message: string | null;
}

export function getToolUses(events: any[]): Array<{tool: string, args: any}> {
  const toolUses: Array<{tool: string, args: any}> = [];
  
  for (const event of events) {
    if (event.type === 'tool_use') {
      const tool = event.tool || 'unknown';
      const args = event.args || {};
      toolUses.push({ tool, args });
    }
  }
  
  return toolUses;
}

export function getLastMessages(events: any[], count: number = 3): string[] {
  const messages: string[] = [];
  let currentBuffer = '';
  let isCollecting = false;

  for (const event of events) {
    if (event.type === 'message') {
      const content = event.content || '';
      currentBuffer += content;
      isCollecting = true;
      
      if (event.complete) {
        if (currentBuffer.trim()) {
          messages.push(currentBuffer);
        }
        currentBuffer = '';
        isCollecting = false;
      }
    } else {
      if (isCollecting) {
        if (currentBuffer.trim()) {
          messages.push(currentBuffer);
        }
        currentBuffer = '';
        isCollecting = false;
      }
    }
  }

  if (isCollecting && currentBuffer.trim()) {
    messages.push(currentBuffer);
  }

  return messages.slice(-count);
}

export function getQuickStatus(
  agentId: string,
  agentType: string,
  status: string,
  events: any[]
): QuickStatus {
  const filesCreatedSet = new Set<string>();
  const filesModifiedSet = new Set<string>();
  const filesDeletedSet = new Set<string>();
  const filesReadSet = new Set<string>();
  let toolCount = 0;
  let hasErrors = false;
  const commands: string[] = [];
  let lastMessage: string | null = null;

  for (const event of events) {
    const eventType = event.type || '';

    if (eventType === 'message') {
      const content = event.content || '';
      if (content) {
        lastMessage = content;
      }
    } else if (eventType === 'file_create') {
      const path = event.path || '';
      if (path) {
        filesCreatedSet.add(path);
      }
      toolCount++;
    } else if (eventType === 'file_write') {
      const path = event.path || '';
      if (path) {
        filesModifiedSet.add(path);
      }
      toolCount++;
    } else if (eventType === 'file_delete') {
      const path = event.path || '';
      if (path) {
        filesDeletedSet.add(path);
      }
      toolCount++;
    } else if (eventType === 'file_read') {
      const path = event.path || '';
      if (path) {
        filesReadSet.add(path);
      }
      toolCount++;
    } else if (eventType === 'bash') {
      toolCount++;
      const cmd = event.command || '';
      if (cmd) {
        commands.push(cmd.length > 100 ? cmd.substring(0, 97) + '...' : cmd);
        const [filesRead, filesWritten, filesDeleted] = extractFileOpsFromBash(cmd);
        for (const path of filesRead) {
          filesReadSet.add(path);
        }
        for (const path of filesWritten) {
          filesModifiedSet.add(path);
        }
        for (const path of filesDeleted) {
          filesDeletedSet.add(path);
        }
      }
    } else if (eventType === 'directory_list') {
      toolCount++;
    } else if (['tool_use'].includes(eventType)) {
      toolCount++;
    } else if (eventType === 'error' || (eventType === 'result' && event.status === 'error')) {
      hasErrors = true;
    }
  }

  return {
    agent_id: agentId,
    agent_type: agentType,
    status: status,
    files_created: filesCreatedSet.size,
    files_modified: filesModifiedSet.size,
    files_deleted: filesDeletedSet.size,
    files_read: filesReadSet.size,
    tool_count: toolCount,
    last_commands: commands.slice(-3),
    has_errors: hasErrors,
    last_message: lastMessage,
  };
}

export function getStatusSummary(
  agentId: string,
  agentType: string,
  status: string,
  events: any[],
  duration: string | null = null
): string {
  if (events.length === 0) {
    if (status === 'running') {
      return 'Just started, no activity yet';
    }
    return 'No activity';
  }

  let fileCount = 0;
  let bashCount = 0;
  let toolCount = 0;
  let hasErrors = false;

  for (const event of events) {
    const eventType = event.type || '';

    if (['file_write', 'file_create', 'file_delete'].includes(eventType)) {
      fileCount++;
    } else if (eventType === 'bash') {
      bashCount++;
    } else if (['tool_use', 'file_read'].includes(eventType)) {
      toolCount++;
    } else if (['error', 'result'].includes(eventType)) {
      if (event.status === 'error') {
        hasErrors = true;
      }
    }
  }

  const totalTools = bashCount + toolCount;
  const parts: string[] = [];

  if (status === 'running') {
    parts.push('Running');
  } else if (status === 'completed') {
    if (hasErrors) {
      parts.push('Completed with errors');
    } else {
      parts.push('Completed successfully');
    }
  } else if (status === 'failed') {
    parts.push('Failed');
  } else if (status === 'stopped') {
    parts.push('Stopped');
  }

  if (fileCount > 0) {
    parts.push(`modified ${fileCount} file${fileCount !== 1 ? 's' : ''}`);
  }

  if (bashCount > 0) {
    parts.push(`used bash ${bashCount} time${bashCount !== 1 ? 's' : ''}`);
  }

  if (toolCount > 0 && bashCount === 0) {
    parts.push(`used ${toolCount} tool${toolCount !== 1 ? 's' : ''}`);
  }

  if (totalTools > 0 && bashCount > 0) {
    parts.push(`used ${totalTools} tool${totalTools !== 1 ? 's' : ''}`);
  }

  if (hasErrors && status === 'running') {
    parts.push('has errors');
  }

  if (parts.length === 0) {
    if (status === 'running') {
      return `Running, ${events.length} event${events.length !== 1 ? 's' : ''} so far`;
    }
    return status.charAt(0).toUpperCase() + status.slice(1);
  }

  return parts.join(', ');
}
