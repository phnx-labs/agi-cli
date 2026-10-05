
import { randomUUID } from 'crypto';
import type { Host } from './types.js';
import { resolveHost, resolveHostByCap } from './registry.js';
import { dispatchToHost } from './dispatch.js';
import type { DispatchResult } from './dispatch.js';
import { registerHostSession, captureRemoteSessionId } from './session-index.js';
import type { HostCredentials } from './credentials.js';

export class HostResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostResolutionError';
  }
}

export async function resolveHostRunTarget(name: string, opts: { any?: boolean } = {}): Promise<Host> {
  let host = await resolveHost(name);
  if (!host) {
    try {
      host = await resolveHostByCap(name, opts.any);
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (msg.startsWith('Multiple hosts')) throw new HostResolutionError(msg);
    }
  }
  if (!host) throw new HostResolutionError(`Unknown host "${name}". List devices: agents devices list`);
  return host;
}

export interface HostPromptRun {
  agent: string;
  prompt: string;
  version?: string;
  mode?: string;
  model?: string;
  name?: string;
  resume?: string;
  sessionId?: string;
  remoteCwd?: string;
  mirrorCwd?: boolean;
  follow?: boolean;
  timeoutMs?: number;
  cwd?: string;
  effort?: string;
  env?: string[];
  addDir?: string[];
  timeout?: string;
  strategy?: string;
  account?: string;
  balanced?: boolean;
  fallback?: string;
  loop?: boolean;
  maxIterations?: string;
  budget?: string;
  until?: string;
  interval?: string;
  json?: boolean;
  verbose?: boolean;
  yes?: boolean;
  acp?: boolean;
  autoSecrets?: boolean;
  passthroughArgs?: string[];
  copyCreds?: HostCredentials;
}

export function resolveHostSessionId(agent: string, resume?: string, sessionId?: string): string | undefined {
  // Claude may adopt a forced id; other harnesses report the id coined by the remote runtime.
  if (resume) return undefined;
  if (agent === 'claude') return sessionId ?? randomUUID();
  if (agent === 'auto') return sessionId;
  return undefined;
}

export async function dispatchPromptToHost(host: Host, opts: HostPromptRun): Promise<DispatchResult> {
  const forcedSessionId = resolveHostSessionId(opts.agent, opts.resume, opts.sessionId);
  const emitSessionId = (!forcedSessionId || opts.agent === 'auto') && !opts.resume && opts.follow !== false;
  const result = await dispatchToHost(host, {
    agent: opts.agent,
    prompt: opts.prompt,
    version: opts.version,
    mode: opts.mode,
    model: opts.model,
    remoteCwd: opts.remoteCwd,
    mirrorCwd: opts.mirrorCwd,
    sessionId: forcedSessionId,
    emitSessionId,
    name: opts.name,
    resume: opts.resume,
    follow: opts.follow !== false,
    timeoutMs: opts.timeoutMs,
    effort: opts.effort,
    env: opts.env,
    addDir: opts.addDir,
    timeout: opts.timeout,
    strategy: opts.strategy,
    account: opts.account,
    balanced: opts.balanced,
    fallback: opts.fallback,
    loop: opts.loop,
    maxIterations: opts.maxIterations,
    budget: opts.budget,
    until: opts.until,
    interval: opts.interval,
    json: opts.json,
    verbose: opts.verbose,
    yes: opts.yes,
    acp: opts.acp,
    autoSecrets: opts.autoSecrets,
    passthroughArgs: opts.passthroughArgs,
    copyCreds: opts.copyCreds,
  });
  // Auto retains a supplied id; without one it captures the peer-emitted runtime id.
  const task = emitSessionId ? captureRemoteSessionId(result.task) ?? result.task : result.task;
  registerHostSession(task, { cwd: opts.cwd ?? process.cwd(), prompt: opts.prompt });
  return { ...result, task };
}
