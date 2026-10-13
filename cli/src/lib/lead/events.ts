export type LeadEngine = 'warm' | 'cold';
export type LeadStatusState = 'booting' | 'thinking' | 'tool' | 'answering';

export interface LeadTicketRef { kind: 'ticket'; id: string; url?: string; title?: string }
export interface LeadPrRef { kind: 'pr'; repo: string; number: number; url: string }
export interface LeadSessionRef { kind: 'session'; id: string; title: string; host?: string }
export type LeadRef = LeadTicketRef | LeadPrRef | LeadSessionRef;

export interface LeadTiming { boot: number; model: number; tools: number }

export type LeadEvent =
  | { type: 'turn'; turn: string; project: string; session: string; engine: LeadEngine }
  | { type: 'status'; state: LeadStatusState }
  | { type: 'tool'; id: string; label: string; cmd: string; state: 'run' }
  | { type: 'tool'; id: string; label: string; state: 'ok' | 'fail'; secs: number }
  | { type: 'text'; delta: string }
  | { type: 'confirm'; token: string; action: 'stop'; sessionId: string; label: string }
  | { type: 'done'; turn: string; text: string; summary: string; refs: LeadRef[]; timing: LeadTiming }
  | { type: 'error'; message: string };

export interface ContextUsage { tokens: number; window: number }

export interface TurnResult {
  text: string;
  isError: boolean;
  usage: ContextUsage | null;
  sessionId?: string;
}

export interface StopIntent { toolId: string; sessionRef: string }

export type ParsedItem =
  | { kind: 'event'; event: LeadEvent }
  | { kind: 'stop'; intent: StopIntent }
  | { kind: 'init'; sessionId: string }
  | { kind: 'result'; result: TurnResult };

export const ROTATE_AT_FRACTION = 0.6;

const STOP_RE = /\bagents\s+ps\s+stop\s+([A-Za-z0-9][A-Za-z0-9-]*)/;
const LABEL_TWO_WORD = new Set(['agents', 'linear', 'artifacts', 'gh', 'git']);

export function toolLabel(command: string): string {
  const words = command.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  if (words.length === 0) return 'Bash';
  if (LABEL_TWO_WORD.has(words[0]) && words[1] && !words[1].startsWith('-')) return `${words[0]} ${words[1]}`;
  return words[0];
}

export function stopTarget(command: string): string | undefined {
  return STOP_RE.exec(command)?.[1];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function mergedSeconds(spans: Array<[number, number]>): number {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [s, e] of sorted) {
    if (s > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total / 1000;
}

type Usage = Record<string, unknown>;

function usageTokens(u: Usage): number {
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  return n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens') + n('output_tokens');
}

export function contextUsageFromResult(result: Record<string, unknown>): ContextUsage | null {
  const usage = result.usage as Usage | undefined;
  const modelUsage = result.modelUsage as Record<string, { contextWindow?: number }> | undefined;
  if (!usage || !modelUsage) return null;
  const windows = Object.values(modelUsage).map((m) => m.contextWindow).filter((w): w is number => typeof w === 'number' && w > 0);
  if (windows.length === 0) return null;
  const iterations = Array.isArray(usage.iterations) ? (usage.iterations as Usage[]) : [];
  const last = iterations.length > 0 ? iterations[iterations.length - 1] : usage;
  return { tokens: usageTokens(last), window: Math.max(...windows) };
}

export function shouldRotate(usage: ContextUsage | null, threshold = ROTATE_AT_FRACTION): boolean {
  if (!usage) return false;
  return usage.tokens / usage.window >= threshold;
}

export function summarize(text: string, max = 80): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.|#+)\s+/, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const match = /^.*?[.!?](?=\s|$)/.exec(plain);
  const sentence = (match ? match[0] : plain).trim();
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '')}…`;
}

interface ToolSpan { label: string; startMs: number }

export class LeadTurnParser {
  private status: LeadStatusState | null = null;
  private readonly tools = new Map<string, ToolSpan>();
  private readonly held = new Set<string>();
  private readonly spans: Array<[number, number]> = [];
  private streamedText = false;

  feed(msg: Record<string, unknown>, nowMs: number): ParsedItem[] {
    const out: ParsedItem[] = [];
    const type = msg.type;
    if (type === 'system' && msg.subtype === 'init' && typeof msg.session_id === 'string') {
      out.push({ kind: 'init', sessionId: msg.session_id });
    } else if (type === 'stream_event') {
      this.onStreamEvent(msg.event as Record<string, unknown> | undefined, out);
    } else if (type === 'assistant') {
      this.onAssistant(msg, nowMs, out);
    } else if (type === 'user') {
      this.onUser(msg, nowMs, out);
    } else if (type === 'result') {
      out.push({
        kind: 'result',
        result: {
          text: typeof msg.result === 'string' ? msg.result : '',
          isError: msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype !== 'success'),
          usage: contextUsageFromResult(msg),
          sessionId: typeof msg.session_id === 'string' ? msg.session_id : undefined,
        },
      });
    }
    return out;
  }

  toolSeconds(): number {
    return round2(mergedSeconds(this.spans));
  }

  private setStatus(state: LeadStatusState, out: ParsedItem[]): void {
    if (this.status === state) return;
    this.status = state;
    out.push({ kind: 'event', event: { type: 'status', state } });
  }

  private onStreamEvent(event: Record<string, unknown> | undefined, out: ParsedItem[]): void {
    if (!event) return;
    if (event.type === 'message_start') {
      this.setStatus('thinking', out);
      return;
    }
    if (event.type === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
        this.setStatus('answering', out);
        this.streamedText = true;
        out.push({ kind: 'event', event: { type: 'text', delta: delta.text } });
      }
    }
  }

  private onAssistant(msg: Record<string, unknown>, nowMs: number, out: ParsedItem[]): void {
    const content = (msg.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0 && !this.streamedText) {
        this.setStatus('answering', out);
        out.push({ kind: 'event', event: { type: 'text', delta: block.text } });
      } else if (block.type === 'tool_use' && typeof block.id === 'string') {
        const input = (block.input ?? {}) as Record<string, unknown>;
        const cmd = typeof input.command === 'string' ? input.command : String(block.name ?? 'tool');
        const target = block.name === 'Bash' ? stopTarget(cmd) : undefined;
        if (target) {
          this.held.add(block.id);
          out.push({ kind: 'stop', intent: { toolId: block.id, sessionRef: target } });
          continue;
        }
        const label = block.name === 'Bash' ? toolLabel(cmd) : String(block.name ?? 'tool');
        this.tools.set(block.id, { label, startMs: nowMs });
        this.setStatus('tool', out);
        out.push({ kind: 'event', event: { type: 'tool', id: block.id, label, cmd, state: 'run' } });
      }
    }
    this.streamedText = false;
  }

  private onUser(msg: Record<string, unknown>, nowMs: number, out: ParsedItem[]): void {
    const content = (msg.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      if (this.held.has(block.tool_use_id)) continue;
      const span = this.tools.get(block.tool_use_id);
      if (!span) continue;
      this.tools.delete(block.tool_use_id);
      this.spans.push([span.startMs, nowMs]);
      out.push({
        kind: 'event',
        event: {
          type: 'tool',
          id: block.tool_use_id,
          label: span.label,
          state: block.is_error === true ? 'fail' : 'ok',
          secs: round2((nowMs - span.startMs) / 1000),
        },
      });
    }
  }
}
