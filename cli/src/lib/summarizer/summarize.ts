/**
 * The one model call behind the session summarizer (PHNX-3939).
 *
 * A pure boundary: given the session's first user turn (the goal source) and its
 * live progress (todos / plan / phase off the state engine), it asks a local
 * Anthropic-wire endpoint (Ollama / vLLM / LiteLLM) for a strict JSON
 * `{goal, checkpoints, checklist}`
 * and validates the shape. On ANY failure — network, non-2xx, non-JSON, wrong
 * shape — it returns `undefined`, and the caller records `summaryState: 'skipped'`.
 *
 * NEVER called on the request path: only the background SessionSummarizerService
 * invokes it, debounced and reader-gated.
 */

import type { TodoProgress } from '../session/types.js';

/**
 * The `anthropic-version` header this request sends. Declared here because this
 * is now its only caller: it used to be imported from the computer subsystem's
 * model client, which left with the standalone `computer` engine (PHNX-4075).
 * A shared constants module for one string used in one request would be more
 * indirection than the string.
 */
const ANTHROPIC_VERSION = '2023-06-01';

/** Live progress fed to the model alongside the goal-bearing prompt. */
export interface SummarizeProgress {
  /** Latest checklist write (TodoWrite / update_plan), when the session has one. */
  todos?: TodoProgress;
  /** Plan markdown from the last ExitPlanMode, when present. */
  plan?: string;
  /** Coarse lifecycle phase (running / waiting / idle / …), when known. */
  phase?: string;
  /**
   * The agent's own narration headlines, oldest first — the last K steps the
   * daemon's timeline fold produced (PHNX-3939). Optional: many sessions never
   * write a checklist, so this is often the only evidence of progress the model
   * gets, but a row with no folded timeline simply passes none.
   */
  steps?: string[];
}

/** The validated model output. `at` timestamps are stamped by the caller. */
export interface SummarizeResult {
  goal: string;
  /** Progress checkpoints, newest last (short lines). */
  checkpoints: string[];
  /** Detailed checklist. */
  checklist: { text: string; done: boolean }[];
}

export interface SummarizeOptions {
  baseUrl: string;
  model: string;
  maxTokens?: number;
  /**
   * API key for the endpoint. Deliberately NOT resolved from `ANTHROPIC_API_KEY`:
   * the summarizer targets an operator-configured local/remote endpoint
   * (Ollama/vLLM/LiteLLM) that typically ignores the key, so forwarding the real
   * Anthropic credential there would leak it. Only an explicit
   * `AGENTS_SUMMARIZER_API_KEY` (or this option) is ever sent; otherwise the
   * header is empty.
   */
  apiKey?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Abort the request when the daemon tick's deadline elapses. */
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

/** Compose the user message from the goal-bearing prompt and the live progress. */
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

/**
 * Coerce an untrusted parsed object into a {@link SummarizeResult}, or undefined
 * when the shape is wrong. Extra/missing optional arrays degrade to `[]` rather
 * than failing, but a non-string goal is a hard reject — a summary with no goal
 * is not a summary.
 */
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

/** Extract the assistant text from an Anthropic Messages response body. */
function textFromBody(body: unknown): string {
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type?: string; text?: string } => Boolean(b) && typeof b === 'object')
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

/** Strip ``` fences and pull the first {...} block so a chatty model still parses. */
export function extractJsonObject(text: string): string | undefined {
  const unfenced = text.replace(/```(?:json)?/gi, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return undefined;
  return unfenced.slice(start, end + 1);
}

/**
 * Run one summarization. Returns the validated result, or `undefined` on any
 * failure (the caller then marks the session `summaryState: 'skipped'`).
 */
export async function summarize(
  prompt: string,
  progress: SummarizeProgress,
  opts: SummarizeOptions,
): Promise<SummarizeResult | undefined> {
  if (!prompt.trim()) return undefined;
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  // Only an explicit summarizer key is ever forwarded — never the ambient
  // ANTHROPIC_API_KEY, which would leak to the operator's local endpoint.
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
