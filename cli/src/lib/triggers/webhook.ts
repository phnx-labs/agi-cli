
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { IncomingHttpHeaders } from 'http';
import type {
  GithubJobTrigger,
  JobConfig,
  LinearJobTrigger,
  RunMeta,
  WebhookContext,
} from '../scheduling/routines.js';
import { jobRunsOnThisDevice, listJobs, substituteWebhookPrompt } from '../scheduling/routines.js';
import { executeJobDetached } from '../daemon/runner.js';
import { emit } from '../feed/events.js';
import {
  listHandlers,
  handlerMatchesWebhook,
  executeHandler,
  buildWebhookContext,
  type FiredHandler,
} from './handlers.js';

export type WebhookSource = 'github' | 'linear' | 'slack';

export interface IncomingWebhook {
  source: WebhookSource;
  event: string;
  payload: Record<string, unknown>;
}

export function webhookRepo(payload: Record<string, unknown>): string | null {
  const repo = payload?.repository as { full_name?: unknown } | undefined;
  const fullName = repo?.full_name;
  return typeof fullName === 'string' && fullName.length > 0 ? fullName : null;
}

function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, '');
}

export function webhookBranches(event: string, payload: Record<string, unknown>): string[] {
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

export function linearAction(payload: Record<string, unknown>): string | null {
  return typeof payload.action === 'string' ? payload.action : null;
}

export function linearTeamKey(payload: Record<string, unknown>): string | null {
  const data = payload.data as Record<string, unknown> | undefined;
  const identifier = data?.identifier;
  if (typeof identifier === 'string') {
    const match = /^([A-Z][A-Z0-9]*)-\d+$/.exec(identifier);
    if (match) return match[1];
  }
  const team = data?.team as { key?: unknown } | undefined;
  return typeof team?.key === 'string' ? team.key : null;
}

export function linearLabels(payload: Record<string, unknown>): string[] {
  const data = payload.data as Record<string, unknown> | undefined;
  const labels = Array.isArray(data?.labels) ? (data?.labels as unknown[]) : [];
  return labels
    .map((n) => (n as { name?: unknown }).name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
}

export function githubAction(payload: Record<string, unknown>): string | null {
  return typeof payload.action === 'string' ? payload.action : null;
}

export function githubLabels(payload: Record<string, unknown>): string[] {
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

function githubTriggerMatches(trigger: GithubJobTrigger, webhook: IncomingWebhook): boolean {
  if (webhook.source !== 'github') return false;
  if (trigger.event !== webhook.event) return false;
  if (trigger.action && githubAction(webhook.payload) !== trigger.action) return false;

  if (trigger.repo) {
    const repo = webhookRepo(webhook.payload);
    if (!repo || repo.toLowerCase() !== trigger.repo.toLowerCase()) return false;
  }

  if (trigger.branch) {
    const branches = webhookBranches(webhook.event, webhook.payload);
    if (!branches.some((b) => b === trigger.branch)) return false;
  }

  if (trigger.label) {
    const expected = trigger.label.toLowerCase();
    if (!githubLabels(webhook.payload).some((name) => name.toLowerCase() === expected)) return false;
  }

  return true;
}

function linearTriggerMatches(trigger: LinearJobTrigger, webhook: IncomingWebhook): boolean {
  if (webhook.source !== 'linear') return false;
  if (trigger.event !== webhook.event) return false;
  if (trigger.action && linearAction(webhook.payload) !== trigger.action) return false;
  if (trigger.teamKey && linearTeamKey(webhook.payload) !== trigger.teamKey) return false;
  if (trigger.label) {
    const expected = trigger.label.toLowerCase();
    if (!linearLabels(webhook.payload).some((name) => name.toLowerCase() === expected)) return false;
  }
  if (trigger.stateTo) {
    const data = webhook.payload.data as Record<string, unknown> | undefined;
    const current = (data?.state as Record<string, unknown> | undefined)?.name;
    if (current !== trigger.stateTo) return false;
    const updatedTo = webhook.payload.updatedFrom as Record<string, unknown> | undefined;
    if (!updatedTo || (updatedTo.state === undefined && updatedTo.stateId === undefined)) return false;
  }
  if (trigger.stateFrom) {
    const updatedFrom = webhook.payload.updatedFrom as Record<string, unknown> | undefined;
    const previous = (updatedFrom?.state as Record<string, unknown> | undefined)?.name;
    if (previous !== trigger.stateFrom) return false;
  }
  return true;
}

export function jobMatchesWebhook(job: JobConfig, webhook: IncomingWebhook): boolean {
  const trigger = job.trigger;
  if (!trigger) return false;
  if (trigger.type === 'github_event') return githubTriggerMatches(trigger, webhook);
  if (trigger.type === 'linear_event') return linearTriggerMatches(trigger, webhook);
  return false;
}

export function matchJobsToWebhook(jobs: JobConfig[], webhook: IncomingWebhook): JobConfig[] {
  return jobs.filter((job) => job.enabled !== false && jobRunsOnThisDevice(job) && jobMatchesWebhook(job, webhook));
}

export interface FireWebhookOptions {
  jobs?: JobConfig[];
  dispatch?: (config: JobConfig) => Promise<RunMeta>;
  skipJobNames?: ReadonlySet<string>;
  onJobFired?: (job: JobConfig, fired: FiredJob) => void;
  context?: WebhookContext;
}

interface FiredJob {
  jobName: string;
  runId: string;
}

class WebhookDispatchError extends Error {
  constructor(
    message: string,
    readonly fired: FiredJob[],
    readonly failures: { jobName: string; error: Error }[],
  ) {
    super(message);
    this.name = 'WebhookDispatchError';
  }
}

export async function fireWebhookJobs(
  webhook: IncomingWebhook,
  options: FireWebhookOptions = {},
): Promise<FiredJob[]> {
  const jobs = options.jobs ?? listJobs();
  const dispatch = options.dispatch ?? executeJobDetached;
  const skipJobNames = options.skipJobNames ?? new Set<string>();
  const matched = matchJobsToWebhook(jobs, webhook);

  const fired: FiredJob[] = [];
  const failures: { jobName: string; error: Error }[] = [];
  for (const job of matched) {
    if (skipJobNames.has(job.name)) continue;
    emit('webhook.matched', { source: webhook.source, event: webhook.event, jobName: job.name });
    try {
      const jobToDispatch = options.context
        ? { ...job, prompt: substituteWebhookPrompt(job.prompt, options.context) }
        : job;
      const meta = await dispatch(jobToDispatch);
      const firedJob = { jobName: job.name, runId: meta.runId };
      fired.push(firedJob);
      options.onJobFired?.(job, firedJob);
    } catch (err) {
      failures.push({ jobName: job.name, error: err as Error });
    }
  }
  if (failures.length > 0) {
    throw new WebhookDispatchError(
      `failed to dispatch ${failures.length} webhook routine(s): ${failures.map((f) => f.jobName).join(', ')}`,
      fired,
      failures,
    );
  }
  return fired;
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function timingSafeHexEqual(received: string | undefined, expected: string): boolean {
  if (!received || !/^[a-f0-9]+$/i.test(received)) return false;
  const a = Buffer.from(received, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hmacHex(secret: string, rawBody: Buffer): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifyGithubSignature(headers: IncomingHttpHeaders, rawBody: Buffer, secret: string): boolean {
  const received = header(headers, 'x-hub-signature-256');
  const signature = received?.startsWith('sha256=') ? received.slice('sha256='.length) : undefined;
  return timingSafeHexEqual(signature, hmacHex(secret, rawBody));
}

export function verifyLinearSignature(headers: IncomingHttpHeaders, rawBody: Buffer, secret: string): boolean {
  return timingSafeHexEqual(header(headers, 'linear-signature'), hmacHex(secret, rawBody));
}

function verifyLinearTimestamp(payload: Record<string, unknown>, now = Date.now(), toleranceMs = 60_000): boolean {
  const ts = payload.webhookTimestamp;
  return typeof ts === 'number' && Math.abs(now - ts) <= toleranceMs;
}

export function verifySlackSignature(
  headers: IncomingHttpHeaders,
  rawBody: Buffer,
  secret: string,
  now: number = Date.now(),
  toleranceSec = 300,
): boolean {
  // HMAC authenticity alone permits replay; reject signatures outside Slack's bounded window.
  const ts = header(headers, 'x-slack-request-timestamp');
  if (!ts || !/^\d+$/.test(ts)) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(ts)) > toleranceSec) return false;
  const received = header(headers, 'x-slack-signature');
  const signature = received?.startsWith('v0=') ? received.slice('v0='.length) : undefined;
  const base = Buffer.concat([Buffer.from(`v0:${ts}:`, 'utf-8'), rawBody]);
  const expected = crypto.createHmac('sha256', secret).update(base).digest('hex');
  return timingSafeHexEqual(signature, expected);
}

export interface SlackPayload extends Record<string, unknown> {
  type: string;
  challenge?: string;
  event_id?: string;
  event_type?: string;
  text?: string;
  channel?: string;
  thread_ts?: string;
  user?: string;
  command?: string;
  response_url?: string;
  team?: string;
}

export function parseSlackBody(contentType: string | undefined, rawBody: Buffer): SlackPayload {
  if ((contentType ?? '').includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(rawBody.toString('utf-8'));
    return {
      type: 'slash_command',
      command: form.get('command') ?? undefined,
      text: form.get('text') ?? undefined,
      channel: form.get('channel_id') ?? undefined,
      user: form.get('user_id') ?? undefined,
      response_url: form.get('response_url') ?? undefined,
      team: form.get('team_id') ?? undefined,
    };
  }
  const json = rawBody.length > 0 ? (JSON.parse(rawBody.toString('utf-8')) as Record<string, unknown>) : {};
  const type = String(json.type ?? '');
  if (type === 'url_verification') {
    return { type, challenge: typeof json.challenge === 'string' ? json.challenge : '' };
  }
  const event = (json.event ?? {}) as Record<string, unknown>;
  return {
    type: type || 'event_callback',
    event_id: typeof json.event_id === 'string' ? json.event_id : undefined,
    event_type: typeof event.type === 'string' ? event.type : undefined,
    text: typeof event.text === 'string' ? event.text : undefined,
    channel: typeof event.channel === 'string' ? event.channel : undefined,
    thread_ts:
      typeof event.thread_ts === 'string'
        ? event.thread_ts
        : typeof event.ts === 'string'
          ? event.ts
          : undefined,
    user: typeof event.user === 'string' ? event.user : undefined,
    team: typeof json.team_id === 'string' ? json.team_id : undefined,
  };
}

export function slackEventName(payload: SlackPayload): string {
  if (payload.type === 'slash_command') return payload.command ?? 'slash_command';
  return payload.event_type ?? payload.type;
}

export interface WebhookSecrets {
  github?: string;
  linear?: string;
  slack?: string;
}

interface DeliveryStore {
  seen(id: string): boolean;
  mark(id: string): void;
  completedJobs(id: string): ReadonlySet<string>;
  markJob(id: string, jobName: string): void;
}

function createMemoryDeliveryStore(maxEntries = 1000): DeliveryStore {
  const seen = new Map<string, { complete: boolean; jobs: Set<string>; updatedAt: number }>();
  const touch = (id: string) => {
    let current = seen.get(id);
    if (!current) {
      current = { complete: false, jobs: new Set<string>(), updatedAt: Date.now() };
      seen.set(id, current);
    }
    current.updatedAt = Date.now();
    while (seen.size > maxEntries) {
      let oldestId: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, value] of seen) {
        if (value.updatedAt < oldestAt) {
          oldestAt = value.updatedAt;
          oldestId = key;
        }
      }
      if (!oldestId) break;
      seen.delete(oldestId);
    }
    return current;
  };
  return {
    seen: (id) => seen.get(id)?.complete === true,
    mark: (id) => {
      touch(id).complete = true;
    },
    completedJobs: (id) => new Set(seen.get(id)?.jobs ?? []),
    markJob: (id, jobName) => {
      touch(id).jobs.add(jobName);
    },
  };
}

interface PersistedDelivery {
  complete: boolean;
  jobs: string[];
  updatedAt: number;
}

export function createFileDeliveryStore(
  filePath: string,
  retentionMs = 14 * 24 * 60 * 60 * 1000,
): DeliveryStore {
  // Persist age-bounded per-job progress so restarts resume partial delivery without refiring work.
  const seen = new Map<string, { complete: boolean; jobs: Set<string>; updatedAt: number }>();

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, PersistedDelivery>;
    const loadedAt = Date.now();
    for (const [id, entry] of Object.entries(raw)) {
      if (typeof entry?.updatedAt !== 'number' || loadedAt - entry.updatedAt > retentionMs) continue;
      seen.set(id, {
        complete: entry.complete === true,
        jobs: new Set(Array.isArray(entry.jobs) ? entry.jobs : []),
        updatedAt: entry.updatedAt,
      });
    }
  } catch {
  }

  const persist = () => {
    const snapshot: Record<string, PersistedDelivery> = {};
    for (const [id, entry] of seen) {
      snapshot[id] = { complete: entry.complete, jobs: [...entry.jobs], updatedAt: entry.updatedAt };
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf-8');
      fs.renameSync(tmp, filePath);
    } catch {
    }
  };

  const prune = (now: number) => {
    for (const [id, entry] of seen) {
      if (now - entry.updatedAt > retentionMs) seen.delete(id);
    }
  };

  const touch = (id: string) => {
    const now = Date.now();
    prune(now);
    let current = seen.get(id);
    if (!current) {
      current = { complete: false, jobs: new Set<string>(), updatedAt: now };
      seen.set(id, current);
    }
    current.updatedAt = now;
    return current;
  };

  return {
    seen: (id) => {
      const entry = seen.get(id);
      if (!entry) return false;
      if (Date.now() - entry.updatedAt > retentionMs) return false;
      return entry.complete === true;
    },
    mark: (id) => {
      touch(id).complete = true;
      persist();
    },
    completedJobs: (id) => new Set(seen.get(id)?.jobs ?? []),
    markJob: (id, jobName) => {
      touch(id).jobs.add(jobName);
      persist();
    },
  };
}

interface RateLimiter {
  take(key: string): boolean;
}

function createMemoryRateLimiter(limit: number, windowMs: number): RateLimiter {
  const buckets = new Map<string, { resetAt: number; count: number }>();
  return {
    take: (key) => {
      const now = Date.now();
      const current = buckets.get(key);
      if (!current || now >= current.resetAt) {
        buckets.set(key, { resetAt: now + windowMs, count: 1 });
        return true;
      }
      if (current.count >= limit) return false;
      current.count += 1;
      return true;
    },
  };
}

function deliveryId(source: WebhookSource, headers: IncomingHttpHeaders, rawBody: Buffer): string {
  const named = source === 'github'
    ? header(headers, 'x-github-delivery')
    : header(headers, 'linear-delivery');
  return `${source}:${named ?? crypto.createHash('sha256').update(rawBody).digest('hex')}`;
}

function sourceFromPath(pathname: string | undefined): WebhookSource | null {
  const match = /^\/hooks\/(github|linear|slack)\/?$/.exec(pathname ?? '');
  return match ? match[1] as WebhookSource : null;
}

async function readRawBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new Error(`payload exceeds ${maxBytes} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export function waitForListening(server: http.Server): Promise<void> {
  // Observe asynchronous bind errors such as EADDRINUSE instead of crashing after startup returns.
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('listening', onListening);
      server.off('error', onError);
    };
    const onListening = () => { cleanup(); resolve(); };
    const onError = (err: Error) => { cleanup(); reject(err); };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

interface WebhookServerOptions {
  port?: number;
  host?: string;
  secrets: WebhookSecrets;
  fire?: FireWebhookOptions;
  onMatch?: (webhook: IncomingWebhook, matchedJobNames: string[], matchedHandlerNames: string[]) => void;
  onDelivery?: (webhook: IncomingWebhook, fired: FiredJob[], handlers: FiredHandler[]) => void;
  onDeliveryError?: (webhook: IncomingWebhook, error: Error) => void;
  deliveryStore?: DeliveryStore;
  rateLimiter?: RateLimiter;
  rateLimitPerMinute?: number;
  maxBodyBytes?: number;
  ipRateLimiter?: RateLimiter;
  ipRateLimitPerMinute?: number;
  maxConnections?: number;
}

export function startWebhookServer(options: WebhookServerOptions): http.Server {
  const deliveryStore = options.deliveryStore ?? createMemoryDeliveryStore();
  const inFlight = new Set<string>();
  const rateLimiter = options.rateLimiter ?? createMemoryRateLimiter(options.rateLimitPerMinute ?? 60, 60_000);
  const ipRateLimiter = options.ipRateLimiter ?? createMemoryRateLimiter(options.ipRateLimitPerMinute ?? 120, 60_000);
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;

  async function settleDelivery(webhook: IncomingWebhook, id: string): Promise<void> {
    const { source, event: webhookEvent } = webhook;
    try {
      const context = buildWebhookContext(webhook);
      const fireOptions = options.fire ?? {};

      const matchedJobs = matchJobsToWebhook(fireOptions.jobs ?? listJobs(), webhook);
      const matchedHandlers = listHandlers().filter((handler) => handlerMatchesWebhook(handler, webhook));
      options.onMatch?.(webhook, matchedJobs.map((job) => job.name), matchedHandlers.map((handler) => handler.name));

      const firedJobs = await fireWebhookJobs(webhook, {
        ...fireOptions,
        jobs: matchedJobs,
        context,
        skipJobNames: deliveryStore.completedJobs(id),
        onJobFired: (job, firedJob) => {
          emit('webhook.fired', { source, event: webhookEvent, deliveryId: id, jobName: job.name, runId: firedJob.runId });
          deliveryStore.markJob(id, job.name);
          fireOptions.onJobFired?.(job, firedJob);
        },
      });

      const firedHandlers: FiredHandler[] = [];
      const handlerErrors: { handlerName: string; error: string }[] = [];
      await Promise.allSettled(
        matchedHandlers.map(async (handler) => {
          if (deliveryStore.completedJobs(id).has(handler.name)) return;
          emit('webhook.matched', { source, event: webhookEvent, deliveryId: id, handlerName: handler.name });
          try {
            const result = await executeHandler(handler, webhook);
            deliveryStore.markJob(id, handler.name);
            firedHandlers.push(result);
          } catch (err) {
            handlerErrors.push({ handlerName: handler.name, error: (err as Error).message });
          }
        }),
      );

      deliveryStore.mark(id);
      for (const failure of handlerErrors) {
        emit('webhook.failed', { source, event: webhookEvent, deliveryId: id, handlerName: failure.handlerName, error: failure.error });
      }
      options.onDelivery?.(webhook, firedJobs, firedHandlers);
    } catch (err) {
      const error = err as Error;
      emit('webhook.failed', { source, event: webhookEvent, deliveryId: id, error: error.message });
      options.onDeliveryError?.(webhook, error);
    }
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain' });
        res.end('method not allowed');
        return;
      }

      const source = sourceFromPath(req.url?.split('?')[0]);
      if (!source) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }

      const secret = options.secrets[source];
      if (!secret) {
        emit('webhook.rejected', { source, reason: 'missing webhook secret' });
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `missing ${source} webhook secret` }));
        return;
      }

      const ip = req.socket.remoteAddress ?? 'unknown';
      if (!ipRateLimiter.take(ip)) {
        emit('webhook.rejected', { source, reason: 'ip rate limit exceeded' });
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'rate limit exceeded' }));
        return;
      }
      const declaredLength = Number.parseInt(header(req.headers, 'content-length') ?? '', 10);
      if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
        emit('webhook.rejected', { source, reason: 'payload too large' });
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `payload exceeds ${maxBodyBytes} bytes` }));
        return;
      }

      try {
        const rawBody = await readRawBody(req, maxBodyBytes);
        const valid = source === 'github'
          ? verifyGithubSignature(req.headers, rawBody, secret)
          : source === 'linear'
            ? verifyLinearSignature(req.headers, rawBody, secret)
            : verifySlackSignature(req.headers, rawBody, secret);
        if (!valid) {
          emit('webhook.rejected', { source, reason: 'invalid signature' });
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid signature' }));
          return;
        }

        if (source === 'slack') {
          const slack = parseSlackBody(header(req.headers, 'content-type'), rawBody);
          if (slack.type === 'url_verification') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ challenge: slack.challenge ?? '' }));
            return;
          }
          const slackEvent = slackEventName(slack);
          const slackId = `slack:${slack.event_id ?? crypto.createHash('sha256').update(rawBody).digest('hex')}`;
          emit('webhook.received', { source, event: slackEvent, deliveryId: slackId });

          // Suppress retries both after durable completion and while this process is still dispatching.
          if (deliveryStore.seen(slackId) || inFlight.has(slackId)) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, duplicate: true }));
            return;
          }
          if (!rateLimiter.take(source)) {
            emit('webhook.rejected', { source, event: slackEvent, deliveryId: slackId, reason: 'rate limit exceeded' });
            res.writeHead(429, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'rate limit exceeded' }));
            return;
          }

          const slackWebhook: IncomingWebhook = { source, event: slackEvent, payload: slack };
          emit('webhook.authorized', { source, event: slackEvent, deliveryId: slackId });

          // Slack must be acknowledged before slow dispatch or it retries the accepted delivery.
          inFlight.add(slackId);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            slack.type === 'slash_command'
              ? JSON.stringify({ response_type: 'ephemeral', text: 'On it — replying in this channel.' })
              : '',
          );
          void settleDelivery(slackWebhook, slackId).finally(() => inFlight.delete(slackId));
          return;
        }

        const id = deliveryId(source, req.headers, rawBody);
        const event = source === 'github' ? (header(req.headers, 'x-github-event') ?? '') : '';
        emit('webhook.received', { source, event, deliveryId: id });

        // The in-flight guard closes the window before durable completion is recorded.
        if (deliveryStore.seen(id) || inFlight.has(id)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, duplicate: true, fired: [] }));
          return;
        }

        const payload = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf-8')) as Record<string, unknown> : {};
        const webhookEvent = source === 'github' ? event : String(payload.type ?? '');
        if (source === 'linear' && !verifyLinearTimestamp(payload)) {
          emit('webhook.rejected', { source, event: webhookEvent, deliveryId: id, reason: 'stale linear webhook timestamp' });
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'stale linear webhook timestamp' }));
          return;
        }

        if (!rateLimiter.take(source)) {
          emit('webhook.rejected', { source, event: webhookEvent, deliveryId: id, reason: 'rate limit exceeded' });
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'rate limit exceeded' }));
          return;
        }

        const webhook: IncomingWebhook = {
          source,
          event: webhookEvent,
          payload,
        };
        emit('webhook.authorized', { source, event: webhookEvent, deliveryId: id });

        // Acknowledge providers before slow work; settleDelivery records durable completion later.
        inFlight.add(id);
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, accepted: true, deliveryId: id }));

        void settleDelivery(webhook, id).finally(() => inFlight.delete(id));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
    })();
  });

  server.maxConnections = options.maxConnections ?? 256;

  server.listen(options.port ?? 0, options.host ?? '127.0.0.1');
  return server;
}
