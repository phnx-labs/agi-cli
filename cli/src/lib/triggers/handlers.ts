
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
  command?: string;
  channel?: string;
  host?: string;
  project?: string;
  cwd?: string;
  mode?: JobConfig['mode'];
  run?: {
    agent?: AgentId;
    workflow?: string;
    command?: string;
    prompt?: string;
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

function payloadRepo(payload: Record<string, unknown>): string | null {
  const repo = payload?.repository as { full_name?: unknown } | undefined;
  const fullName = repo?.full_name;
  return typeof fullName === 'string' && fullName.length > 0 ? fullName : null;
}

function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, '');
}

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
  host?: string;
  hostStrategy?: 'host' | 'fleet';
}

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

export function handlerMatchesWebhook(handler: WebhookHandler, webhook: IncomingWebhook): boolean {
  if (handler.enabled === false) return false;
  if (handler.source !== webhook.source) return false;
  if (handler.event && handler.event !== webhook.event) return false;
  if (!handlerRunsOnThisDevice(handler)) return false;

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

export interface SlackMessageContext {
  text: string;
  project: string;
  prompt: string;
  channel: string;
  thread_ts: string;
  user: string;
  command: string;
  response_url: string;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

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

export function buildWebhookContext(webhook: IncomingWebhook): WebhookContext {
  if (webhook.source === 'slack') {
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
  return import('../daemon/runner.js').then((m) => m.executeJobDetached(config));
}

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
  const substitutedProject = handler.project ? substituteWebhookPrompt(handler.project, context).trim() : '';
  const substitutedCwd = handler.cwd ? substituteWebhookPrompt(handler.cwd, context).trim() : '';
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
