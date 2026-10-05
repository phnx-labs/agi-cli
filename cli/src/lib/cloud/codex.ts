/** Codex Cloud provider wrapping `codex cloud exec/status/list` into CloudTask. Streaming is
 * emulated by polling (no SSE endpoint). */

import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
  CloudProvider,
  CloudTask,
  CloudTaskStatus,
  CloudEvent,
  DispatchOptions,
  ProviderCapabilities,
} from './types.js';
import { resolveDispatchRepos, normalizeProviderStatus, MissingTargetError } from './types.js';
import { getShimsDir } from '../state.js';

const SHIMS_DIR = getShimsDir();

function findCodexBinary(): string | null {
  const shim = path.join(SHIMS_DIR, 'codex');
  if (fs.existsSync(shim)) return shim;

  try {
    return execFileSync('which', ['codex'], { stdio: 'pipe' }).toString().trim() || null;
  } catch {
    return null;
  }
}

function codexAvailable(): boolean {
  return findCodexBinary() !== null;
}

function runCodex(args: string[], env?: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  const bin = findCodexBinary();
  if (!bin) return Promise.resolve({ stdout: '', stderr: 'codex not found', code: 127 });

  return new Promise((resolve) => {
    const proc = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

function parseTaskFromText(text: string): Partial<CloudTask> {
  try {
    return JSON.parse(text);
  } catch {
    const result: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*(\w[\w\s]*\w)\s*[:=]\s*(.+)\s*$/);
      if (match) {
        result[match[1].toLowerCase().replace(/\s+/g, '_')] = match[2].trim();
      }
    }
    return {
      id: result.id || result.task_id,
      status: result.status ? normalizeProviderStatus('codex', result.status) : undefined,
      summary: result.summary || result.output,
    };
  }
}

export class CodexCloudProvider implements CloudProvider {
  id = 'codex' as const;
  name = 'Codex Cloud';
  targetKind = 'env' as const;

  private defaultEnv?: string;

  constructor(config?: { env?: string }) {
    this.defaultEnv = config?.env;
  }

  capabilities(): ProviderCapabilities {
    const available = codexAvailable();
    return {
      available,
      dispatch: available,
      status: available,
      list: available,
      stream: available,
      cancel: false,
      message: false,
      multiRepo: false,
      // `codex cloud exec --env <id> <prompt>` is the only dispatch surface: no image or skill
      // attachment. Both stay false until upstream adds one.
      skills: false,
      images: false,
    };
  }

  async dispatch(options: DispatchOptions): Promise<CloudTask> {
    const env = (options.providerOptions?.env as string | undefined) ?? this.defaultEnv;
    if (!env) {
      throw new MissingTargetError(
        'env',
        'Codex Cloud requires --env <id>.',
        'Codex environments are created in the Codex web UI and bundle a repo + setup. ' +
          'Browse yours with `codex cloud` (interactive), then re-run with --env <id> ' +
          'or set a default in ~/.agents/agents.yaml under cloud.providers.codex.env.',
      );
    }

    // Codex envs fix their repo list at creation, so 2+ repos is almost always a misconfiguration.
    // Fail loudly rather than ignore the extras.
    const repos = resolveDispatchRepos(options);
    if (repos.length > 1) {
      throw new Error(
        `Codex Cloud does not support multi-repo dispatch. Got ${repos.length} repos (${repos.join(', ')}). ` +
          `Codex envs bundle repos at the env layer — either configure a Codex env that includes all of these repos, ` +
          `or switch to --provider rush (which clones each repo into /workspace/<owner>/<name>/).`,
      );
    }

    const args = ['cloud', 'exec', '--env', env];
    if (options.branch) args.push('--branch', options.branch);
    args.push(options.prompt);

    const { stdout, stderr, code } = await runCodex(args, options.env);
    if (code !== 0) {
      throw new Error(`codex cloud exec failed: ${stderr || stdout}`);
    }

    // The task id is the only handle to the execution (status, list, reconcile); Codex prints it
    // to stdout or stderr, so scan both. Never persist a synthetic `codex-<ts>` id (can't match);
    // fail loudly and point at `agents cloud list`.
    const taskId = extractTaskId(stdout) ?? extractTaskId(stderr);
    // Persist only the execution id returned by Codex; a fabricated fallback cannot be resumed or queried.
    if (!taskId) {
      throw new Error(
        'codex cloud exec did not report a task id — the run may have dispatched, but ' +
          'without the id it cannot be tracked. Find it with `agents cloud list --provider codex`, ' +
          `then \`agents cloud status <id>\`.\nRaw output: ${(stdout || stderr).trim().slice(0, 400)}`,
      );
    }
    const now = new Date().toISOString();

    return {
      id: taskId,
      provider: 'codex',
      status: 'queued',
      agent: 'codex',
      prompt: options.prompt,
      repo: repos[0],
      repos: repos.length > 0 ? repos : undefined,
      branch: options.branch,
      createdAt: now,
      updatedAt: now,
    };
  }

  async status(taskId: string): Promise<CloudTask> {
    const { stdout, stderr, code } = await runCodex(['cloud', 'status', taskId]);
    if (code !== 0) {
      throw new Error(`codex cloud status failed: ${stderr || stdout}`);
    }

    const parsed = parseTaskFromText(stdout);
    const now = new Date().toISOString();

    return {
      id: taskId,
      provider: 'codex',
      status: parsed.status ?? 'running',
      agent: 'codex',
      prompt: parsed.prompt ?? '',
      summary: parsed.summary,
      createdAt: parsed.createdAt ?? now,
      updatedAt: now,
    };
  }

  async list(filter?: { status?: CloudTaskStatus }): Promise<CloudTask[]> {
    const args = ['cloud', 'list', '--json', '--limit', '20'];
    if (this.defaultEnv) args.push('--env', this.defaultEnv);

    const { stdout, stderr, code } = await runCodex(args);
    if (code !== 0) {
      throw new Error(`codex cloud list failed: ${stderr || stdout}`);
    }

    try {
      const data = JSON.parse(stdout);
      const tasks: CloudTask[] = (data.tasks ?? data ?? []).map((t: Record<string, unknown>) => ({
        id: (t.id || t.task_id) as string,
        provider: 'codex' as const,
        status: normalizeProviderStatus('codex', (t.status as string) ?? ''),
        agent: 'codex',
        prompt: (t.prompt || t.query || '') as string,
        branch: (t.branch as string) || undefined,
        summary: (t.summary as string) || undefined,
        createdAt: (t.created_at as string) || '',
        updatedAt: (t.updated_at as string) || '',
      }));

      if (filter?.status) {
        return tasks.filter((t) => t.status === filter.status);
      }
      return tasks;
    } catch {
      return [];
    }
  }

  async *stream(taskId: string): AsyncIterable<CloudEvent> {
    const terminalStatuses = new Set<CloudTaskStatus>(['completed', 'failed', 'cancelled']);
    let lastStatus = '';

    while (true) {
      try {
        const task = await this.status(taskId);
        if (task.status !== lastStatus) {
          lastStatus = task.status;
          const ts = new Date().toISOString();
          if (terminalStatuses.has(task.status)) {
            yield { type: 'done', status: task.status, summary: task.summary, timestamp: ts };
          } else {
            yield { type: 'status', status: task.status, timestamp: ts };
          }
        }
        if (terminalStatuses.has(task.status)) break;
      } catch (err) {
        yield {
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        };
        break;
      }

      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  async cancel(_taskId: string): Promise<void> {
    throw new Error('Cancel is not supported for Codex Cloud tasks via CLI.');
  }

  async message(_taskId: string, _content: string): Promise<void> {
    throw new Error('Follow-up messages are not supported for Codex Cloud tasks.');
  }
}

export function extractTaskId(output: string): string | undefined {
  try {
    const data = JSON.parse(output);
    return data.id || data.task_id;
  } catch {
    const match = output.match(/(?:task[_\s]?id|id)\s*[:=]\s*["']?([a-zA-Z0-9_-]+)/i)
      || output.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
      || output.match(/(task_[a-zA-Z0-9]+)/i);
    return match?.[1];
  }
}
