
import type {
  GithubJobTrigger,
  JobConfig,
  LinearJobTrigger,
  RunMeta,
} from '../scheduling/routines.js';
import { jobRunsOnThisDevice, listJobs } from '../scheduling/routines.js';
import { executeJobDetached } from '../daemon/runner.js';
import { emit } from '../feed/events.js';

export type WebhookSource = 'github' | 'linear';

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
  const matched = matchJobsToWebhook(jobs, webhook);

  const fired: FiredJob[] = [];
  const failures: { jobName: string; error: Error }[] = [];
  for (const job of matched) {
    emit('webhook.matched', { source: webhook.source, event: webhook.event, jobName: job.name });
    try {
      const meta = await dispatch(job);
      const firedJob = { jobName: job.name, runId: meta.runId };
      fired.push(firedJob);
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
