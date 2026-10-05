
import chalk from 'chalk';
import type { CloudEvent, CloudTaskStatus } from './types.js';

function decodeSSEFrame(name: string, data: string, timestamp: string): CloudEvent {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = data ? JSON.parse(data) : {};
  } catch {
  }

  switch (name) {
    case 'status':
      return { type: 'status', status: (parsed.status as CloudTaskStatus) ?? 'running', timestamp };
    case 'text':
    case 'output':
    case 'message':
      return { type: 'text', content: (parsed.content as string) ?? data, timestamp };
    case 'thinking':
      return { type: 'thinking', content: (parsed.content as string) ?? data, timestamp };
    case 'tool_use':
      return { type: 'tool_use', tool: (parsed.tool as string) ?? '', input: parsed.input, timestamp };
    case 'tool_result':
      return { type: 'tool_result', tool: (parsed.tool as string) ?? '', output: parsed.output, timestamp };
    case 'usage':
      return {
        type: 'usage',
        model: parsed.model as string | undefined,
        inputTokens: parsed.inputTokens as number | undefined,
        outputTokens: parsed.outputTokens as number | undefined,
        timestamp,
      };
    case 'done':
      return {
        type: 'done',
        status: parsed.status as CloudTaskStatus | undefined,
        prUrl: parsed.prUrl as string | undefined,
        summary: typeof parsed.output === 'string' ? parsed.output.slice(0, 2000) : (parsed.summary as string | undefined),
        timestamp,
      };
    case 'error':
      return { type: 'error', message: (parsed.message as string) ?? data, timestamp };
    default:
      return { type: 'unknown', name, data, timestamp };
  }
}

export async function* parseSSE(response: Response): AsyncIterable<CloudEvent> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let currentData = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith(':')) continue;

        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          currentData += (currentData ? '\n' : '') + line.slice(6);
        } else if (line === '') {
          if (currentEvent || currentData) {
            yield decodeSSEFrame(currentEvent || 'output', currentData, new Date().toISOString());
            currentEvent = '';
            currentData = '';
          }
        }
      }
    }

    if (currentEvent || currentData) {
      yield decodeSSEFrame(currentEvent || 'output', currentData, new Date().toISOString());
    }
  } finally {
    reader.releaseLock();
  }
}

export async function renderStream(
  events: AsyncIterable<CloudEvent>,
  options?: { json?: boolean },
): Promise<{ status: string; summary?: string; prUrl?: string }> {
  let lastStatus: string = 'running';
  let summary: string | undefined;
  let prUrl: string | undefined;

  for await (const event of events) {
    if (options?.json) {
      process.stdout.write(JSON.stringify(event) + '\n');
      continue;
    }

    switch (event.type) {
      case 'status': {
        lastStatus = event.status;
        process.stderr.write(`${statusLabel(lastStatus)}\n`);
        break;
      }
      case 'text': {
        process.stdout.write(event.content);
        break;
      }
      case 'thinking': {
        process.stderr.write(chalk.dim(`[thinking] ${event.content}\n`));
        break;
      }
      case 'tool_use': {
        process.stderr.write(chalk.cyan(`[tool] ${event.tool}\n`));
        break;
      }
      case 'tool_result': {
        process.stderr.write(chalk.dim(`[tool_result] ${event.tool}\n`));
        break;
      }
      case 'usage': {
        const parts: string[] = [];
        if (event.model) parts.push(event.model);
        if (event.inputTokens != null) parts.push(`in=${event.inputTokens}`);
        if (event.outputTokens != null) parts.push(`out=${event.outputTokens}`);
        if (parts.length > 0) {
          process.stderr.write(chalk.dim(`[usage] ${parts.join(' ')}\n`));
        }
        break;
      }
      case 'done': {
        lastStatus = event.status ?? 'completed';
        summary = event.summary;
        prUrl = event.prUrl;
        process.stderr.write(`\n${statusLabel(lastStatus)}\n`);
        break;
      }
      case 'error': {
        process.stderr.write(chalk.red(`Error: ${event.message}\n`));
        lastStatus = 'failed';
        break;
      }
      case 'unknown': {
        process.stderr.write(chalk.dim(`[${event.name}] ${event.data}\n`));
        break;
      }
    }
  }

  return { status: lastStatus, summary, prUrl };
}

function statusLabel(status: string): string {
  switch (status) {
    case 'queued':
    case 'allocating':
      return chalk.blue(`[${status}]`);
    case 'running':
      return chalk.yellow(`[${status}]`);
    case 'idle':
      return chalk.dim('[idle]');
    case 'completed':
      return chalk.green('[completed]');
    case 'needs_review':
    case 'input_required':
      return chalk.magenta('[needs review]');
    case 'failed':
      return chalk.red('[failed]');
    case 'cancelled':
      return chalk.gray('[cancelled]');
    default:
      return chalk.dim(`[${status}]`);
  }
}
