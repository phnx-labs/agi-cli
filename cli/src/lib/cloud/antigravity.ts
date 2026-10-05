/** Antigravity cloud provider via the Gemini Managed Agents Interactions API (POST
 * /v1beta/interactions). Synchronous: dispatch() awaits a terminal CloudTask; stream() replays
 * buffered events. Key comes from `cloud.providers.antigravity.secretsBundle`, never agents.yaml. */

import type {
  CloudProvider,
  CloudTask,
  CloudTaskStatus,
  CloudEvent,
  DispatchOptions,
  ProviderCapabilities,
} from './types.js';
import { resolveDispatchRepos, normalizeProviderStatus } from './types.js';
import { readAndResolveBundleEnv } from '../secrets-client.js';

const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const DEFAULT_MODEL = 'antigravity-preview-05-2026';
const KEY_NAMES = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] as const;

interface InteractionResponse {
  id?: string;
  interaction_id?: string;
  environment_id?: string;
  status?: string;
  output_text?: string;
  error?: { message?: string } | string;
}

export function buildInteractionBody(prompt: string, model: string): Record<string, unknown> {
  return {
    agent: model,
    input: prompt,
    environment: 'remote',
  };
}

export function parseInteraction(resp: InteractionResponse): { id: string; status: CloudTaskStatus; summary?: string; environmentId?: string } {
  const id = resp.id ?? resp.interaction_id ?? `antigravity-${Date.now()}`;
  return {
    id,
    status: normalizeProviderStatus('antigravity', resp.status),
    summary: resp.output_text,
    environmentId: resp.environment_id,
  };
}

interface BufferedRun {
  events: CloudEvent[];
  task: CloudTask;
}

export class AntigravityCloudProvider implements CloudProvider {
  id = 'antigravity' as const;
  name = 'Antigravity (Gemini)';

  private secretsBundle?: string;
  private model: string;
  private runs = new Map<string, BufferedRun>();

  constructor(config?: { secretsBundle?: string; model?: string }) {
    this.secretsBundle = config?.secretsBundle;
    this.model = config?.model ?? DEFAULT_MODEL;
  }

  /** True when a key source is configured. Cheap: never resolves the bundle (may prompt biometry). */
  private hasKeySource(): boolean {
    if (this.secretsBundle) return true;
    return KEY_NAMES.some((k) => Boolean(process.env[k]));
  }

  private async resolveApiKey(): Promise<string> {
    if (this.secretsBundle) {
      try {
        // Cloud dispatch reads the key `agentOnly` (SEC-13: never pop Touch ID). A locked bundle
        // throws the unlock message, re-raised verbatim so dispatch fails loud.
        const { env } = await readAndResolveBundleEnv(this.secretsBundle, { caller: 'cloud:antigravity', agentOnly: true });
        for (const k of KEY_NAMES) {
          if (env[k]) return env[k];
        }
        throw new Error(
          `Secrets bundle '${this.secretsBundle}' has no ${KEY_NAMES.join(' or ')}. Add one: agents secrets add ${this.secretsBundle} GEMINI_API_KEY`,
        );
      } catch (err) {
        throw new Error(`Could not read Gemini API key from bundle '${this.secretsBundle}': ${(err as Error).message}`);
      }
    }
    for (const k of KEY_NAMES) {
      const v = process.env[k];
      if (v) return v;
    }
    throw new Error(
      `Antigravity cloud needs a Gemini API key. Set cloud.providers.antigravity.secretsBundle in ~/.agents/agents.yaml, or export ${KEY_NAMES.join(' / ')}.`,
    );
  }

  capabilities(): ProviderCapabilities {
    const available = this.hasKeySource();
    return {
      available,
      dispatch: available,
      status: available,
      list: available,
      stream: available,
      cancel: false,
      message: false,
      multiRepo: false,
      skills: false,
      images: false,
    };
  }

  async dispatch(options: DispatchOptions): Promise<CloudTask> {
    const repos = resolveDispatchRepos(options);
    if (repos.length > 0) {
      throw new Error(
        `Antigravity cloud is a raw sandbox with no GitHub repo → PR flow. Got repo(s): ${repos.join(', ')}. ` +
          `Use --provider rush for repo-backed dispatch.`,
      );
    }

    const apiKey = await this.resolveApiKey();
    const model = (options.model as string | undefined) ?? this.model;
    const body = buildInteractionBody(options.prompt, model);

    let resp: Response;
    try {
      resp = await fetch(INTERACTIONS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`Antigravity dispatch failed (network): ${(err as Error).message}`);
    }

    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`Antigravity dispatch failed (${resp.status}): ${text.slice(0, 500)}`);
    }

    let parsed: InteractionResponse;
    try {
      parsed = JSON.parse(text) as InteractionResponse;
    } catch {
      throw new Error(`Antigravity returned non-JSON response: ${text.slice(0, 300)}`);
    }

    const { id, status, summary } = parseInteraction(parsed);
    const now = new Date().toISOString();
    const task: CloudTask = {
      id,
      provider: 'antigravity',
      status,
      agent: 'antigravity',
      prompt: options.prompt,
      summary,
      createdAt: now,
      updatedAt: now,
    };

    const events: CloudEvent[] = [];
    if (summary) events.push({ type: 'text', content: summary, timestamp: now });
    events.push({ type: 'done', status, summary, timestamp: now });
    this.runs.set(id, { events, task });

    return task;
  }

  async status(taskId: string): Promise<CloudTask> {
    const run = this.runs.get(taskId);
    if (run) return run.task;
    throw new Error(`No live status for Antigravity task ${taskId} (synchronous interaction; see local cache).`);
  }

  async list(): Promise<CloudTask[]> {
    return [...this.runs.values()].map((r) => r.task);
  }

  async *stream(taskId: string): AsyncIterable<CloudEvent> {
    const run = this.runs.get(taskId);
    if (!run) {
      yield {
        type: 'error',
        message: `Antigravity interaction ${taskId} is not buffered in this process. The interaction is synchronous — see 'agents cloud status ${taskId}' for the result.`,
        timestamp: new Date().toISOString(),
      };
      return;
    }
    for (const event of run.events) yield event;
  }

  async cancel(_taskId: string): Promise<void> {
    throw new Error('Cancel is not supported for Antigravity — interactions run synchronously to completion.');
  }

  async message(_taskId: string, _content: string): Promise<void> {
    throw new Error('Follow-up messages are not yet supported for Antigravity cloud tasks.');
  }
}
