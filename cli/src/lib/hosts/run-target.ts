/** Shared host-run dispatch for `agents run --device`, the `host` cloud provider and host-placed
 * routines: resolution (name, then capability tag) and headless dispatch (session-id mint,
 * detached SSH launch, session-index registration). Interactive stays in exec.ts. */

import { randomUUID } from 'crypto';
import type { Host } from './types.js';
import { resolveHost, resolveHostByCap } from './registry.js';
import { dispatchToHost } from './dispatch.js';
import type { DispatchResult } from './dispatch.js';
import { registerHostSession, captureRemoteSessionId } from './session-index.js';
import type { HostCredentials } from './credentials.js';

/** Resolution failed with a user-actionable message to print verbatim; distinct from
 * DeviceOffloadUnsupportedError (which propagates to the top-level catch) so callers can tell a
 * bad name from a bad auth method. */
export class HostResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostResolutionError';
  }
}

/** Resolve a `--device` value like `agents run`: exact name (providers, devices, `user@host`),
 * then capability tag. Throws HostResolutionError for an ambiguous tag or unknown name;
 * DeviceOffloadUnsupportedError (password-auth device) propagates untouched. */
export async function resolveHostRunTarget(name: string, opts: { any?: boolean } = {}): Promise<Host> {
  let host = await resolveHost(name);
  if (!host) {
    try {
      host = await resolveHostByCap(name, opts.any);
    } catch (e) {
      const msg = (e as Error).message ?? '';
      // Ambiguity is a verdict, not a miss — surface it. "No host tagged"
      // falls through to the generic unknown-host error below.
      if (msg.startsWith('Multiple hosts')) throw new HostResolutionError(msg);
    }
  }
  if (!host) throw new HostResolutionError(`Unknown host "${name}". List devices: agents devices list`);
  return host;
}

export interface HostPromptRun {
  agent: string;
  prompt: string;
  /** Explicit agent version pin, forwarded as `agent@version`. */
  version?: string;
  mode?: string;
  model?: string;
  /** Durable `--name <slug>` handle recorded on the task. */
  name?: string;
  /** Resume an existing session on the host by concrete id. */
  resume?: string;
  /** Explicit id for a new Claude session. */
  sessionId?: string;
  /** Working directory on the host, already made remote-portable by the caller. */
  remoteCwd?: string;
  /** `remoteCwd` was derived from the local cwd — mirror it, don't fail on it. */
  mirrorCwd?: boolean;
  /** Stream progress and block until completion (default true). */
  follow?: boolean;
  timeoutMs?: number;
  /** Local directory to record in the session index (defaults to process.cwd()). */
  cwd?: string;
  /** Forwarded run options — see RUN_OPTION_FORWARDING in remote-cmd.ts. */
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
  /** Copy runtime credentials to the host before the run and shred them after. */
  copyCreds?: HostCredentials;
}

/** Resolve the id the remote host will adopt for a fresh Claude session. */
export function resolveHostSessionId(agent: string, resume?: string, sessionId?: string): string | undefined {
  if (resume) return undefined;
  if (agent === 'claude') return sessionId ?? randomUUID();
  // `run auto`: the harness is picked on the REMOTE. Forward an explicit id so
  // a claude pick adopts it — but never mint one: minting would suppress the
  // --emit-session-id marker a non-claude pick needs to register its session.
  if (agent === 'auto') return sessionId;
  return undefined;
}

/** Dispatch a headless prompt run onto a host and relate its session id back for every agent:
 * Claude gets a forced `--session-id`; others print theirs via `--emit-session-id`, parsed from
 * the mirrored log. Returns the task and exit code (`-1` = follow closed). */
export async function dispatchPromptToHost(host: Host, opts: HostPromptRun): Promise<DispatchResult> {
  const forcedSessionId = resolveHostSessionId(opts.agent, opts.resume, opts.sessionId);
  // Ask the remote to print its id whenever we did not force one; a no-op when unfollowed. `run
  // auto` with `--session-id` is the exception: the id is adopted only if the remote picks claude,
  // so a non-claude pick must still emit.
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
  // Capture the remote-coined id from the followed log (non-Claude); harmlessly a
  // no-op when the task already carries a forced/resumed id or no marker landed.
  const task = emitSessionId ? captureRemoteSessionId(result.task) ?? result.task : result.task;
  registerHostSession(task, { cwd: opts.cwd ?? process.cwd(), prompt: opts.prompt });
  return { ...result, task };
}
