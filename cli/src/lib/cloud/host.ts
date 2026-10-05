
import type {
  CloudEvent,
  CloudProvider,
  CloudTarget,
  CloudTask,
  CloudTaskStatus,
  DispatchOptions,
  ProviderCapabilities,
} from './types.js';
import { MissingTargetError, resolveDispatchRepos } from './types.js';
import type { HostTask } from '../hosts/tasks.js';
import { listTasks, loadTask, terminalPatch, updateTask } from '../hosts/tasks.js';
import { readRemoteExit } from '../hosts/reconcile.js';
import { sshReachable } from '../ssh-exec.js';
import { fetchProgress } from '../hosts/progress.js';
import { dispatchPromptToHost, resolveHostRunTarget } from '../hosts/run-target.js';
import { listAllHosts } from '../hosts/registry.js';
import { terminateDispatchedTask } from '../hosts/dispatch.js';

function toCloudStatus(status: HostTask['status']): CloudTaskStatus {

  switch (status) {
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'running':
    case 'unknown':
    default:
      return 'running';
  }
}

export function hostTaskToCloudTask(task: HostTask): CloudTask {
  return {
    id: task.id,
    provider: 'host',
    status: toCloudStatus(task.status),
    agent: task.agent,
    prompt: task.prompt,
    createdAt: task.createdAt,
    updatedAt: task.finishedAt ?? task.createdAt,
    summary: `on ${task.host}${task.name ? ` as "${task.name}"` : ''}`,
  };
}

export class HostCloudProvider implements CloudProvider {
  readonly id = 'host' as const;
  readonly name = 'Host (your machines)';
  readonly targetKind = 'host' as const;

  private reachable = new Map<string, boolean>();

  capabilities(): ProviderCapabilities {
    return {
      available: true,
      dispatch: true,
      status: true,
      list: true,
      stream: true,
      cancel: true,
      message: true,
      multiRepo: false,
      skills: false,
      images: false,
    };
  }

  async dispatch(options: DispatchOptions): Promise<CloudTask> {
    const hostName = options.providerOptions?.host as string | undefined;
    if (!hostName) {
      throw new MissingTargetError(
        'host',
        'No host given. Pass --device <name> (a registered host, a device, a capability tag, or user@host).',
        'List your machines: agents devices list  ·  register more: agents devices sync',
      );
    }
    if (resolveDispatchRepos(options).length > 0) {
      throw new Error(
        '--repo has no meaning for --provider host — the run executes in a directory on the machine, not a cloned repo. ' +
          'Pass the working directory via providerOptions.remoteCwd (CLI: --remote-cwd) instead.',
      );
    }
    if (options.branch) {
      throw new Error('--branch has no meaning for --provider host (no clone step). Check out the branch on the host, or use --remote-cwd.');
    }

    const host = await resolveHostRunTarget(hostName, {
      any: options.providerOptions?.any === true,
    });
    const { task } = await dispatchPromptToHost(host, {
      agent: options.agent ?? 'claude',
      prompt: options.prompt,
      mode: options.providerOptions?.mode as string | undefined,
      model: options.model,
      timeout: options.timeout,
      remoteCwd: options.providerOptions?.remoteCwd as string | undefined,
      name: options.providerOptions?.name as string | undefined,
      follow: false,
    });
    return hostTaskToCloudTask(task);
  }

  async status(taskId: string): Promise<CloudTask> {
    const task = loadTask(taskId);
    if (!task) throw new Error(`Unknown host task: ${taskId}`);
    return hostTaskToCloudTask(this.reconcileMemoized(task));
  }

  async list(filter?: { status?: CloudTaskStatus }): Promise<CloudTask[]> {
    const tasks = listTasks().map((t) => hostTaskToCloudTask(this.reconcileMemoized(t)));
    return filter?.status ? tasks.filter((t) => t.status === filter.status) : tasks;
  }

  private reconcileMemoized(task: HostTask): HostTask {
    if (task.status !== 'running') return task;

    if (!this.reachable.has(task.target)) {
      this.reachable.set(task.target, sshReachable(task.target, 6000));
    }
    if (!this.reachable.get(task.target)) return task;
    const st = readRemoteExit(task.target, task.remoteExit);
    if (st.state !== 'done') return task;
    return updateTask(task.id, terminalPatch(st.code)) ?? task;
  }

  async *stream(taskId: string): AsyncIterable<CloudEvent> {
    const task = loadTask(taskId);
    if (!task) throw new Error(`Unknown host task: ${taskId}`);
    if (task.status !== 'running') {
      yield { type: 'status', status: toCloudStatus(task.status) };
      yield { type: 'done', status: toCloudStatus(task.status) };
      return;
    }

    let offset = 0;
    const fastPollMs = 1500;
    const maxPollMs = 6000;
    let pollMs = fastPollMs;
    for (;;) {
      const fetched = fetchProgress(task.target, {
        remoteLog: task.remoteLog,
        remoteExit: task.remoteExit,
        taskId: task.id,
        offset,
        extraSshArgs: task.identityFile ? ['-i', task.identityFile, '-o', 'IdentitiesOnly=yes'] : [],
      });
      if (fetched) {
        if (fetched.logChunk.length > 0) {
          offset += fetched.logChunk.length;
          pollMs = fastPollMs;
          yield { type: 'text', content: fetched.logChunk.toString('utf8') };
        } else {
          pollMs = Math.min(Math.round(pollMs * 1.5), maxPollMs);
        }
        const exit = fetched.exit.trim();
        if (exit !== '') {
          const code = Number.parseInt(exit, 10);
          const finished = updateTask(task.id, terminalPatch(Number.isFinite(code) ? code : 0));
          const status = toCloudStatus(finished?.status ?? (code === 0 ? 'completed' : 'failed'));
          yield { type: 'done', status };
          return;
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  async cancel(taskId: string): Promise<void> {
    const task = loadTask(taskId);
    if (!task) throw new Error(`Unknown host task: ${taskId}`);
    terminateDispatchedTask(task);
  }

  async message(taskId: string, content: string): Promise<void> {
    const task = loadTask(taskId);
    if (!task) throw new Error(`Unknown host task: ${taskId}`);
    if (!task.sessionId) {
      throw new Error(
        `Host task ${taskId} has no session id to resume (only Claude runs capture one). ` +
          `Start a follow-up run instead: agents run ${task.agent} "<prompt>" --device ${task.host}`,
      );
    }
    const host = await resolveHostRunTarget(task.host);
    await dispatchPromptToHost(host, {
      agent: task.agent,
      prompt: content,
      resume: task.sessionId,
      name: task.name,
      follow: false,
    });
  }

  async listTargets(): Promise<CloudTarget[]> {
    const hosts = await listAllHosts();
    return hosts
      .filter((h) => h.dispatchable !== false)
      .map((h) => ({
        id: h.name,
        label: [
          h.provider === 'devices' ? 'device' : h.source,
          h.os,
          h.status && h.status !== 'unknown' ? h.status : undefined,
          h.caps?.length ? `caps: ${h.caps.join(',')}` : undefined,
        ]
          .filter(Boolean)
          .join(' · '),
        kind: 'host' as const,
      }));
  }
}
