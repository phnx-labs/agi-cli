/** Cursor Cloud Agents provider backed by the public v1 REST API. */

import type {
  CloudEvent,
  CloudProvider,
  CloudTask,
  CloudTaskStatus,
  DispatchOptions,
  ProviderCapabilities,
} from './types.js';
import { normalizeProviderStatus, resolveDispatchRepos } from './types.js';
import { readAndResolveBundleEnv } from '../secrets-client.js';

const CURSOR_API_BASE_URL = 'https://api.cursor.com/v1';
const KEY_NAME = 'CURSOR_API_KEY';

interface CursorAgent {
  id: string;
  name?: string;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
  updatedAt: string;
  latestRunId?: string;
  repos?: Array<{ url: string; startingRef?: string; prUrl?: string }>;
}

interface CursorRun {
  id: string;
  agentId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  result?: string;
  git?: { branches?: Array<{ repoUrl: string; branch?: string; prUrl?: string }> };
}

interface CursorErrorBody {
  error?: { code?: string; message?: string; helpUrl?: string } | string;
}

interface CursorCreateBody {
  prompt: { text: string; images?: Array<{ data: string; mimeType: string }> };
  model?: { id: string };
  repos?: Array<{ url: string; startingRef?: string }>;
  autoCreatePR?: boolean;
  envVars?: Record<string, string>;
}

/** Translate unified dispatch options into Cursor's documented v1 create shape. */
export function buildCursorCreateBody(options: DispatchOptions): CursorCreateBody {
  const repos = resolveDispatchRepos(options);
  const body: CursorCreateBody = { prompt: { text: options.prompt } };
  if (options.images?.length) {
    body.prompt.images = options.images.map(({ data, mimeType }) => ({ data, mimeType }));
  }
  if (options.model) body.model = { id: options.model };
  if (repos.length) {
    body.repos = repos.map((url) => ({ url, ...(options.branch ? { startingRef: options.branch } : {}) }));
    body.autoCreatePR = true;
  }
  if (options.env && Object.keys(options.env).length) body.envVars = options.env;
  return body;
}

/** Map one Cursor agent/run pair into the provider-neutral task shape. */
export function parseCursorTask(agent: CursorAgent, run: CursorRun, prompt = ''): CloudTask {
  const branch = run.git?.branches?.[0];
  return {
    id: agent.id,
    provider: 'cursor',
    status: normalizeProviderStatus('cursor', run.status),
    agent: 'cursor',
    prompt: prompt || agent.name || '',
    repo: agent.repos?.[0]?.url,
    repos: agent.repos?.map((repo) => repo.url),
    branch: branch?.branch,
    prUrl: branch?.prUrl,
    createdAt: agent.createdAt,
    updatedAt: run.updatedAt,
    summary: run.result,
  };
}

/** Parse one complete SSE frame into a shared cloud event. */
export function parseCursorSseFrame(frame: string): CloudEvent | undefined {
  let eventName = 'message';
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return undefined;
  const raw = data.join('\n');
  let value: unknown = raw;
  try { value = JSON.parse(raw); } catch { /* Cursor may send plain text. */ }
  const obj = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp : undefined;

  if (eventName === 'status') {
    const status = String(obj.status ?? obj.data ?? raw);
    return { type: 'status', status: normalizeProviderStatus('cursor', status), timestamp };
  }
  if (eventName === 'assistant') {
    return { type: 'text', content: String(obj.text ?? obj.content ?? obj.data ?? raw), timestamp };
  }
  if (eventName === 'thinking') {
    return { type: 'thinking', content: String(obj.text ?? obj.content ?? obj.data ?? raw), timestamp };
  }
  if (eventName === 'tool_call') {
    if (obj.status === 'completed') {
      return { type: 'tool_result', tool: String(obj.name ?? 'tool'), output: obj.result ?? obj, timestamp };
    }
    return { type: 'tool_use', tool: String(obj.name ?? 'tool'), input: obj.args ?? obj, timestamp };
  }
  if (eventName === 'result' || eventName === 'done') {
    const status = normalizeProviderStatus('cursor', String(obj.status ?? 'FINISHED'));
    return { type: 'done', status, summary: typeof obj.text === 'string' ? obj.text : undefined, timestamp };
  }
  if (eventName === 'error') {
    return { type: 'error', message: String(obj.message ?? raw), timestamp };
  }
  return { type: 'unknown', name: eventName, data: raw, timestamp };
}

/** Turn Cursor's structured API errors into actionable provider errors. */
export function cursorApiError(action: string, status: number, text: string): Error {
  let parsed: CursorErrorBody = {};
  try { parsed = JSON.parse(text) as CursorErrorBody; } catch { /* preserve raw body */ }
  const detail = typeof parsed.error === 'object' ? parsed.error : undefined;
  const code = detail?.code;
  const message = detail?.message ?? (typeof parsed.error === 'string' ? parsed.error : text.slice(0, 500));
  if (code === 'plan_required') {
    return new Error(`Cursor Cloud Agents requires a paid Cursor plan; this API key belongs to a plan without Cloud Agents access. ${message}`);
  }
  if (status === 401 || code === 'unauthorized' || code === 'api_key_not_found') {
    return new Error(`Cursor Cloud authentication failed (${status}${code ? ` ${code}` : ''}). Check CURSOR_API_KEY in the configured agents secrets bundle. ${message}`);
  }
  return new Error(`Cursor Cloud ${action} failed (${status}${code ? ` ${code}` : ''}): ${message}`);
}

export class CursorCloudProvider implements CloudProvider {
  id = 'cursor' as const;
  name = 'Cursor Cloud Agents';
  private secretsBundle?: string;

  constructor(config?: { secretsBundle?: string }) {
    this.secretsBundle = config?.secretsBundle;
  }

  private hasKeySource(): boolean {
    return Boolean(this.secretsBundle || process.env[KEY_NAME]);
  }

  private async resolveApiKey(): Promise<string> {
    if (this.secretsBundle) {
      try {
        const { env } = await readAndResolveBundleEnv(this.secretsBundle, { caller: 'cloud:cursor', agentOnly: true });
        if (env[KEY_NAME]) return env[KEY_NAME];
        throw new Error(`Secrets bundle '${this.secretsBundle}' has no ${KEY_NAME}. Add one: agents secrets add ${this.secretsBundle} ${KEY_NAME}`);
      } catch (err) {
        throw new Error(`Could not read Cursor API key from bundle '${this.secretsBundle}': ${(err as Error).message}`);
      }
    }
    if (process.env[KEY_NAME]) return process.env[KEY_NAME];
    throw new Error(`Cursor cloud needs an API key. Set cloud.providers.cursor.secretsBundle in ~/.agents/agents.yaml after running: agents secrets add cursor ${KEY_NAME}`);
  }

  capabilities(): ProviderCapabilities {
    const available = this.hasKeySource();
    return {
      available,
      dispatch: available,
      status: available,
      list: available,
      stream: available,
      cancel: available,
      message: available,
      multiRepo: true,
      skills: false,
      images: true,
    };
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const apiKey = await this.resolveApiKey();
    let response: Response;
    try {
      response = await fetch(`${CURSOR_API_BASE_URL}${path}`, {
        ...init,
        headers: {
          authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
          ...(init?.body ? { 'content-type': 'application/json' } : {}),
          ...init?.headers,
        },
      });
    } catch (err) {
      throw new Error(`Cursor Cloud request failed (network): ${(err as Error).message}`);
    }
    if (!response.ok) throw cursorApiError(init?.method ?? 'request', response.status, await response.text());
    return response;
  }

  private async latestRun(agent: CursorAgent): Promise<CursorRun> {
    if (!agent.latestRunId) throw new Error(`Cursor Cloud agent ${agent.id} has no runs.`);
    return this.request(`/agents/${encodeURIComponent(agent.id)}/runs/${encodeURIComponent(agent.latestRunId)}`)
      .then((response) => response.json() as Promise<CursorRun>);
  }

  async dispatch(options: DispatchOptions): Promise<CloudTask> {
    const response = await this.request('/agents', { method: 'POST', body: JSON.stringify(buildCursorCreateBody(options)) });
    const payload = await response.json() as { agent: CursorAgent; run: CursorRun };
    return parseCursorTask(payload.agent, payload.run, options.prompt);
  }

  async status(taskId: string): Promise<CloudTask> {
    const agent = await this.request(`/agents/${encodeURIComponent(taskId)}`).then((response) => response.json() as Promise<CursorAgent>);
    return parseCursorTask(agent, await this.latestRun(agent));
  }

  async list(filter?: { status?: CloudTaskStatus }): Promise<CloudTask[]> {
    const { items } = await this.request('/agents?limit=100').then((response) => response.json() as Promise<{ items: CursorAgent[] }>);
    const tasks = await Promise.all(items.filter((agent) => agent.latestRunId).map(async (agent) => parseCursorTask(agent, await this.latestRun(agent))));
    return filter?.status ? tasks.filter((task) => task.status === filter.status) : tasks;
  }

  async *stream(taskId: string): AsyncIterable<CloudEvent> {
    const agent = await this.request(`/agents/${encodeURIComponent(taskId)}`).then((response) => response.json() as Promise<CursorAgent>);
    if (!agent.latestRunId) throw new Error(`Cursor Cloud agent ${taskId} has no run to stream.`);
    const response = await this.request(`/agents/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(agent.latestRunId)}/stream`, {
      headers: { accept: 'text/event-stream' },
    });
    if (!response.body) throw new Error(`Cursor Cloud stream for ${taskId} returned no response body.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const event = parseCursorSseFrame(frame);
        if (event) yield event;
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const event = parseCursorSseFrame(buffer);
      if (event) yield event;
    }
  }

  async cancel(taskId: string): Promise<void> {
    const agent = await this.request(`/agents/${encodeURIComponent(taskId)}`).then((response) => response.json() as Promise<CursorAgent>);
    if (!agent.latestRunId) throw new Error(`Cursor Cloud agent ${taskId} has no run to cancel.`);
    await this.request(`/agents/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(agent.latestRunId)}/cancel`, { method: 'POST' });
  }

  async message(taskId: string, content: string): Promise<void> {
    await this.request(`/agents/${encodeURIComponent(taskId)}/runs`, {
      method: 'POST',
      body: JSON.stringify({ prompt: { text: content } }),
    });
  }
}
