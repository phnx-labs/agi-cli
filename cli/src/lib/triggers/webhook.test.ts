import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import type { JobConfig, RunMeta, WebhookContext } from '../scheduling/routines.js';
import {
  matchJobsToWebhook,
  jobMatchesWebhook,
  webhookRepo,
  webhookBranches,
  fireWebhookJobs,
  verifyGithubSignature,
  verifyLinearSignature,
  verifySlackSignature,
  parseSlackBody,
  slackEventName,
  startWebhookServer,
  createFileDeliveryStore,
  type IncomingWebhook,
} from './webhook.js';
import * as activation from '../routine-activation.js';

beforeEach(() => {
  vi.spyOn(activation, 'routineEnabledOnThisDevice').mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Build a JobConfig with sensible defaults for tests. */
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

/** A realistic `pull_request` webhook for repo x/y targeting branch main. */
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

/** A `push` webhook for repo x/y on branch main. */
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
        // Real Linear webhook shape: `data.labels` is a flat array of label
        // objects, NOT the `{ nodes: [...] }` GraphQL connection.
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
    // A schedule-only job has no trigger, so it is never selected — not by the
    // matching event, not by a mismatching one.
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
    // base=develop head=topic → neither is main
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
    // A real transition into Plan (updatedFrom carries the prior state) matches.
    expect(jobMatchesWebhook(linear, linearIssueWebhook(['agent']))).toBe(true);
    // Linear's scalar updatedFrom.stateId also counts as a transition.
    const viaStateId = linearIssueWebhook(['agent']);
    viaStateId.payload.updatedFrom = { stateId: 'old-state-id' };
    expect(jobMatchesWebhook(linear, viaStateId)).toBe(true);
    // A non-state edit while the issue still sits in Plan must NOT match.
    const nonState = linearIssueWebhook(['agent']);
    nonState.payload.updatedFrom = { labelIds: ['x'] };
    expect(jobMatchesWebhook(linear, nonState)).toBe(false);
    // No updatedFrom at all must NOT match.
    const noUpdatedFrom = linearIssueWebhook(['agent']);
    delete (noUpdatedFrom.payload as Record<string, unknown>).updatedFrom;
    expect(jobMatchesWebhook(linear, noUpdatedFrom)).toBe(false);
  });

  it('reads labels from the flat webhook array, not a {nodes} connection', () => {
    // Regression: Linear webhook bodies send `data.labels` as a flat array.
    // Reading `.nodes` (the GraphQL connection shape) made every --label filter
    // match nothing. Lock the flat-array read and prove the stale shape fails.
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
      // 'multi' pins [mac-mini, zion]; mac-mini owns it (lowest normalized
      // name), so a webhook on zion no longer fires it. A routine fires on
      // exactly one device, on the trigger path as on the cron path.
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

  it('substitutes {{...}} placeholders when a webhook context is provided', async () => {
    const linearJob = job({
      name: 'linear-plan',
      trigger: { type: 'linear_event', event: 'Issue', action: 'update' },
      prompt: 'Issue {{issue.identifier}} moved to {{issue.state.name}}.',
    });
    const dispatched: JobConfig[] = [];
    const dispatch = async (config: JobConfig): Promise<RunMeta> => {
      dispatched.push(config);
      return {
        jobName: config.name,
        runId: 'run-1',
        agent: config.agent,
        pid: 1,
        status: 'running',
        startedAt: new Date().toISOString(),
        completedAt: null,
        exitCode: null,
      };
    };
    const webhook = linearIssueWebhook(['agent']);
    await fireWebhookJobs(webhook, {
      jobs: [linearJob],
      dispatch,
      context: {
        source: 'linear',
        event: 'Issue',
        action: 'update',
        issue: webhook.payload.data,
        updatedFrom: webhook.payload.updatedFrom,
      },
    });
    expect(dispatched[0].prompt).toBe('Issue RUSH-1459 moved to Plan.');
  });
});

describe('webhook signature verification', () => {
  it('verifies GitHub and Linear HMAC-SHA256 signatures against the raw body', () => {
    const secret = 'test-secret';
    const raw = Buffer.from(JSON.stringify({ hello: 'world' }));
    const hex = crypto.createHmac('sha256', secret).update(raw).digest('hex');

    expect(verifyGithubSignature({ 'x-hub-signature-256': `sha256=${hex}` }, raw, secret)).toBe(true);
    expect(verifyGithubSignature({ 'x-hub-signature-256': 'sha256=bad' }, raw, secret)).toBe(false);
    expect(verifyLinearSignature({ 'linear-signature': hex }, raw, secret)).toBe(true);
    expect(verifyLinearSignature({ 'linear-signature': 'bad' }, raw, secret)).toBe(false);
  });
});

/** The receiver acks 202 before dispatch (RUSH-2548), so tests wait for the settle callback. `hit`
 * is wired to onDelivery and onDeliveryError so a regression fails instead of hanging. */
function settleWaiter() {
  let settled = 0;
  let waiters: { target: number; release: () => void }[] = [];
  return {
    /** Wire to onDelivery AND onDeliveryError. */
    hit: () => {
      settled += 1;
      waiters = waiters.filter((w) => {
        if (settled < w.target) return true;
        w.release();
        return false;
      });
    },
    /** Resolve once `target` deliveries have settled (already-past targets resolve now). */
    until: (target: number): Promise<void> => (settled >= target
      ? Promise.resolve()
      : new Promise<void>((release) => { waiters.push({ target, release }); })),
  };
}

describe('slack signature verification', () => {
  const secret = 'slack-signing-secret';
  const sign = (ts: string, body: string) =>
    'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');

  it('accepts a fresh v0 signature and rejects a forged one', () => {
    const now = 1_700_000_000_000;
    const ts = String(Math.floor(now / 1000));
    const body = Buffer.from('payload=%7B%7D');
    expect(verifySlackSignature({ 'x-slack-request-timestamp': ts, 'x-slack-signature': sign(ts, body.toString()) }, body, secret, now)).toBe(true);
    expect(verifySlackSignature({ 'x-slack-request-timestamp': ts, 'x-slack-signature': 'v0=deadbeef' }, body, secret, now)).toBe(false);
  });

  it('fails closed on a stale timestamp (replay guard) and on missing/malformed headers', () => {
    const now = 1_700_000_000_000;
    const staleTs = String(Math.floor(now / 1000) - 600); // 10 minutes old
    const body = Buffer.from('x');
    // Correctly signed for the stale ts, but too old → still rejected.
    expect(verifySlackSignature({ 'x-slack-request-timestamp': staleTs, 'x-slack-signature': sign(staleTs, 'x') }, body, secret, now)).toBe(false);
    expect(verifySlackSignature({}, body, secret, now)).toBe(false);
    expect(verifySlackSignature({ 'x-slack-request-timestamp': 'abc', 'x-slack-signature': 'v0=x' }, body, secret, now)).toBe(false);
  });
});

describe('parseSlackBody + slackEventName', () => {
  it('parses a slash command form body (no thread → reply to channel)', () => {
    const body = Buffer.from(new URLSearchParams({
      command: '/agents', text: 'AGI rebase', channel_id: 'C1', user_id: 'U1', response_url: 'https://x', team_id: 'T1',
    }).toString());
    const p = parseSlackBody('application/x-www-form-urlencoded', body);
    expect(p).toMatchObject({ type: 'slash_command', command: '/agents', text: 'AGI rebase', channel: 'C1', user: 'U1', response_url: 'https://x', team: 'T1' });
    expect(p.thread_ts).toBeUndefined();
    expect(slackEventName(p)).toBe('/agents');
  });

  it('parses an app_mention event, threading on ts when no thread_ts', () => {
    const body = Buffer.from(JSON.stringify({
      type: 'event_callback', event_id: 'Ev1', team_id: 'T1',
      event: { type: 'app_mention', text: '<@U0BOT> AGI: rebase', channel: 'C1', user: 'U9', ts: '1712.0001' },
    }));
    const p = parseSlackBody('application/json', body);
    expect(p).toMatchObject({ type: 'event_callback', event_id: 'Ev1', event_type: 'app_mention', channel: 'C1', user: 'U9', thread_ts: '1712.0001' });
    expect(slackEventName(p)).toBe('app_mention');
  });

  it('threads on thread_ts when the mention is already in a thread', () => {
    const body = Buffer.from(JSON.stringify({ type: 'event_callback', event: { type: 'app_mention', text: 'hi', channel: 'C1', ts: '2.0', thread_ts: '1.0' } }));
    expect(parseSlackBody('application/json', body).thread_ts).toBe('1.0');
  });

  it('returns the url_verification challenge', () => {
    const body = Buffer.from(JSON.stringify({ type: 'url_verification', challenge: 'abc123' }));
    expect(parseSlackBody('application/json', body)).toEqual({ type: 'url_verification', challenge: 'abc123' });
  });
});

describe('startWebhookServer — slack', () => {
  const secret = 'slack-signing-secret';
  function slackSend(server: http.Server, body: Buffer, contentType: string, sigOverride?: string): Promise<{ status: number; body: string }> {
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('server did not bind');
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sigOverride ?? 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${body.toString()}`).digest('hex');
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: address.port, path: '/hooks/slack', method: 'POST',
        headers: { 'content-type': contentType, 'content-length': String(body.length), 'x-slack-request-timestamp': ts, 'x-slack-signature': sig },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  it('echoes the url_verification challenge and dispatches nothing', async () => {
    const server = startWebhookServer({
      secrets: { slack: secret },
      fire: { jobs: [], dispatch: async () => { throw new Error('url_verification must not dispatch'); } },
    });
    await new Promise<void>((r) => server.once('listening', r));
    try {
      const body = Buffer.from(JSON.stringify({ type: 'url_verification', challenge: 'abc123' }));
      const res = await slackSend(server, body, 'application/json');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ challenge: 'abc123' });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('rejects a bad slack signature with 401 (fail closed)', async () => {
    const server = startWebhookServer({ secrets: { slack: secret } });
    await new Promise<void>((r) => server.once('listening', r));
    try {
      const body = Buffer.from(JSON.stringify({ type: 'url_verification', challenge: 'x' }));
      const res = await slackSend(server, body, 'application/json', 'v0=bad');
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  // A slash command carries no thread_ts, so the reply lands in the channel, not
  // a thread — the ephemeral ack Slack renders to the caller must say so.
  it('acks a signed slash command with an ephemeral ack naming the channel', async () => {
    const server = startWebhookServer({ secrets: { slack: secret }, fire: { jobs: [] } });
    await new Promise<void>((r) => server.once('listening', r));
    try {
      const body = Buffer.from('command=%2Fagents&text=AGI%3A+rebase&channel_id=C1&user_id=U9&team_id=T1');
      const res = await slackSend(server, body, 'application/x-www-form-urlencoded');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ response_type: 'ephemeral', text: 'On it — replying in this channel.' });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('acks a signed app_mention with 200 (before any dispatch)', async () => {
    const server = startWebhookServer({ secrets: { slack: secret }, fire: { jobs: [] } });
    await new Promise<void>((r) => server.once('listening', r));
    try {
      const body = Buffer.from(JSON.stringify({
        type: 'event_callback', event_id: 'Ev-ack-1',
        event: { type: 'app_mention', text: '<@U0BOT> hello there', channel: 'C1', user: 'U9', ts: '1.0' },
      }));
      const res = await slackSend(server, body, 'application/json');
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('startWebhookServer', () => {
  it('acks a signed delivery before the agent dispatch completes', async () => {
    const secret = 'linear-secret';
    const jobs = [
      job({
        name: 'linear-agent',
        trigger: { type: 'linear_event', event: 'Issue', action: 'update', teamKey: 'RUSH', label: 'agent' },
      }),
    ];
    // A dispatch that completes only when the test says so, standing in for a real 15-20s agent
    // run; if the ack waited on dispatch, this test would time out.
    let signalDispatchStarted!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => { signalDispatchStarted = resolve; });
    let releaseDispatch!: () => void;
    const dispatchDone = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const waiter = settleWaiter();
    let dispatches = 0;
    const server = startWebhookServer({
      secrets: { linear: secret },
      onDelivery: waiter.hit,
      onDeliveryError: waiter.hit,
      fire: {
        jobs,
        dispatch: async (config: JobConfig): Promise<RunMeta> => {
          dispatches += 1;
          signalDispatchStarted();
          await dispatchDone;
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
        },
      },
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('server did not bind');
    try {
      const payload = Buffer.from(JSON.stringify(linearIssueWebhook(['agent']).payload));
      const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      const send = () => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: address.port,
          path: '/hooks/linear',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(payload.length),
            'linear-signature': sig,
            'linear-delivery': 'delivery-async',
          },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
        });
        req.on('error', reject);
        req.end(payload);
      });

      const response = await send();

      // The ack arrived while dispatch is provably still in flight.
      await dispatchStarted;
      expect(response.status).toBe(202);
      expect(JSON.parse(response.body)).toMatchObject({ ok: true, accepted: true, deliveryId: 'linear:delivery-async' });

      // `deliveryStore.seen` reports only completed deliveries, so mid-flight dedup relies on the
      // in-flight set. Retry the same delivery id while dispatch is held open.
      const midFlightRetry = await send();
      expect(midFlightRetry.status).toBe(200);
      expect(JSON.parse(midFlightRetry.body)).toMatchObject({ ok: true, duplicate: true });

      releaseDispatch();
      await waiter.until(1);
      // One dispatch, not two — the retry above was absorbed, not queued behind it.
      expect(dispatches).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects unsigned public deliveries and accepts signed Linear deliveries once', async () => {
    const secret = 'linear-secret';
    const jobs = [
      job({
        name: 'linear-agent',
        trigger: { type: 'linear_event', event: 'Issue', action: 'update', teamKey: 'RUSH', label: 'agent' },
      }),
    ];
    const dispatched: string[] = [];
    const waiter = settleWaiter();
    const server = startWebhookServer({
      secrets: { linear: secret },
      onDelivery: waiter.hit,
      onDeliveryError: waiter.hit,
      fire: {
        jobs,
        dispatch: async (config: JobConfig): Promise<RunMeta> => {
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
        },
      },
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('server did not bind');
    try {
      const payload = Buffer.from(JSON.stringify(linearIssueWebhook(['agent']).payload));
      const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      const send = (headers: Record<string, string>) => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: address.port,
          path: '/hooks/linear',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': String(payload.length), ...headers },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
        });
        req.on('error', reject);
        req.end(payload);
      });

      expect((await send({})).status).toBe(401);
      expect((await send({ 'linear-signature': sig, 'linear-delivery': 'delivery-1' })).status).toBe(202);
      // The delivery is only "seen" once it settles, so wait for that before
      // asserting that a retry of the same id is a duplicate.
      await waiter.until(1);
      const duplicate = await send({ 'linear-signature': sig, 'linear-delivery': 'delivery-1' });
      expect(duplicate.status).toBe(200);
      expect(JSON.parse(duplicate.body).duplicate).toBe(true);
      expect(dispatched).toEqual(['linear-agent']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not burn a delivery id when a signed Linear delivery is stale', async () => {
    const secret = 'linear-secret';
    const jobs = [
      job({
        name: 'linear-agent',
        trigger: { type: 'linear_event', event: 'Issue', action: 'update', teamKey: 'RUSH', label: 'agent' },
      }),
    ];
    const dispatched: string[] = [];
    const waiter = settleWaiter();
    const server = startWebhookServer({
      secrets: { linear: secret },
      onDelivery: waiter.hit,
      onDeliveryError: waiter.hit,
      fire: {
        jobs,
        dispatch: async (config: JobConfig): Promise<RunMeta> => {
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
        },
      },
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('server did not bind');
    try {
      const send = (payload: Buffer, delivery = 'delivery-retry') => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
        const req = http.request({
          host: '127.0.0.1',
          port: address.port,
          path: '/hooks/linear',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(payload.length),
            'linear-signature': sig,
            'linear-delivery': delivery,
          },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
        });
        req.on('error', reject);
        req.end(payload);
      });

      const stale = linearIssueWebhook(['agent']).payload as Record<string, unknown>;
      stale.webhookTimestamp = Date.now() - 120_000;
      expect((await send(Buffer.from(JSON.stringify(stale)))).status).toBe(401);

      const fresh = Buffer.from(JSON.stringify(linearIssueWebhook(['agent']).payload));
      const retry = await send(fresh);
      expect(retry.status).toBe(202);
      expect(JSON.parse(retry.body).duplicate).toBeUndefined();
      await waiter.until(1);
      expect(dispatched).toEqual(['linear-agent']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not let unsigned traffic consume the signed delivery rate limit', async () => {
    const secret = 'linear-secret';
    const jobs = [
      job({
        name: 'linear-agent',
        trigger: { type: 'linear_event', event: 'Issue', action: 'update', teamKey: 'RUSH', label: 'agent' },
      }),
    ];
    const dispatched: string[] = [];
    const waiter = settleWaiter();
    const server = startWebhookServer({
      secrets: { linear: secret },
      rateLimitPerMinute: 1,
      onDelivery: waiter.hit,
      onDeliveryError: waiter.hit,
      fire: {
        jobs,
        dispatch: async (config: JobConfig): Promise<RunMeta> => {
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
        },
      },
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('server did not bind');
    try {
      const payload = Buffer.from(JSON.stringify(linearIssueWebhook(['agent']).payload));
      const signedHeaders = {
        'linear-signature': crypto.createHmac('sha256', secret).update(payload).digest('hex'),
        'linear-delivery': 'delivery-rate-limit',
      };
      const send = (headers: Record<string, string>) => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: address.port,
          path: '/hooks/linear',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': String(payload.length), ...headers },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
        });
        req.on('error', reject);
        req.end(payload);
      });

      expect((await send({})).status).toBe(401);
      expect((await send({})).status).toBe(401);
      expect((await send(signedHeaders)).status).toBe(202);
      await waiter.until(1);
      expect(dispatched).toEqual(['linear-agent']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('tracks completed jobs so retry only finishes failed matches', async () => {
    const secret = 'linear-secret';
    const jobs = [
      job({
        name: 'linear-agent',
        trigger: { type: 'linear_event', event: 'Issue', action: 'update', teamKey: 'RUSH', label: 'agent' },
      }),
      job({
        name: 'linear-followup',
        trigger: { type: 'linear_event', event: 'Issue', action: 'update', teamKey: 'RUSH', label: 'agent' },
      }),
    ];
    const dispatched: string[] = [];
    let shouldFailFollowup = true;
    const waiter = settleWaiter();
    const server = startWebhookServer({
      secrets: { linear: secret },
      onDelivery: waiter.hit,
      onDeliveryError: waiter.hit,
      fire: {
        jobs,
        dispatch: async (config: JobConfig): Promise<RunMeta> => {
          dispatched.push(config.name);
          if (config.name === 'linear-followup' && shouldFailFollowup) {
            shouldFailFollowup = false;
            throw new Error('dispatch failed after a previous match fired');
          }
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
        },
      },
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('server did not bind');
    try {
      const payload = Buffer.from(JSON.stringify(linearIssueWebhook(['agent']).payload));
      const signedHeaders = {
        'linear-signature': crypto.createHmac('sha256', secret).update(payload).digest('hex'),
        'linear-delivery': 'delivery-partial',
      };
      const send = () => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: address.port,
          path: '/hooks/linear',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': String(payload.length), ...signedHeaders },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
        });
        req.on('error', reject);
        req.end(payload);
      });

      // A failing dispatch is no longer a 4xx (already acked); the ledger still holds: the delivery
      // stays unmarked, so a retry re-runs only the failed match.
      expect((await send()).status).toBe(202);
      await waiter.until(1);
      const retry = await send();
      expect(retry.status).toBe(202);
      expect(JSON.parse(retry.body).duplicate).toBeUndefined();
      await waiter.until(2);
      const duplicate = await send();
      expect(duplicate.status).toBe(200);
      expect(JSON.parse(duplicate.body).duplicate).toBe(true);
      expect(dispatched).toEqual(['linear-agent', 'linear-followup', 'linear-followup']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('throttles a per-IP flood before the body read, even with invalid signatures', async () => {
    const server = startWebhookServer({
      secrets: { linear: 'linear-secret' },
      ipRateLimitPerMinute: 2,
      fire: { jobs: [], dispatch: async (): Promise<RunMeta> => { throw new Error('should not dispatch'); } },
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('server did not bind');
    try {
      const payload = Buffer.from(JSON.stringify({ type: 'Issue' }));
      const send = () => new Promise<number>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1', port: address.port, path: '/hooks/linear', method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(payload.length),
            'linear-signature': 'deadbeef',
          },
        }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
        req.on('error', reject);
        req.end(payload);
      });
      // Bad signatures: first two clear the per-IP gate then fail HMAC (401);
      // the third is shed by the per-IP limiter BEFORE the body read (429).
      expect(await send()).toBe(401);
      expect(await send()).toBe(401);
      expect(await send()).toBe(429);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects an over-cap declared body before reading it', async () => {
    const server = startWebhookServer({
      secrets: { linear: 'linear-secret' },
      maxBodyBytes: 64,
      fire: { jobs: [], dispatch: async (): Promise<RunMeta> => { throw new Error('should not dispatch'); } },
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('server did not bind');
    try {
      const big = Buffer.alloc(1024, 0x61);
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1', port: address.port, path: '/hooks/linear', method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(big.length),
            'linear-signature': 'deadbeef',
          },
        }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
        req.on('error', reject);
        req.end(big);
      });
      expect(status).toBe(413);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.skipIf(process.platform === 'win32')('fires matching handlers alongside routines', async () => {
    const secret = 'linear-secret';
    const webhookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-handlers-'));
    process.env.AGENTS_WEBHOOKS_DIR = webhookDir;
    try {
      fs.mkdirSync(path.join(webhookDir), { recursive: true });
      fs.writeFileSync(
        path.join(webhookDir, 'linear-agent.yml'),
        yaml.stringify({
          name: 'linear-agent',
          source: 'linear',
          event: 'Issue',
          action: 'update',
          run: { command: 'echo {{issue.identifier}}' },
        }),
        'utf-8',
      );

      const waiter = settleWaiter();
      let settledHandlers: Array<{ handlerName: string; exitCode?: number; output?: string }> = [];
      const server = startWebhookServer({
        secrets: { linear: secret },
        // Handler results ride the settle callback now, not the HTTP body.
        onDelivery: (_webhook, _fired, handlers) => {
          settledHandlers = handlers as typeof settledHandlers;
          waiter.hit();
        },
        onDeliveryError: waiter.hit,
        fire: { jobs: [], dispatch: async (): Promise<RunMeta> => { throw new Error('should not dispatch routine'); } },
      });
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address !== 'object') throw new Error('server did not bind');
      try {
        const payload = Buffer.from(JSON.stringify(linearIssueWebhook(['agent']).payload));
        const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
        const body = await new Promise<{ status: number; parsed: Record<string, unknown> }>((resolve, reject) => {
          const req = http.request({
            host: '127.0.0.1',
            port: address.port,
            path: '/hooks/linear',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': String(payload.length),
              'linear-signature': sig,
              'linear-delivery': 'delivery-handler-1',
            },
          }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c as Buffer));
            res.on('end', () => resolve({
              status: res.statusCode ?? 0,
              parsed: JSON.parse(Buffer.concat(chunks).toString('utf-8')),
            }));
          });
          req.on('error', reject);
          req.end(payload);
        });

        expect(body.status).toBe(202);
        expect(body.parsed.accepted).toBe(true);
        await waiter.until(1);
        expect(settledHandlers).toHaveLength(1);
        expect(settledHandlers[0].handlerName).toBe('linear-agent');
        expect(settledHandlers[0].exitCode).toBe(0);
        expect(settledHandlers[0].output).toContain('RUSH-1459');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      delete process.env.AGENTS_WEBHOOKS_DIR;
      fs.rmSync(webhookDir, { recursive: true, force: true });
    }
  });

  // RUSH-2722: `run.command` resolves only on exit, so the "fired" log used to wait for it.
  // `onMatch` must fire right after the ack, before the slow command settles.
  it.skipIf(process.platform === 'win32')('reports onMatch immediately, before a slow run.command handler settles', async () => {
    const secret = 'linear-secret';
    const webhookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-onmatch-'));
    process.env.AGENTS_WEBHOOKS_DIR = webhookDir;
    try {
      fs.writeFileSync(
        path.join(webhookDir, 'slow-handler.yml'),
        yaml.stringify({
          name: 'slow-handler',
          source: 'linear',
          event: 'Issue',
          action: 'update',
          run: { command: 'sleep 0.3' },
        }),
        'utf-8',
      );

      const waiter = settleWaiter();
      let matchedAt: number | null = null;
      let settledAt: number | null = null;
      const server = startWebhookServer({
        secrets: { linear: secret },
        onMatch: (_webhook, _matchedJobNames, matchedHandlerNames) => {
          if (matchedHandlerNames.includes('slow-handler')) matchedAt = Date.now();
        },
        onDelivery: () => {
          settledAt = Date.now();
          waiter.hit();
        },
        onDeliveryError: waiter.hit,
        fire: { jobs: [], dispatch: async (): Promise<RunMeta> => { throw new Error('should not dispatch routine'); } },
      });
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address !== 'object') throw new Error('server did not bind');
      try {
        const payload = Buffer.from(JSON.stringify(linearIssueWebhook(['agent']).payload));
        const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
        const ackedAt = await new Promise<number>((resolve, reject) => {
          const req = http.request({
            host: '127.0.0.1',
            port: address.port,
            path: '/hooks/linear',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': String(payload.length),
              'linear-signature': sig,
              'linear-delivery': 'delivery-onmatch-1',
            },
          }, (res) => {
            res.resume();
            res.on('end', () => resolve(Date.now()));
          });
          req.on('error', reject);
          req.end(payload);
        });

        await waiter.until(1);
        expect(matchedAt).not.toBeNull();
        expect(settledAt).not.toBeNull();
        // onMatch trails the ack by a scheduling tick, not the 300ms sleep.
        expect(matchedAt! - ackedAt).toBeLessThan(150);
        // onDelivery only fires once the shelled-out `sleep 0.3` has exited.
        expect(settledAt! - matchedAt!).toBeGreaterThanOrEqual(250);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      delete process.env.AGENTS_WEBHOOKS_DIR;
      fs.rmSync(webhookDir, { recursive: true, force: true });
    }
  });
});

describe('createFileDeliveryStore', () => {
  it('remembers a completed delivery across a restart (new store, same file)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-deliveries-'));
    const file = path.join(dir, 'deliveries.json');
    try {
      const first = createFileDeliveryStore(file);
      expect(first.seen('github:delivery-1')).toBe(false);
      first.markJob('github:delivery-1', 'job-a');
      first.mark('github:delivery-1');
      expect(first.seen('github:delivery-1')).toBe(true);

      // Simulate a receiver restart: a brand-new store loads the persisted file.
      const restarted = createFileDeliveryStore(file);
      expect(restarted.seen('github:delivery-1')).toBe(true);
      expect([...restarted.completedJobs('github:delivery-1')]).toEqual(['job-a']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not resurrect a delivery older than the retention window', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-deliveries-'));
    const file = path.join(dir, 'deliveries.json');
    try {
      // A persisted entry stamped well beyond the retention window is pruned on
      // load — an ancient captured delivery cannot be replayed as a duplicate.
      fs.writeFileSync(file, JSON.stringify({
        'github:ancient': { complete: true, jobs: [], updatedAt: Date.now() - 10 * 60_000 },
      }));
      const store = createFileDeliveryStore(file, 60_000); // 1-minute retention
      expect(store.seen('github:ancient')).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
