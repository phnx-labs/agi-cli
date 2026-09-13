/**
 * Public webhook trigger receiver for routines.
 *
 * A routine may declare a `trigger` block instead of (or alongside) a cron
 * `schedule` (see `JobConfig.trigger` in `../routines.ts`). This module turns
 * incoming GitHub or Linear webhooks into the set of routines they should fire,
 * and dispatches those routines through the exact same path a cron fire uses
 * (`executeJobDetached`).
 *
 * The matching logic is pure, so it can be unit-tested without a daemon or HTTP
 * server. The listener adds the public-ingress requirements: raw-body HMAC
 * verification, idempotency, source allow-listing, and rate limiting.
 */

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
  /** Delivery source, derived from `/hooks/<source>` or one-shot command flags. */
  source: WebhookSource;
  /** Source event name: GitHub header event, Linear payload `type`, or the Slack
   *  event subtype (`app_mention`) / slash command (`/agents`). */
  event: string;
  /** Decoded request body (JSON for GitHub/Linear/Slack-events; the normalized
   *  {@link SlackPayload} for a Slack slash command's form body). */
  payload: Record<string, unknown>;
}

/** Read `repository.full_name` (`owner/name`) from a webhook payload, if present. */
export function webhookRepo(payload: Record<string, unknown>): string | null {
  const repo = payload?.repository as { full_name?: unknown } | undefined;
  const fullName = repo?.full_name;
  return typeof fullName === 'string' && fullName.length > 0 ? fullName : null;
}

/** Strip a `refs/heads/` (or `refs/tags/`) prefix to the short branch/tag name. */
function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, '');
}

/**
 * Extract every candidate branch a webhook payload references, per event type.
 * A trigger's `branch` matches if it equals any of these. Different events
 * carry the branch in different places:
 *   - push:          `ref` (refs/heads/<b>)
 *   - pull_request:  base + head refs of the PR
 *   - workflow_run:  `workflow_run.head_branch`
 *   - issue_comment: no branch (comments aren't branch-scoped)
 */
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
  // Linear webhook bodies flatten list relations: an Issue event carries
  // `data.labels` as a flat array of label objects (`[{ id, name, color }]`),
  // NOT the `{ nodes: [...] }` connection shape returned by the GraphQL API.
  // Reading `.nodes` here made every `--label` filter match nothing.
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
    // RUSH-2539: `stateTo` is a TRANSITION predicate, not a current-state one.
    // Linear carries the prior value of each changed field in `updatedFrom`, so a
    // real state change has `updatedFrom.state` (this codebase's shape) or
    // `updatedFrom.stateId` (Linear's scalar). With neither, this Issue/update
    // touched something else while the issue merely still sits in `stateTo` —
    // matching there re-fires on every later edit (RUSH-1459 got 11 duplicate
    // plan comments).
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

/** True when a single job's trigger matches the given webhook. Pure. */
export function jobMatchesWebhook(job: JobConfig, webhook: IncomingWebhook): boolean {
  const trigger = job.trigger;
  if (!trigger) return false;
  if (trigger.type === 'github_event') return githubTriggerMatches(trigger, webhook);
  if (trigger.type === 'linear_event') return linearTriggerMatches(trigger, webhook);
  return false;
}

/**
 * Pure matcher: given a set of jobs and an incoming webhook, return the jobs
 * whose `trigger` matches. Jobs without a trigger (schedule-only routines) are
 * never selected — proving time-based jobs are unaffected by webhook delivery.
 */
export function matchJobsToWebhook(jobs: JobConfig[], webhook: IncomingWebhook): JobConfig[] {
  return jobs.filter((job) => job.enabled !== false && jobRunsOnThisDevice(job) && jobMatchesWebhook(job, webhook));
}

/** Options for firing webhook-matched jobs (dispatch is injectable for tests). */
export interface FireWebhookOptions {
  /** Job source. Defaults to all persisted routines (`listJobs()`). */
  jobs?: JobConfig[];
  /**
   * How to dispatch a matched job. Defaults to `executeJobDetached` — the SAME
   * path a cron fire uses (see `daemon.ts`). Injectable so tests can assert
   * matching without spawning real agent processes.
   */
  dispatch?: (config: JobConfig) => Promise<RunMeta>;
  /** Matched job names that already completed for this delivery. */
  skipJobNames?: ReadonlySet<string>;
  /** Called immediately after a single matched job dispatch succeeds. */
  onJobFired?: (job: JobConfig, fired: FiredJob) => void;
  /** Optional webhook context used to expand `{{...}}` placeholders in prompts. */
  context?: WebhookContext;
}

/** Result of firing one matched job. */
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

/**
 * Match an incoming webhook against the persisted routines and fire each match
 * through the cron dispatch path. Returns one entry per fired job.
 */
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

/**
 * Verify a Slack request signature (the `v0` scheme). Slack signs the base
 * string `v0:${timestamp}:${rawBody}` with the app's signing secret and sends
 * the hex digest as `X-Slack-Signature: v0=<hex>`, alongside the unix
 * `X-Slack-Request-Timestamp`. The timestamp is BOTH part of the signed base
 * string AND checked for freshness here — a request older than `toleranceSec`
 * (default 5 min) is rejected, so a captured, correctly-signed body cannot be
 * replayed later. Fails closed on any missing/malformed header.
 */
export function verifySlackSignature(
  headers: IncomingHttpHeaders,
  rawBody: Buffer,
  secret: string,
  now: number = Date.now(),
  toleranceSec = 300,
): boolean {
  const ts = header(headers, 'x-slack-request-timestamp');
  if (!ts || !/^\d+$/.test(ts)) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(ts)) > toleranceSec) return false;
  const received = header(headers, 'x-slack-signature');
  const signature = received?.startsWith('v0=') ? received.slice('v0='.length) : undefined;
  // Concatenate the base-string prefix with the raw body bytes so a non-ASCII
  // payload hashes identically to Slack's own `v0:${ts}:${body}` string.
  const base = Buffer.concat([Buffer.from(`v0:${ts}:`, 'utf-8'), rawBody]);
  const expected = crypto.createHmac('sha256', secret).update(base).digest('hex');
  return timingSafeHexEqual(signature, expected);
}

/**
 * Normalized fields extracted from a Slack slash-command or Events API delivery.
 * This is the `payload` of a Slack {@link IncomingWebhook}: transport-level
 * parsing lives here, message *semantics* (splitting the mention text into an
 * agent / project / prompt) live in `handlers.ts` `buildWebhookContext`.
 */
export interface SlackPayload extends Record<string, unknown> {
  /** `url_verification` | `event_callback` | `slash_command`. */
  type: string;
  /** Echoed back for the one-time Events API URL-verification handshake. */
  challenge?: string;
  /** Slack event id (Events API) — the dedup key when present. */
  event_id?: string;
  /** Event subtype, e.g. `app_mention` (Events API). */
  event_type?: string;
  /** Raw message text (the mention body, or the slash-command text). */
  text?: string;
  /** Channel id (`C0…`) the message arrived in. */
  channel?: string;
  /** Thread to reply into: an existing thread's parent ts, else the message ts. */
  thread_ts?: string;
  /** Invoking user id (`U0…`). */
  user?: string;
  /** Slash command name, e.g. `/agents`. */
  command?: string;
  /** Slash-command `response_url` (valid ~30 min, 5 uses). */
  response_url?: string;
  /** Slack team / workspace id. */
  team?: string;
}

/**
 * Parse a Slack delivery body into a normalized {@link SlackPayload}. Slack
 * sends slash commands as `application/x-www-form-urlencoded` and Events API
 * deliveries (including the `url_verification` handshake) as
 * `application/json` — this is the one place that content-type branch lives.
 */
export function parseSlackBody(contentType: string | undefined, rawBody: Buffer): SlackPayload {
  if ((contentType ?? '').includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(rawBody.toString('utf-8'));
    // A slash command carries no thread; its reply posts to the channel.
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

/** The `event` name a Slack delivery fires under: the slash command, or the event subtype. */
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

/** Serialized shape of one durable delivery record on disk. */
interface PersistedDelivery {
  complete: boolean;
  jobs: string[];
  updatedAt: number;
}

/**
 * A durable, disk-backed delivery store. Unlike `createMemoryDeliveryStore`,
 * seen delivery ids survive a process restart and are bounded by AGE, not by a
 * fixed entry count — so a captured valid delivery cannot re-fire after a
 * restart or after count-based LRU eviction would have dropped it.
 *
 * `retentionMs` doubles as the replay-acceptance window: a delivery whose id is
 * still on record (younger than the window) is rejected as a duplicate; entries
 * older than the window are pruned (keeping the file bounded) since a webhook
 * source will not legitimately retry a delivery that old.
 */
export function createFileDeliveryStore(
  filePath: string,
  retentionMs = 14 * 24 * 60 * 60 * 1000,
): DeliveryStore {
  const seen = new Map<string, { complete: boolean; jobs: Set<string>; updatedAt: number }>();

  // Load persisted state (best-effort: a corrupt/missing file starts empty).
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
    // no prior file / unreadable — start empty
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
      // best-effort durability; an unwritable dir must not crash ingress
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

/**
 * Resolve once a receiver is actually accepting connections, REJECT if the bind
 * failed. `server.listen()` reports a bind failure (EADDRINUSE, EACCES) as an
 * asynchronous `'error'` event, never a throw — so a `try/catch` around
 * `startWebhookServer` cannot see it, and without this the event reaches Node's
 * default handler and takes the whole process down. Every caller that hosts a
 * receiver MUST await this rather than assuming the return means "bound".
 */
export function waitForListening(server: http.Server): Promise<void> {
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

/** Options for the local webhook http listener. */
interface WebhookServerOptions {
  port?: number;
  host?: string;
  /** HMAC signing secrets keyed by source. */
  secrets: WebhookSecrets;
  /** Override the fire options (mainly for tests). */
  fire?: FireWebhookOptions;
  /**
   * Called the moment a delivery's matches are known — BEFORE any routine or
   * handler is dispatched. Matching is a pure, synchronous lookup (no I/O), so
   * this fires immediately after the ack, regardless of how long the matched
   * work then takes to run. This is the right hook for a "webhook X fired Y"
   * log line: a `run.command` handler that shells out a long agent session
   * (`exec()`, which only resolves on process exit) used to hold that log back
   * for as long as the session ran — `ps` would show the agent already running
   * while the log still implied nothing had matched (RUSH-2722). Names only
   * (no runId/exitCode yet — those aren't known until dispatch settles).
   */
  onMatch?: (webhook: IncomingWebhook, matchedJobNames: string[], matchedHandlerNames: string[]) => void;
  /**
   * Called after a delivery has fully settled — every matched routine and
   * handler dispatched (and, for `run.command` handlers, exited). Because the
   * receiver acks the HTTP response BEFORE dispatch (see `startWebhookServer`),
   * this fires strictly after the response has been written, and is the only
   * way a caller observes the dispatch outcome (runId/exitCode/output). It is
   * NOT the right hook for "did this webhook match" logging — use `onMatch`.
   */
  onDelivery?: (webhook: IncomingWebhook, fired: FiredJob[], handlers: FiredHandler[]) => void;
  /**
   * Called when settling an already-acked delivery threw. The HTTP status can
   * no longer carry the failure, so this is the loud path — the daemon host and
   * `agents webhooks serve` both log it. Never swallowed silently.
   */
  onDeliveryError?: (webhook: IncomingWebhook, error: Error) => void;
  deliveryStore?: DeliveryStore;
  rateLimiter?: RateLimiter;
  rateLimitPerMinute?: number;
  maxBodyBytes?: number;
  /** Per-IP ingress throttle applied BEFORE the body read (bad-sig flood guard). */
  ipRateLimiter?: RateLimiter;
  /** Per-source-IP requests/minute allowed through to the body read. Default 120. */
  ipRateLimitPerMinute?: number;
  /** Max concurrent TCP connections the receiver accepts. Default 256. */
  maxConnections?: number;
}

/**
 * Start a localhost-bound receiver. It accepts only:
 *   POST /hooks/github  with X-Hub-Signature-256
 *   POST /hooks/linear  with Linear-Signature + fresh webhookTimestamp
 *   POST /hooks/slack   with X-Slack-Signature + fresh X-Slack-Request-Timestamp
 *
 * **The ack is asynchronous (RUSH-2548).** Once a delivery has passed signature
 * verification, freshness, dedup, and rate limiting, the receiver writes
 * `202 {ok:true, accepted:true}` IMMEDIATELY and dispatches the matched routines
 * and handlers afterwards. Dispatch starts an agent run and takes 15-20s, which
 * exceeds Linear's delivery timeout — holding the socket open across it made
 * every real delivery log a timeout + retry on Linear's side. Nothing about the
 * dedup ledger changes: the `<source>:<delivery-id>` key is still what makes a
 * retry a no-op, per-job `markJob` still lets a retry finish only the matches
 * that failed, and the delivery is marked complete only after it settles.
 *
 * A retry that lands WHILE the first is still settling is answered as a
 * duplicate from an in-flight set, since `deliveryStore.seen` only reports
 * completed deliveries and would otherwise let a mid-flight retry double-fire.
 *
 * `onMatch` fires as soon as matching is known, before any dispatch; `onDelivery`
 * fires only once every matched routine/handler has settled — see their docs on
 * `WebhookServerOptions`. A caller that wants a prompt "this fired" log uses
 * `onMatch`, not `onDelivery` (RUSH-2722).
 *
 * Returns the underlying server so callers can `close()` it.
 */
export function startWebhookServer(options: WebhookServerOptions): http.Server {
  const deliveryStore = options.deliveryStore ?? createMemoryDeliveryStore();
  /** Delivery ids acked but not yet settled — dedup across the async window. */
  const inFlight = new Set<string>();
  const rateLimiter = options.rateLimiter ?? createMemoryRateLimiter(options.rateLimitPerMinute ?? 60, 60_000);
  const ipRateLimiter = options.ipRateLimiter ?? createMemoryRateLimiter(options.ipRateLimitPerMinute ?? 120, 60_000);
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;

  /**
   * Dispatch an already-acked delivery: matched routines first, then matched
   * handlers, then mark the delivery complete. A failure leaves the delivery
   * UNMARKED (its per-job `markJob` entries survive), so a later retry of the
   * same delivery id re-runs only what did not complete — the same partial-retry
   * ledger the synchronous receiver had, minus the 4xx that used to request it.
   */
  async function settleDelivery(webhook: IncomingWebhook, id: string): Promise<void> {
    const { source, event: webhookEvent } = webhook;
    try {
      const context = buildWebhookContext(webhook);
      const fireOptions = options.fire ?? {};

      // Match FIRST, before any dispatch — matching is a pure in-memory lookup,
      // so this is the earliest point the receiver knows what fired, and the
      // right time to log it (RUSH-2722). Dispatching a `run.command` handler
      // can then block on the shelled-out process for minutes; that must never
      // hold the "fired" log back with it.
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

      // Per-IP throttle + declared-size cap BEFORE the (expensive) body read +
      // HMAC. A bad-signature flood of 1 MiB POSTs must be rejected without
      // forcing a full body read and an HMAC per request — the signed-delivery
      // rate limit further down runs only after a signature passes, so it can't
      // shed this load on its own.
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

        // Slack diverges from the GitHub/Linear JSON path: two content-types
        // (slash = form, events = JSON), a one-time url_verification handshake,
        // a body-carried event id, and a 200 ack Slack shows to the caller.
        if (source === 'slack') {
          const slack = parseSlackBody(header(req.headers, 'content-type'), rawBody);
          // One-time Events API URL handshake: echo the challenge, dispatch nothing.
          if (slack.type === 'url_verification') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ challenge: slack.challenge ?? '' }));
            return;
          }
          const slackEvent = slackEventName(slack);
          // Slash commands carry no event_id, so fall back to a body hash for dedup.
          const slackId = `slack:${slack.event_id ?? crypto.createHash('sha256').update(rawBody).digest('hex')}`;
          emit('webhook.received', { source, event: slackEvent, deliveryId: slackId });

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

          // ACK FIRST (RUSH-2548): a 200 inside Slack's 3s window. A slash
          // command renders the ack text to the caller; an event delivery
          // ignores the body. Dispatch outlives the ack, same as GitHub/Linear.
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

        // ACK FIRST (RUSH-2548). Everything that could reject this delivery has
        // run; what remains starts agent runs and outlives any sender timeout.
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

  // Connection cap: bound how many concurrent TCP connections the receiver
  // will hold open, so a flood cannot exhaust file descriptors / memory.
  server.maxConnections = options.maxConnections ?? 256;

  server.listen(options.port ?? 0, options.host ?? '127.0.0.1');
  return server;
}
