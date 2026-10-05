import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  notableSnippet,
  routineKind,
  routineStartNotification,
  routineStartFailedNotification,
  routineFinishNotification,
  routineAgent,
} from './routine-notify.js';
import type { JobConfig, RunMeta } from './scheduling/routines.js';

function agentConfig(p: Partial<JobConfig> = {}): JobConfig {
  return {
    name: 'nightly',
    agent: 'claude',
    mode: 'auto',
    effort: 'medium',
    timeout: '10m',
    enabled: true,
    prompt: 'do the thing',
    ...p,
  } as JobConfig;
}

function meta(p: Partial<RunMeta> = {}): RunMeta {
  return {
    jobName: 'nightly',
    runId: 'r1',
    agent: 'claude',
    pid: 123,
    status: 'completed',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    exitCode: 0,
    ...p,
  };
}

describe('routineKind', () => {
  it('classifies command / workflow / agent', () => {
    expect(routineKind({ command: 'git pull' })).toBe('command');
    expect(routineKind({ workflow: 'deploy' })).toBe('workflow');
    expect(routineKind({ agent: 'claude' })).toBe('agent');
  });
});

describe('formatDuration', () => {
  it('renders seconds / minutes / hours in human form', () => {
    expect(formatDuration(4500)).toBe('5s'); // rounds
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(80_000)).toBe('1m 20s');
    expect(formatDuration(120_000)).toBe('2m');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(3_780_000)).toBe('1h 3m');
  });

  it('returns null for unknown / negative durations', () => {
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(-1)).toBeNull();
  });
});

describe('notableSnippet', () => {
  it('returns the first non-empty line', () => {
    expect(notableSnippet('\n\n  Deployed 3 services  \nmore')).toBe('Deployed 3 services');
  });

  it('returns null for empty / whitespace / missing reports', () => {
    expect(notableSnippet(null)).toBeNull();
    expect(notableSnippet('')).toBeNull();
    expect(notableSnippet('   \n  ')).toBeNull();
  });

  it('truncates a long line with an ellipsis', () => {
    const snip = notableSnippet('x'.repeat(300), 20)!;
    expect(snip.length).toBe(20);
    expect(snip.endsWith('…')).toBe(true);
  });
});

describe('routineStartNotification — threshold', () => {
  it('notifies for agent and workflow routines', () => {
    expect(routineStartNotification(agentConfig())).toMatchObject({
      title: 'Routine started',
      subtitle: 'nightly',
      action: 'routines:list',
    });
    expect(routineStartNotification(agentConfig({ agent: undefined, workflow: 'deploy' }))?.body).toBe(
      'Running workflow deploy',
    );
  });

  it('suppresses the start ping for command housekeeping routines', () => {
    expect(
      routineStartNotification(agentConfig({ agent: undefined, command: 'git pull' })),
    ).toBeNull();
  });
});

// RUSH-2030: the daemon fires the START ping unconditionally, so a pre-spawn failure needs a
// matching failure banner from the catch block, else an orphaned "Routine started" breaks "exactly
// one start + one finish". This is the builder the catch path calls.
describe('routineStartFailedNotification — closes the orphaned-start gap', () => {
  it('emits a failure banner carrying the error reason and the runs-folder action', () => {
    const n = routineStartFailedNotification(agentConfig(), 'prepareJobHome: ENOSPC');
    expect(n).toMatchObject({
      title: 'Routine failed',
      subtitle: 'nightly',
      action: 'routines:list',
    });
    expect(n.body).toBe('Failed to start: prepareJobHome: ENOSPC');
  });

  it('is never suppressed — even a command housekeeping routine gets the failure ping', () => {
    const n = routineStartFailedNotification(
      agentConfig({ agent: undefined, command: 'git pull' }),
      'spawn EACCES',
    );
    expect(n).toMatchObject({ title: 'Routine failed', subtitle: 'nightly' });
    expect(n.body).toBe('Failed to start: spawn EACCES');
  });
});

describe('routineFinishNotification — threshold + content', () => {
  it('surfaces the report first line as notable output on success', () => {
    const n = routineFinishNotification(meta(), {
      report: 'Summary: 12 tickets triaged\n\ndetails...',
      artifactPath: '/runs/nightly/r1/report.md',
    })!;
    expect(n.title).toBe('Routine finished');
    expect(n.subtitle).toBe('nightly');
    expect(n.body).toBe('Summary: 12 tickets triaged');
    expect(n.action).toBe('open:/runs/nightly/r1/report.md');
  });

  it('falls back to a duration body when there is no report', () => {
    const n = routineFinishNotification(meta({ duration: 80_000 }), { report: null })!;
    expect(n.body).toBe('Completed in 1m 20s');
  });

  it('reports the failure reason on a failed run', () => {
    const n = routineFinishNotification(
      meta({ status: 'failed', exitCode: 2, errorMessage: 'auth_failed: 401' }),
      {},
    )!;
    expect(n.title).toBe('Routine failed');
    expect(n.body).toBe('auth_failed: 401');
  });

  it('reports a timeout distinctly', () => {
    const n = routineFinishNotification(meta({ status: 'timeout', exitCode: null }), {})!;
    expect(n.title).toBe('Routine failed');
    expect(n.body).toBe('Timed out');
  });

  it('falls back to the exit code when a failure has no error message', () => {
    const n = routineFinishNotification(meta({ status: 'failed', exitCode: 3 }), {})!;
    expect(n.body).toBe('Exited with code 3');
  });

  it('defaults the click action to the routines list when no artifact exists', () => {
    const n = routineFinishNotification(meta(), { report: null, artifactPath: null })!;
    expect(n.action).toBe('routines:list');
  });

  // Anti-spam threshold: a green command routine (housekeeping) is suppressed,
  // but a FAILED command routine still notifies.
  it('suppresses a successful command routine but notifies on command failure', () => {
    const okCmd = meta({ agent: undefined, command: 'git pull', status: 'completed', exitCode: 0 });
    expect(routineFinishNotification(okCmd, {})).toBeNull();

    const failCmd = meta({ agent: undefined, command: 'git pull', status: 'failed', exitCode: 1 });
    expect(routineFinishNotification(failCmd, {})).toMatchObject({ title: 'Routine failed' });
  });
});

describe('routineAgent — the notification avatar', () => {
  it('names the harness for an agent routine', () => {
    expect(routineAgent(agentConfig())).toBe('claude');
    expect(routineStartNotification(agentConfig())!.agent).toBe('claude');
    expect(routineStartFailedNotification(agentConfig(), 'boom').agent).toBe('claude');
    expect(routineFinishNotification(meta(), {})!.agent).toBe('claude');
  });

  it('shows the Claude avatar for a workflow routine (the harness workflows run on)', () => {
    // A workflow routine has no `agent` field (JobConfig.agent is omitted and validation rejects
    // both) and runs via `agents run <workflow>`, which delegates to claude, so start and finish
    // banners carry the Claude mark (runner.ts effectiveAgent).
    const cfg = agentConfig({ agent: undefined, workflow: 'deploy' });
    expect(routineAgent(cfg)).toBe('claude');
    expect(routineStartNotification(cfg)!.agent).toBe('claude');
    const finishMeta = meta({ agent: 'claude', workflow: 'deploy' });
    expect(routineAgent(finishMeta)).toBe('claude');
    expect(routineFinishNotification(finishMeta, {})!.agent).toBe('claude');
  });

  it('leaves a command routine without an agent', () => {
    // Deterministic housekeeping runs no harness, so its failure banner shows
    // the agents-cli icon alone rather than an avatar for an agent that never ran.
    const cmd = meta({ agent: undefined, command: 'git pull', status: 'failed', exitCode: 1 });
    expect(routineAgent(cmd)).toBeUndefined();
    expect(routineFinishNotification(cmd, {})!.agent).toBeUndefined();
  });
});
