
import type { TodoProgress } from '@phnx-labs/sessions-cli/reader';

const ANTHROPIC_VERSION = '2023-06-01';

interface SummarizeProgress {
  todos?: TodoProgress;
  plan?: string;
  phase?: string;
  steps?: string[];
}

interface SummarizeResult {
  goal: string;
  checkpoints: string[];
  checklist: { text: string; done: boolean }[];
}

interface SummarizeOptions {
  baseUrl: string;
  model: string;
  maxTokens?: number;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

const SYSTEM_PROMPT = [
  'You summarize a coding-agent session for an operator dashboard.',
  'Reply with ONLY a single JSON object, no prose and no code fences, of exactly this shape:',
  '{"goal": string, "checkpoints": string[], "checklist": [{"text": string, "done": boolean}]}',
  '- goal: 1-2 lines capturing what the user actually asked for, in plain language.',
  '- checkpoints: short lines of concrete progress so far, newest last; [] if none yet.',
  '- checklist: the detailed steps to finish the goal, each with a done flag; [] if unknown.',
  'Do not invent progress that is not evidenced by the provided context.',
].join('\n');

export function buildSummarizeUserMessage(prompt: string, progress: SummarizeProgress): string {
  const parts: string[] = [`USER REQUEST:\n${prompt.trim()}`];
  if (progress.phase) parts.push(`PHASE: ${progress.phase}`);
  if (progress.todos && progress.todos.items.length > 0) {
    const lines = progress.todos.items.map((t) => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}`);
    parts.push(`CURRENT CHECKLIST (${progress.todos.done}/${progress.todos.total} done):\n${lines.join('\n')}`);
  }
  if (progress.plan) parts.push(`PLAN:\n${progress.plan.trim().slice(0, 4000)}`);
  if (progress.steps?.length) {
    parts.push(`WHAT THE AGENT SAID IT WAS DOING (oldest first):\n${progress.steps.map((step) => `- ${step}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

export function validateSummarizeResult(parsed: unknown): SummarizeResult | undefined {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.goal !== 'string' || obj.goal.trim().length === 0) return undefined;
  const checkpoints = Array.isArray(obj.checkpoints)
    ? obj.checkpoints.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim())
    : [];
  const checklist = Array.isArray(obj.checklist)
    ? obj.checklist
        .filter((c): c is { text: unknown; done: unknown } => Boolean(c) && typeof c === 'object' && !Array.isArray(c))
        .map((c) => ({ text: typeof (c as any).text === 'string' ? (c as any).text.trim() : '', done: Boolean((c as any).done) }))
        .filter((c) => c.text.length > 0)
    : [];
  return { goal: obj.goal.trim(), checkpoints, checklist };
}

function textFromBody(body: unknown): string {
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type?: string; text?: string } => Boolean(b) && typeof b === 'object')
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

export function extractJsonObject(text: string): string | undefined {
  const unfenced = text.replace(/```(?:json)?/gi, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return undefined;
  return unfenced.slice(start, end + 1);
}

export async function summarize(
  prompt: string,
  progress: SummarizeProgress,
  opts: SummarizeOptions,
): Promise<SummarizeResult | undefined> {
  if (!prompt.trim()) return undefined;
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  // Never send ambient Anthropic credentials to an operator-configured compatible endpoint.
  const apiKey = opts.apiKey ?? process.env.AGENTS_SUMMARIZER_API_KEY ?? '';
  try {
    const res = await doFetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 512,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildSummarizeUserMessage(prompt, progress) }],
      }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) return undefined;
    const body = await res.json();
    const text = textFromBody(body);
    const json = extractJsonObject(text);
    if (!json) return undefined;
    return validateSummarizeResult(JSON.parse(json));
  } catch {
    return undefined;
  }
}
