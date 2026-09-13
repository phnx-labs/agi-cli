/**
 * Webhook handler config layer.
 *
 * Handlers are one-off triggers stored in `~/.agents/webhooks/*.yml` (plus
 * project/system layers). They complement routine triggers: a matching webhook
 * can run an agent, workflow, shell command, or delegate to a routine.
 */

import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { emit } from '../feed/events.js';
import { machineId, normalizeHost } from '../machine-id.js';
import { safeJoin } from '../paths.js';
import { pickFleetDevice } from '../routines-placement.js';
import type { DevicePlatform } from '../devices/registry.js';
import type { JobConfig, RunMeta, WebhookContext } from '../scheduling/routines.js';
import {
  assertShellSubstitutionSupported,
  readJob,
  substituteWebhookCommand,
  substituteWebhookPrompt,
} from '../scheduling/routines.js';
import { ensureAgentsDir, getProjectWebhooksDir, getSystemWebhooksDir, getWebhooksDir } from '../state.js';
import type { AgentId } from '../types.js';
import type { IncomingWebhook, SlackPayload, WebhookSource } from './webhook.js';

export interface WebhookHandler {
  name: string;
  enabled?: boolean;
  devices?: string[];
  source: WebhookSource;
  event?: string;
  action?: string;
  stateTo?: string;
  stateFrom?: string;
  teamKey?: string;
  label?: string;
  repo?: string;
  branch?: string;
  /** Slack (source: slack) only — match one slash command, e.g. `/agents`. */
  command?: string;
  /** Slack (source: slack) only — restrict to one channel id (`C0…`). Lets a
   *  channel imply a project via a per-channel handler. */
  channel?: string;
  /**
   * Where to run the action. A device name (`yosemite-s0`) runs there over SSH;
   * `fleet` picks any eligible online worker; `fleet/<platform>` (or
   * `<platform>/fleet`, or a bare `linux`/`macos`/`windows`) restricts that pick
   * to one platform. Omitted runs locally.
   */
  host?: string;
  /**
   * Named project (`agents projects`) whose base directory the dispatched
   * agent/workflow run lands in — the execution anchor, mirroring a routine's
   * `project`. Without it an agent handler runs at the target's `$HOME` with no
   * repo checkout to edit. Applies to `run.agent`/`run.workflow` and the
   * `routine:` delegate; ignored by `run.command` (put a `cd` in the command).
   */
  project?: string;
  /**
   * Portable execution directory for the dispatched run. A relative value
   * resolves under `project` when set, otherwise the target's `$HOME`. Mirrors
   * a routine's `cwd`.
   */
  cwd?: string;
  /**
   * Permission mode for a dispatched agent/workflow run. Defaults to `auto`
   * (write with the classifier). Set `skip`/`full` for fully unattended edits,
   * or `plan` for a read-only run.
   */
  mode?: JobConfig['mode'];
  run?: {
    agent?: AgentId;
    workflow?: string;
    command?: string;
    prompt?: string;
    /** Environment variables injected into the spawned process. */
    env?: Record<string, string>;
  };
  routine?: string;
}

export interface FiredHandler {
  handlerName: string;
  runId?: string;
  exitCode?: number;
  output?: string;
}

const HANDLER_DEFAULTS: Partial<WebhookHandler> = {
  enabled: true,
};

/** Read `repository.full_name` (`owner/name`) from a webhook payload, if present. */
function payloadRepo(payload: Record<string, unknown>): string | null {
  const repo = payload?.repository as { full_name?: unknown } | undefined;
  const fullName = repo?.full_name;
  return typeof fullName === 'string' && fullName.length > 0 ? fullName : null;
}

/** Strip a `refs/heads/` (or `refs/tags/`) prefix to the short branch/tag name. */
function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, '');
}

/** Extract candidate branches a webhook payload references. */
function payloadBranches(event: string, payload: Record<string, unknown>): string[] {
  const branches = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.length > 0) branches.add(shortRef(v));
  };

  switch (event) {
    case 'push':
      add(payload.ref);
      break;
    case 'pull_request': {
      const pr = payload.pull_request as { base?: { ref?: unknown }; head?: { ref?: unknown } } | undefined;
      add(pr?.base?.ref);
      add(pr?.head?.ref);
      break;
    }
    case 'workflow_run': {
      const run = payload.workflow_run as { head_branch?: unknown } | undefined;
      add(run?.head_branch);
      break;
    }
    default:
      break;
  }
  return [...branches];
}

function linearAction(payload: Record<string, unknown>): string | null {
  return typeof payload.action === 'string' ? payload.action : null;
}

function linearTeamKey(payload: Record<string, unknown>): string | null {
  const data = payload.data as Record<string, unknown> | undefined;
  const identifier = data?.identifier;
  if (typeof identifier === 'string') {
    const match = /^([A-Z][A-Z0-9]*)-\d+$/.exec(identifier);
    if (match) return match[1];
  }
  const team = data?.team as { key?: unknown } | undefined;
  return typeof team?.key === 'string' ? team.key : null;
}

function linearLabels(payload: Record<string, unknown>): string[] {
  const data = payload.data as Record<string, unknown> | undefined;
  const labels = Array.isArray(data?.labels) ? (data?.labels as unknown[]) : [];
  return labels
    .map((n) => (n as { name?: unknown }).name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
}

function githubAction(payload: Record<string, unknown>): string | null {
  return typeof payload.action === 'string' ? payload.action : null;
}

function githubLabels(payload: Record<string, unknown>): string[] {
  const names = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0) names.add(value);
  };

  const deliveryLabel = payload.label as { name?: unknown } | undefined;
  add(deliveryLabel?.name);

  const pr = payload.pull_request as { labels?: unknown } | undefined;
  const prLabels = Array.isArray(pr?.labels) ? pr.labels : [];
  for (const label of prLabels) {
    add((label as { name?: unknown }).name);
  }

  const issue = payload.issue as { labels?: unknown } | undefined;
  const issueLabels = Array.isArray(issue?.labels) ? issue.labels : [];
  for (const label of issueLabels) {
    add((label as { name?: unknown }).name);
  }

  return [...names];
}

function readHandlerFile(filePath: string): WebhookHandler | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(content);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      ...HANDLER_DEFAULTS,
      ...parsed,
      name: parsed.name || path.basename(filePath).replace(/\.ya?ml$/, ''),
    } as WebhookHandler;
  } catch {
    return null;
  }
}

function handlerRunsOnThisDevice(handler: Pick<WebhookHandler, 'devices'>): boolean {
  if (!handler.devices || handler.devices.length === 0) return true;
  const self = machineId();
  return handler.devices.some((d) => normalizeHost(d) === self);
}

const HOST_PLATFORMS: readonly string[] = ['linux', 'macos', 'windows'];

function parseHostPlatform(raw: string): { base: string; platform?: DevicePlatform } {
  const parts = raw
    .split('/')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  const platformIdx = parts.findIndex((p) => HOST_PLATFORMS.includes(p));
  if (platformIdx === -1) return { base: parts.join('/') };
  const platform = parts[platformIdx] as DevicePlatform;
  const rest = parts.filter((_, i) => i !== platformIdx).join('/');
  return { base: rest, platform };
}

interface HandlerHostResolution {
  /** Resolved execution host, or undefined to run locally. */
  host?: string;
  /** Strategy that should be set on the JobConfig. */
  hostStrategy?: 'host' | 'fleet';
}

/**
 * Resolve a handler `host` expression to a concrete host or local execution.
 *
 * - Specific device name (e.g. `yosemite-s0`) → run there over SSH, or locally
 *   if it names this machine.
 * - `fleet` → pick any online worker device.
 * - `fleet/<platform>` or `<platform>/fleet` (e.g. `fleet/linux`, `linux/fleet`)
 *   → pick any online worker on that platform. `linux` alone is accepted as a
 *   shorthand for `fleet/linux`.
 *
 * Throws when a fleet expression matches no eligible device, rather than
 * silently falling back to this machine — `fleet/linux` must never land on a
 * macOS box.
 */
export function resolveHandlerHost(host: string | undefined): HandlerHostResolution {
  if (!host || host.trim() === '') return {};
  const { base, platform } = parseHostPlatform(host);
  const isFleet = base === '' || base === 'fleet';
  if (isFleet) {
    const picked = pickFleetDevice(undefined, platform);
    if (!picked) {
      throw new Error(`handler host '${host}': no eligible online fleet device`);
    }
    if (normalizeHost(picked) === machineId()) return {};
    return { host: picked, hostStrategy: 'host' };
  }
  if (normalizeHost(base) === machineId()) return {};
  return { host: base, hostStrategy: 'host' };
}

/**
 * List all webhook handlers, scanning project > user > system webhook dirs.
 * Higher layers shadow lower ones of the same name (first-seen wins).
 */
export function listHandlers(cwd?: string): WebhookHandler[] {
  ensureAgentsDir();
  const seen = new Set<string>();
  const handlers: WebhookHandler[] = [];

  const dirs: Array<{ scope: 'project' | 'user' | 'system'; path: string }> = [];
  if (cwd) {
    const projectDir = getProjectWebhooksDir(cwd);
    if (projectDir) dirs.push({ scope: 'project', path: projectDir });
  }
  dirs.push({ scope: 'user', path: getWebhooksDir() });
  dirs.push({ scope: 'system', path: getSystemWebhooksDir() });

  for (const { path: dir } of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    for (const file of files) {
      const handler = readHandlerFile(safeJoin(dir, file));
      if (!handler) continue;
      if (seen.has(handler.name)) continue;
      seen.add(handler.name);
      handlers.push(handler);
    }
  }
  return handlers;
}

/** Pure matcher: does this handler match the incoming webhook? */
export function handlerMatchesWebhook(handler: WebhookHandler, webhook: IncomingWebhook): boolean {
  if (handler.enabled === false) return false;
  if (handler.source !== webhook.source) return false;
  if (handler.event && handler.event !== webhook.event) return false;
  if (!handlerRunsOnThisDevice(handler)) return false;

  // Slack has no GitHub/Linear action/label/branch vocabulary; it matches on the
  // slash command and (optionally) the channel. `event` already pinned the
  // subtype (`app_mention`) or the slash command name above.
  if (webhook.source === 'slack') {
    const slack = webhook.payload as SlackPayload;
    if (handler.command && slack.command !== handler.command) return false;
    if (handler.channel && slack.channel !== handler.channel) return false;
    return true;
  }

  if (handler.action) {
    const action = webhook.source === 'github' ? githubAction(webhook.payload) : linearAction(webhook.payload);
    if (action !== handler.action) return false;
  }

  if (webhook.source === 'linear') {
    if (handler.teamKey && linearTeamKey(webhook.payload) !== handler.teamKey) return false;
    if (handler.label) {
      const expected = handler.label.toLowerCase();
      if (!linearLabels(webhook.payload).some((name) => name.toLowerCase() === expected)) return false;
    }
    if (handler.stateTo) {
      const data = webhook.payload.data as Record<string, unknown> | undefined;
      const current = (data?.state as Record<string, unknown> | undefined)?.name;
      if (current !== handler.stateTo) return false;
      // RUSH-2539: `stateTo` is a TRANSITION predicate, not a current-state one.
      // Linear carries the prior value of each changed field in `updatedFrom`, so a
      // real state change has `updatedFrom.state` (this codebase's shape) or
      // `updatedFrom.stateId` (Linear's scalar). With neither, this Issue/update
      // touched something else (label, assignee, description) while the issue merely
      // still sits in `stateTo` — matching there re-fires on every later edit
      // (RUSH-1459 accumulated 11 duplicate plan comments).
      const updatedTo = webhook.payload.updatedFrom as Record<string, unknown> | undefined;
      if (!updatedTo || (updatedTo.state === undefined && updatedTo.stateId === undefined)) return false;
    }
    if (handler.stateFrom) {
      const updatedFrom = webhook.payload.updatedFrom as Record<string, unknown> | undefined;
      const previous = (updatedFrom?.state as Record<string, unknown> | undefined)?.name;
      if (previous !== handler.stateFrom) return false;
    }
    return true;
  }

  if (handler.repo) {
    const repo = payloadRepo(webhook.payload);
    if (!repo || repo.toLowerCase() !== handler.repo.toLowerCase()) return false;
  }
  if (handler.branch) {
    const branches = payloadBranches(webhook.event, webhook.payload);
    if (!branches.some((b) => b === handler.branch)) return false;
  }
  if (handler.label) {
    const expected = handler.label.toLowerCase();
    if (!githubLabels(webhook.payload).some((name) => name.toLowerCase() === expected)) return false;
  }
  return true;
}

/**
 * The `{{slack.*}}` substitution namespace: a Slack message split into an
 * agent-actionable project + prompt, plus the coordinates a reply threads into.
 */
export interface SlackMessageContext {
  /** The message with a leading bot mention stripped. */
  text: string;
  /** The `PROJECT:` token at the head of the message, or '' when absent. */
  project: string;
  /** The request — the text after `PROJECT:`, or the whole message. */
  prompt: string;
  /** Channel id to reply into (`C0…`). */
  channel: string;
  /** Thread ts to reply into (empty for a slash command → reply to the channel). */
  thread_ts: string;
  /** Invoking user id (`U0…`). */
  user: string;
  /** Slash command name (`/agents`), or '' for an event delivery. */
  command: string;
  /**
   * Slash-command reply URL (`https://hooks.slack.com/commands/…`), or '' for an
   * event delivery. Slack accepts a POST here for 30 minutes with no token and no
   * channel membership, so it is the only reply path that works before the app has
   * been invited to a channel.
   */
  response_url: string;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Split a Slack message into a `{{slack.*}}` context. Strips a leading bot
 * mention (`<@U0BOT> …`), then reads an optional `PROJECT:` prefix — a single
 * bare token followed by a colon and a space — as the project, with the
 * remainder the prompt. `AGI: rebase my PR` → project `AGI`, prompt
 * `rebase my PR`; a message with no such prefix leaves `project` empty and the
 * whole text as the prompt. The token pattern forbids slashes, so a project
 * value can never carry a path into a `cwd`/`project` substitution.
 */
function parseSlackMessage(payload: SlackPayload): SlackMessageContext {
  const cleaned = asString(payload.text).replace(/^\s*<@[^>]+>\s*/, '').trim();
  const m = /^([A-Za-z0-9][\w.-]*)\s*:\s+([\s\S]+)$/.exec(cleaned);
  return {
    text: cleaned,
    project: m ? m[1] : '',
    prompt: m ? m[2].trim() : cleaned,
    channel: asString(payload.channel),
    thread_ts: asString(payload.thread_ts),
    user: asString(payload.user),
    command: asString(payload.command),
    response_url: asString(payload.response_url),
  };
}

/**
 * Build the variable-substitution context for a webhook. Linear events expose
 * `issue` and `updatedFrom`; GitHub events expose `repository`, `pull_request`,
 * and `issue`; Slack events expose the `{{slack.*}}` namespace above.
 */
export function buildWebhookContext(webhook: IncomingWebhook): WebhookContext {
  if (webhook.source === 'slack') {
    // The `{{slack.*}}` namespace rides an intersection over WebhookContext (a
    // subtype of it) rather than a field on the shared type, so a Slack-only
    // addition never touches the scheduling hub every routine test depends on.
    // `substituteWebhookPrompt`/`getPath` read it dynamically at runtime.
    const ctx: WebhookContext & { slack: SlackMessageContext } = {
      source: webhook.source,
      event: webhook.event,
      slack: parseSlackMessage(webhook.payload as SlackPayload),
    };
    return ctx;
  }
  const action = webhook.source === 'github'
    ? githubAction(webhook.payload) ?? undefined
    : linearAction(webhook.payload) ?? undefined;
  if (webhook.source === 'linear') {
    return {
      source: webhook.source,
      event: webhook.event,
      action,
      issue: webhook.payload.data,
      updatedFrom: webhook.payload.updatedFrom,
    };
  }
  return {
    source: webhook.source,
    event: webhook.event,
    action,
    repository: webhook.payload.repository,
    pull_request: webhook.payload.pull_request,
    issue: webhook.payload.issue,
  };
}

interface ExecuteHandlerOptions {
  dispatchAgent?: (config: JobConfig) => Promise<RunMeta>;
  dispatchWorkflow?: (config: JobConfig) => Promise<RunMeta>;
  execCommand?: (command: string) => Promise<{ exitCode: number; output: string }>;
  dispatchRoutine?: (config: JobConfig) => Promise<RunMeta>;
}

function defaultExecCommand(command: string): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    exec(command, (error, stdout, stderr) => {
      const output = stdout + stderr;
      if (error) {
        resolve({ exitCode: typeof error.code === 'number' ? error.code : 1, output });
      } else {
        resolve({ exitCode: 0, output });
      }
    });
  });
}

function dispatchDefault(config: JobConfig): Promise<RunMeta> {
  // Import lazily so the runner module (heavy) is only loaded when a handler
  // actually needs to spawn. Tests inject dispatch functions, so this path is
  // not exercised in unit tests.
  return import('../daemon/runner.js').then((m) => m.executeJobDetached(config));
}

/**
 * Execute a handler's action. Runs the configured agent/workflow/command or
 * delegates to a routine, substituting `{{...}}` placeholders from the webhook
 * context.
 */
export async function executeHandler(
  handler: WebhookHandler,
  webhook: IncomingWebhook,
  opts: ExecuteHandlerOptions = {},
): Promise<FiredHandler> {
  const context = buildWebhookContext(webhook);
  const base: FiredHandler = { handlerName: handler.name };

  emit('webhook.handler.start', {
    source: webhook.source,
    event: webhook.event,
    handlerName: handler.name,
  });

  try {
    const result = await executeHandlerAction(handler, webhook, context, opts);
    emit('webhook.handler.end', {
      source: webhook.source,
      event: webhook.event,
      handlerName: handler.name,
      status: 'success',
      ...result,
    });
    return { ...base, ...result };
  } catch (err) {
    const error = (err as Error).message;
    emit('webhook.handler.end', {
      source: webhook.source,
      event: webhook.event,
      handlerName: handler.name,
      status: 'error',
      error,
    });
    throw err;
  }
}

async function executeHandlerAction(
  handler: WebhookHandler,
  webhook: IncomingWebhook,
  context: WebhookContext,
  opts: ExecuteHandlerOptions,
): Promise<Omit<FiredHandler, 'handlerName'>> {
  const substitutedPrompt = handler.run?.prompt ? substituteWebhookPrompt(handler.run.prompt, context) : '';
  // Slack routes the project per-message (`AGI: …`), so a handler may template
  // its project/cwd — e.g. `project: "{{slack.project}}"`. Substitute + trim; an
  // empty result omits the field (falls back to the run's default cwd / $HOME).
  const substitutedProject = handler.project ? substituteWebhookPrompt(handler.project, context).trim() : '';
  const substitutedCwd = handler.cwd ? substituteWebhookPrompt(handler.cwd, context).trim() : '';
  // Resolved once so a fleet pick can't differ between the two dispatch paths.
  const hostFields = resolveHandlerHost(handler.host);

  if (handler.run?.agent || handler.run?.workflow) {
    const config: JobConfig = {
      name: handler.name,
      mode: handler.mode ?? 'auto',
      effort: 'auto',
      timeout: '10m',
      enabled: true,
      prompt: substitutedPrompt,
      ...(handler.run.agent ? { agent: handler.run.agent } : { workflow: handler.run.workflow! }),
      ...(handler.devices ? { devices: handler.devices } : {}),
      ...(handler.run.env ? { env: handler.run.env } : {}),
      ...(substitutedProject ? { project: substitutedProject } : {}),
      ...(substitutedCwd ? { cwd: substitutedCwd } : {}),
      ...(hostFields.host ? { host: hostFields.host } : {}),
      ...(hostFields.hostStrategy ? { hostStrategy: hostFields.hostStrategy } : {}),
      // A handler is not a routine, so its name can never appear in this device's
      // routine activation manifest — without this marker the gate answered "not
      // activated here" and every delivery was skipped while the receiver logged
      // `fired` (the same shape as RUSH-2681's monitor bug). The `routine:`
      // delegate below deliberately omits it: that fires a REAL routine, which
      // keeps its own activation gate.
      dispatchedBy: 'webhook',
    };
    const dispatch = handler.run.agent
      ? (opts.dispatchAgent ?? dispatchDefault)
      : (opts.dispatchWorkflow ?? dispatchDefault);
    const meta = await dispatch(config);
    return { runId: meta.runId };
  }

  if (handler.run?.command) {
    assertShellSubstitutionSupported(handler.run.command);
    const command = substituteWebhookCommand(handler.run.command, context);
    const exec = opts.execCommand ?? defaultExecCommand;
    const { exitCode, output } = await exec(command);
    return { exitCode, output };
  }

  if (handler.routine) {
    const routine = readJob(handler.routine);
    if (!routine) throw new Error(`routine '${handler.routine}' not found`);
    const config: JobConfig = {
      ...routine,
      prompt: substituteWebhookPrompt(routine.prompt, context),
      ...(handler.devices ? { devices: handler.devices } : {}),
      ...(substitutedProject ? { project: substitutedProject } : {}),
      ...(substitutedCwd ? { cwd: substitutedCwd } : {}),
      ...(handler.mode ? { mode: handler.mode } : {}),
      ...(hostFields.host ? { host: hostFields.host } : {}),
      ...(hostFields.hostStrategy ? { hostStrategy: hostFields.hostStrategy } : {}),
    };
    const dispatch = opts.dispatchRoutine ?? dispatchDefault;
    const meta = await dispatch(config);
    return { runId: meta.runId };
  }

  throw new Error(`handler '${handler.name}' has no run or routine action`);
}
