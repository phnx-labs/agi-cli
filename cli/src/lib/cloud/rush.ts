import type { SessionAgentId, SessionEvent } from '@phnx-labs/sessions-cli/reader';
import type {
  CloudProvider,
  CloudTask,
  CloudTaskStatus,
  CloudEvent,
  DispatchOptions,
  ProviderCapabilities,
  ImageAttachment,
} from './types.js';
import { resolveDispatchRepos, normalizeProviderStatus, MAX_IMAGES_PER_DISPATCH } from './types.js';
import { parseSSE } from './stream.js';
import { getTaskById } from './store.js';
import { RUSH_API_BASE } from '../rush-api.js';
import { readAndResolveBundleEnv } from '../secrets-client.js';

const KEY_NAME = 'RUSH_API_KEY';
const ORG_NAME = 'RUSH_ORG';
const SETUP_HINT =
  `Create an API key on the Developers page of https://cloud.getrush.ai, store it with ` +
  `\`secrets add getrush.ai ${KEY_NAME}\` and your org with \`secrets add getrush.ai ${ORG_NAME} --value <org>\`, ` +
  `then set cloud.providers.rush.secretsBundle: getrush.ai in ~/.agents/agents.yaml ` +
  `(or run under \`secrets exec getrush.ai --\`).`;

interface RushCredential {
  apiKey: string;
  org: string;
}

interface RushSession {
  execution_id: string;
  status: string;
  harness?: string;
  result?: string;
  error?: { code: string; message: string };
  repo_owner?: string;
  repo_name?: string;
  branch?: string;
  pr_url?: string;
  created_at: string;
  completed_at?: string;
}

type RushTranscriptEvent = Omit<SessionEvent, 'agent' | 'timestamp' | 'callId'> & { call_id?: string };

function credentialFrom(env: Record<string, string | undefined>, source: string): RushCredential {
  const apiKey = env[KEY_NAME];
  const org = env[ORG_NAME];
  if (!apiKey || !org) {
    const missing = [!apiKey && KEY_NAME, !org && ORG_NAME].filter(Boolean).join(' and ');
    throw new Error(`Rush Cloud needs ${missing} (${source} has none). ${SETUP_HINT}`);
  }
  return { apiKey, org };
}

export function buildSessionCreateBody(options: DispatchOptions): Record<string, unknown> {
  const repos = resolveDispatchRepos(options);
  if (repos.length > 1) {
    throw new Error(`Rush Cloud runs one repository per session; got ${repos.length} (${repos.join(', ')}). Dispatch one per repository.`);
  }
  if (options.providerOptions?.mode !== undefined) {
    throw new Error('Rush Cloud has no execution mode; drop --mode and say what you want in the prompt.');
  }
  const body: Record<string, unknown> = {
    agent: options.agent ?? 'claude',
    input: buildInput(options.prompt, options.images),
  };
  if (options.model) body.model = options.model;
  if (options.skills && options.skills.length > 0) body.skills = options.skills;
  if (repos.length === 1) body.resources = [{ url: repoResourceUrl(repos[0], options.branch) }];
  return body;
}

function buildInput(prompt: string, images?: ImageAttachment[] | null): unknown {
  if (!images || images.length === 0) return prompt;
  return [
    { type: 'text', text: prompt },
    ...images.slice(0, MAX_IMAGES_PER_DISPATCH).map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.data },
    })),
  ];
}

function repoResourceUrl(full: string, branch?: string): string {
  const parts = full.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo format: ${JSON.stringify(full)}. Use owner/repo.`);
  }
  const base = `https://github.com/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
  return branch ? `${base}/tree/${branch}` : base;
}

function sessionToTask(s: RushSession): CloudTask {
  return {
    id: s.execution_id,
    provider: 'rush',
    status: normalizeProviderStatus('rush', s.status),
    agent: s.harness,
    prompt: getTaskById(s.execution_id)?.prompt ?? '',
    repo: s.repo_owner && s.repo_name ? `${s.repo_owner}/${s.repo_name}` : undefined,
    branch: s.branch,
    prUrl: s.pr_url,
    summary: s.result ?? s.error?.message,
    createdAt: s.created_at,
    updatedAt: s.completed_at ?? s.created_at,
  };
}

async function rushApiError(action: string, res: Response): Promise<Error> {
  const text = await res.text();
  let detail: string;
  try {
    const body = JSON.parse(text) as { error?: string; message?: string; code?: string; error_code?: string };
    const code = body.code ?? body.error_code;
    detail = `${code ? `${code}: ` : ''}${body.error ?? body.message ?? ''}`;
  } catch {
    detail = text.slice(0, 300).replace(/rk_live_[A-Za-z0-9_-]+/g, '[REDACTED]');
  }
  const hint = res.status === 401 ? ` Check ${KEY_NAME}: it may be revoked or expired.` : '';
  return new Error(`Rush Cloud ${action} failed (${res.status}) ${detail}.${hint}`);
}

export class RushCloudProvider implements CloudProvider {
  id = 'rush' as const;
  name = 'Rush Cloud';
  private secretsBundle?: string;

  constructor(config?: { secretsBundle?: string }) {
    this.secretsBundle = config?.secretsBundle;
  }

  private async credential(): Promise<RushCredential> {
    if (!this.secretsBundle) return credentialFrom(process.env, 'the environment');
    let env: Record<string, string>;
    try {
      ({ env } = await readAndResolveBundleEnv(this.secretsBundle, { caller: 'cloud:rush', agentOnly: true }));
    } catch (err) {
      throw new Error(`Could not read Rush Cloud credentials from bundle '${this.secretsBundle}': ${(err as Error).message}`);
    }
    return credentialFrom(env, `bundle '${this.secretsBundle}'`);
  }

  private async request(action: string, path: string, init: RequestInit = {}): Promise<Response> {
    const { apiKey, org } = await this.credential();
    let res: Response;
    try {
      res = await fetch(`${RUSH_API_BASE}/o/${encodeURIComponent(org)}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    } catch (err) {
      throw new Error(`Rush Cloud ${action} failed (network): ${(err as Error).message}`);
    }
    if (!res.ok) throw await rushApiError(action, res);
    return res;
  }

  capabilities(): ProviderCapabilities {
    return {
      available: Boolean(this.secretsBundle || process.env[KEY_NAME]),
      dispatch: true,
      status: true,
      list: true,
      stream: true,
      cancel: true,
      message: true,
      multiRepo: false,
      skills: true,
      images: true,
    };
  }

  async dispatch(options: DispatchOptions): Promise<CloudTask> {
    const body = buildSessionCreateBody(options);
    const repos = resolveDispatchRepos(options);

    const { runPreflightGate } = await import('../budget/preflight.js');
    const projectKey = repos[0] ?? process.cwd();
    const gate = runPreflightGate({
      agent: options.agent ?? 'cloud',
      model: options.model ?? `${options.agent ?? 'cloud'}-default`,
      prompt: options.prompt,
      project: projectKey,
    });
    if (!gate.dormant && !gate.decision.allow) {
      throw new Error(`[budget] BLOCKED cloud dispatch (${projectKey}): ${gate.decision.reason}`);
    }

    if (options.env && Object.keys(options.env).length > 0) {
      process.stderr.write(
        `Rush Cloud takes no per-run environment; not sending ${Object.keys(options.env).join(', ')}. ` +
          `Save it as a Project secret instead (POST /o/{org}/secrets).\n`,
      );
    }

    const res = await this.request('dispatch', '/sessions', { method: 'POST', body: JSON.stringify(body) });
    const session = (await res.json()) as RushSession;
    return {
      ...sessionToTask(session),
      agent: session.harness ?? (body.agent as string),
      prompt: options.prompt,
      repo: repos[0],
      repos: repos.length > 0 ? repos : undefined,
      branch: options.branch,
    };
  }

  async status(taskId: string): Promise<CloudTask> {
    const res = await this.request('status', `/sessions/${encodeURIComponent(taskId)}`);
    return sessionToTask((await res.json()) as RushSession);
  }

  async list(filter?: { status?: CloudTaskStatus }): Promise<CloudTask[]> {
    const res = await this.request('list', '/sessions?limit=100');
    const data = (await res.json()) as { sessions?: RushSession[] };
    const tasks = (data.sessions ?? []).map(sessionToTask);
    return filter?.status ? tasks.filter((t) => t.status === filter.status) : tasks;
  }

  async *stream(taskId: string): AsyncIterable<CloudEvent> {
    const res = await this.request('stream', `/sessions/${encodeURIComponent(taskId)}/events`, {
      headers: { Accept: 'text/event-stream' },
    });
    yield* parseSSE(res);
  }

  async cancel(taskId: string): Promise<void> {
    await this.request('cancel', `/sessions/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' });
  }

  async message(taskId: string, content: string): Promise<void> {
    await this.request('message', `/sessions/${encodeURIComponent(taskId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ input: content }),
    });
  }

  async transcript(task: Pick<CloudTask, 'id' | 'createdAt'>, agent: SessionAgentId): Promise<SessionEvent[]> {
    const res = await this.request('transcript', `/sessions/${encodeURIComponent(task.id)}/messages`);
    const data = (await res.json()) as { events?: RushTranscriptEvent[] };
    return (data.events ?? []).map(({ call_id, ...e }) => ({
      ...e,
      ...(call_id ? { callId: call_id } : {}),
      agent,
      timestamp: task.createdAt,
    }));
  }
}
