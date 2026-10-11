import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobConfig, RunMeta } from '../scheduling/routines.js';
import {
  matchJobsToWebhook,
  jobMatchesWebhook,
  webhookRepo,
  webhookBranches,
  fireWebhookJobs,
  type IncomingWebhook,
} from './webhook.js';
import * as activation from '../routine-activation.js';

beforeEach(() => {
  vi.spyOn(activation, 'routineEnabledOnThisDevice').mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function job(partial: Partial<JobConfig> & Pick<JobConfig, 'name'>): JobConfig {
  return {
    agent: 'claude',
    mode: 'plan',
    effort: 'auto',
    timeout: '10m',
    enabled: true,
    prompt: 'do the thing',
    ...partial,
  } as JobConfig;
}

function pullRequestWebhook(repoFullName: string, baseRef = 'main', headRef = 'feature'): IncomingWebhook {
  return {
    source: 'github',
    event: 'pull_request',
    payload: {
      action: 'opened',
      repository: { full_name: repoFullName },
      pull_request: { base: { ref: baseRef }, head: { ref: headRef } },
    },
  };
}

function labeledPullRequestWebhook(repoFullName: string, label: string, action = 'labeled'): IncomingWebhook {
  return {
    source: 'github',
    event: 'pull_request',
    payload: {
      action,
      repository: { full_name: repoFullName },
      label: { name: label },
      pull_request: {
        base: { ref: 'main' },
        head: { ref: 'feature' },
        labels: [{ name: label }],
      },
    },
  };
}

function pushWebhook(repoFullName: string, ref = 'refs/heads/main'): IncomingWebhook {
  return {
    source: 'github',
    event: 'push',
    payload: { repository: { full_name: repoFullName }, ref },
  };
}

function linearIssueWebhook(labels: string[] = ['agent']): IncomingWebhook {
  return {
    source: 'linear',
    event: 'Issue',
    payload: {
      type: 'Issue',
      action: 'update',
      webhookTimestamp: Date.now(),
      data: {
        identifier: 'RUSH-1459',
        state: { name: 'Plan' },
        labels: labels.map((name) => ({ id: `lbl-${name}`, name })),
      },
      updatedFrom: {
        state: { name: 'Triage' },
      },
    },
  };
}

describe('matchJobsToWebhook', () => {
  const prJob = job({
    name: 'pr-job',
    trigger: { type: 'github_event', event: 'pull_request', repo: 'x/y' },
  });

  it('selects a job whose trigger matches the pull_request event + repo', () => {
    const matched = matchJobsToWebhook([prJob], pullRequestWebhook('x/y'));
    expect(matched.map((j) => j.name)).toEqual(['pr-job']);
  });

  it('does NOT match a push payload against a pull_request trigger', () => {
    const matched = matchJobsToWebhook([prJob], pushWebhook('x/y'));
    expect(matched).toEqual([]);
  });

  it('does NOT match a pull_request payload for a different repo', () => {
    const matched = matchJobsToWebhook([prJob], pullRequestWebhook('a/b'));
    expect(matched).toEqual([]);
  });

  it('leaves a time-based (schedule-only) job unaffected by any webhook', () => {
    const cronJob = job({ name: 'nightly', schedule: '0 3 * * *' });
    expect(matchJobsToWebhook([cronJob], pullRequestWebhook('x/y'))).toEqual([]);
    expect(matchJobsToWebhook([cronJob], pushWebhook('x/y'))).toEqual([]);
  });

  it('matches a repo-agnostic trigger (no repo filter) against any repo', () => {
    const anyRepo = job({ name: 'any', trigger: { type: 'github_event', event: 'pull_request' } });
    expect(matchJobsToWebhook([anyRepo], pullRequestWebhook('who/ever')).map((j) => j.name)).toEqual(['any']);
  });

  it('honors a branch filter (base or head ref)', () => {
    const mainOnly = job({
      name: 'main-only',
      trigger: { type: 'github_event', event: 'pull_request', repo: 'x/y', branch: 'main' },
    });
    expect(jobMatchesWebhook(mainOnly, pullRequestWebhook('x/y', 'main', 'topic'))).toBe(true);
    expect(jobMatchesWebhook(mainOnly, pullRequestWebhook('x/y', 'develop', 'topic'))).toBe(false);
  });

  it('honors a branch filter for push (refs/heads/<b>)', () => {
    const mainOnly = job({
      name: 'push-main',
      trigger: { type: 'github_event', event: 'push', repo: 'x/y', branch: 'main' },
    });
    expect(jobMatchesWebhook(mainOnly, pushWebhook('x/y', 'refs/heads/main'))).toBe(true);
    expect(jobMatchesWebhook(mainOnly, pushWebhook('x/y', 'refs/heads/dev'))).toBe(false);
  });

  it('honors GitHub pull_request action and label filters', () => {
    const uxApproved = job({
      name: 'ux-tests',
      trigger: { type: 'github_event', event: 'pull_request', repo: 'x/y', action: 'labeled', label: 'ux-approved' },
    });

    expect(jobMatchesWebhook(uxApproved, labeledPullRequestWebhook('x/y', 'ux-approved'))).toBe(true);
    expect(jobMatchesWebhook(uxApproved, labeledPullRequestWebhook('x/y', 'bug'))).toBe(false);
    expect(jobMatchesWebhook(uxApproved, labeledPullRequestWebhook('x/y', 'ux-approved', 'opened'))).toBe(false);
  });

  it('skips disabled jobs', () => {
    const disabled = job({
      name: 'off',
      enabled: false,
      trigger: { type: 'github_event', event: 'pull_request', repo: 'x/y' },
    });
    expect(matchJobsToWebhook([disabled], pullRequestWebhook('x/y'))).toEqual([]);
  });

  it('matches Linear issue triggers by action, team key, and label', () => {
    const linear = job({
      name: 'linear-agent',
      trigger: { type: 'linear_event', event: 'Issue', action: 'update', teamKey: 'RUSH', label: 'agent' },
    });
    expect(jobMatchesWebhook(linear, linearIssueWebhook(['agent']))).toBe(true);
    expect(jobMatchesWebhook(linear, linearIssueWebhook(['triage']))).toBe(false);
  });

  it('matches Linear stateTo and stateFrom filters', () => {
    const linear = job({
      name: 'linear-state',
      trigger: { type: 'linear_event', event: 'Issue', action: 'update', stateTo: 'Plan', stateFrom: 'Triage' },
    });
    expect(jobMatchesWebhook(linear, linearIssueWebhook(['agent']))).toBe(true);

    const wrongTo = linearIssueWebhook(['agent']);
    (wrongTo.payload.data as Record<string, unknown>).state = { name: 'Done' };
    expect(jobMatchesWebhook(linear, wrongTo)).toBe(false);

    const wrongFrom = linearIssueWebhook(['agent']);
    wrongFrom.payload.updatedFrom = { state: { name: 'Backlog' } };
    expect(jobMatchesWebhook(linear, wrongFrom)).toBe(false);
  });

  it('does not re-fire a stateTo trigger on a later non-state update (RUSH-2539)', () => {
    const linear = job({
      name: 'linear-plan',
      trigger: { type: 'linear_event', event: 'Issue', action: 'update', stateTo: 'Plan' },
    });
    expect(jobMatchesWebhook(linear, linearIssueWebhook(['agent']))).toBe(true);
    const viaStateId = linearIssueWebhook(['agent']);
    viaStateId.payload.updatedFrom = { stateId: 'old-state-id' };
    expect(jobMatchesWebhook(linear, viaStateId)).toBe(true);
    const nonState = linearIssueWebhook(['agent']);
    nonState.payload.updatedFrom = { labelIds: ['x'] };
    expect(jobMatchesWebhook(linear, nonState)).toBe(false);
    const noUpdatedFrom = linearIssueWebhook(['agent']);
    delete (noUpdatedFrom.payload as Record<string, unknown>).updatedFrom;
    expect(jobMatchesWebhook(linear, noUpdatedFrom)).toBe(false);
  });

  it('reads labels from the flat webhook array, not a {nodes} connection', () => {
    const linear = job({
      name: 'linear-agent',
      trigger: { type: 'linear_event', event: 'Issue', action: 'update', teamKey: 'RUSH', label: 'agent' },
    });
    const staleConnectionShape: IncomingWebhook = {
      source: 'linear',
      event: 'Issue',
      payload: {
        type: 'Issue',
        action: 'update',
        data: { identifier: 'RUSH-1459', labels: { nodes: [{ name: 'agent' }] } },
      },
    };
    expect(jobMatchesWebhook(linear, staleConnectionShape)).toBe(false);
  });

  it('skips jobs pinned to other devices, keeps jobs pinned here', () => {
    const saved = process.env.AGENTS_SYNC_MACHINE_ID;
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    try {
      const foreign = job({
        name: 'foreign',
        devices: ['yosemite-s0'],
        trigger: { type: 'github_event', event: 'pull_request', repo: 'x/y' },
      });
      const local = job({
        name: 'local',
        devices: ['zion'],
        trigger: { type: 'github_event', event: 'pull_request', repo: 'x/y' },
      });
      const multi = job({
        name: 'multi',
        devices: ['mac-mini', 'zion'],
        trigger: { type: 'github_event', event: 'pull_request', repo: 'x/y' },
      });
      expect(matchJobsToWebhook([foreign, local, multi], pullRequestWebhook('x/y')).map((j) => j.name)).toEqual(['local']);
    } finally {
      if (saved === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
      else process.env.AGENTS_SYNC_MACHINE_ID = saved;
    }
  });
});

describe('payload extraction helpers', () => {
  it('reads repository.full_name', () => {
    expect(webhookRepo({ repository: { full_name: 'x/y' } })).toBe('x/y');
    expect(webhookRepo({})).toBeNull();
  });

  it('extracts branches per event type', () => {
    expect(webhookBranches('push', { ref: 'refs/heads/main' })).toEqual(['main']);
    expect(
      webhookBranches('pull_request', { pull_request: { base: { ref: 'main' }, head: { ref: 'feat' } } }).sort(),
    ).toEqual(['feat', 'main']);
    expect(webhookBranches('workflow_run', { workflow_run: { head_branch: 'release' } })).toEqual(['release']);
    expect(webhookBranches('issue_comment', {})).toEqual([]);
  });
});

describe('fireWebhookJobs', () => {
  it('dispatches each matched job through the injected dispatch path, not schedule-only jobs', async () => {
    const jobs: JobConfig[] = [
      job({ name: 'pr-job', trigger: { type: 'github_event', event: 'pull_request', repo: 'x/y' } }),
      job({ name: 'nightly', schedule: '0 3 * * *' }),
    ];
    const dispatched: string[] = [];
    const dispatch = async (config: JobConfig): Promise<RunMeta> => {
      dispatched.push(config.name);
      return {
        jobName: config.name,
        runId: `run-${config.name}`,
        agent: config.agent,
        pid: 1234,
        status: 'running',
        startedAt: new Date().toISOString(),
        completedAt: null,
        exitCode: null,
      };
    };

    const fired = await fireWebhookJobs(pullRequestWebhook('x/y'), { jobs, dispatch });

    expect(dispatched).toEqual(['pr-job']);
    expect(fired).toEqual([{ jobName: 'pr-job', runId: 'run-pr-job' }]);
  });
});
