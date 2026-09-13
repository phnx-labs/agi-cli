import chalk from 'chalk';
import { truncate } from '../format.js';
import { parseClaudeContent, parseCodexContent, sanitizeEvents, summarizeToolUse } from './parse.js';
import { linkPath, relativeToCwd } from './render.js';
import { isShellExecTool } from './shell-programs.js';
import type { SessionAgentId, SessionEvent } from './types.js';

const LINE_MAX = 120;

type StreamLineRenderer = (line: string) => string | null;

function timeOf(event: SessionEvent): string {
  const d = new Date(event.timestamp);
  if (Number.isNaN(d.getTime())) return '00:00:00';
  return d.toTimeString().slice(0, 8);
}

function paintTool(tool: string): string {
  const label = tool.padEnd(10);
  if (isShellExecTool(tool)) return chalk.yellow(label);
  if (tool === 'Edit' || tool === 'Write' || tool === 'Read') return chalk.cyan(label);
  if (tool === 'Agent') return chalk.magenta(label);
  return chalk.cyan(label);
}

function formatPath(absPath: string, cwd?: string): string {
  const label = relativeToCwd(absPath, cwd);
  return absPath.startsWith('/') ? linkPath(absPath, label) : label;
}

function splitToolSummary(tool: string, summary: string, event: SessionEvent, cwd?: string): string {
  if (event.path) return formatPath(event.path, cwd);

  const prefix = `${tool}: `;
  if (summary.startsWith(prefix)) return summary.slice(prefix.length);

  const spacedPrefix = `${tool} `;
  if (summary.startsWith(spacedPrefix)) return summary.slice(spacedPrefix.length);

  return summary === tool ? '' : summary;
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function claudeToolResultLines(raw: any): number | undefined {
  if (raw?.type !== 'user' || !Array.isArray(raw?.message?.content)) return undefined;
  const block = raw.message.content.find((b: any) => b?.type === 'tool_result');
  if (!block) return undefined;
  if (typeof block.content === 'string') return lineCount(block.content);
  if (Array.isArray(block.content)) {
    const text = block.content
      .filter((c: any) => c?.type === 'text')
      .map((c: any) => c.text || '')
      .join('\n');
    return lineCount(text);
  }
  return 0;
}

function codexToolResultLines(raw: any): number | undefined {
  if (raw?.type !== 'response_item') return undefined;
  const ptype = raw?.payload?.type;
  if (ptype !== 'function_call_output' && ptype !== 'custom_tool_call_output') return undefined;
  return lineCount(String(raw.payload.output || ''));
}

function rawToolResultLines(line: string, agent: SessionAgentId): number | undefined {
  try {
    const raw = JSON.parse(line);
    return agent === 'codex' ? codexToolResultLines(raw) : claudeToolResultLines(raw);
  } catch {
    return undefined;
  }
}

function renderEvent(event: SessionEvent, cwd: string | undefined, lastTool: string | undefined, resultLines: number | undefined): string | null {
  const prefix = chalk.dim(`${timeOf(event)}  `);

  switch (event.type) {
    case 'message': {
      const marker = event.role === 'user' ? chalk.blue('» you       ') : chalk.green(`· ${event.agent.padEnd(9)}`);
      return prefix + marker + truncate((event.content || '').replace(/\s+/g, ' ').trim(), LINE_MAX);
    }
    case 'tool_use': {
      const tool = event.tool || 'unknown';
      const summary = summarizeToolUse(tool, event.args);
      const detail = splitToolSummary(tool, summary, event, cwd);
      return prefix + chalk.yellow('→ ') + paintTool(tool) + chalk.gray(truncate(detail.replace(/\s+/g, ' ').trim(), LINE_MAX));
    }
    case 'tool_result': {
      const tool = event.tool || lastTool || 'tool';
      const count = resultLines ?? lineCount(event.output || '');
      const status = event.success === false ? chalk.red('✗ ') : chalk.green('✓ ');
      return prefix + status + paintTool(tool) + chalk.dim(`(result elided — ${plural(count, 'line')})`);
    }
    case 'error': {
      const label = event.tool ? `${event.tool}: ` : '';
      return prefix + chalk.red('✗ Error     ') + chalk.gray(truncate((label + (event.content || '')).replace(/\s+/g, ' ').trim(), LINE_MAX));
    }
    case 'thinking':
    case 'usage':
    case 'init':
    case 'result':
      return null;
    default:
      return null;
  }
}

export function makeStreamRenderer(agent: SessionAgentId, cwd?: string): StreamLineRenderer {
  const parse = agent === 'codex' ? parseCodexContent : parseClaudeContent;
  let lastTool: string | undefined;

  return (line: string): string | null => {
    const events = parse(line);
    sanitizeEvents(events);
    if (events.length === 0) return null;

    const resultLines = rawToolResultLines(line, agent);
    const rendered: string[] = [];
    for (const event of events) {
      const out = renderEvent(event, cwd, lastTool, resultLines);
      if (event.type === 'tool_use' && event.tool) lastTool = event.tool;
      if (out) rendered.push(out);
    }
    return rendered.length ? rendered.join('\n') : null;
  };
}
