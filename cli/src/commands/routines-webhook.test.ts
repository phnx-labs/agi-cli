/**
 * End-to-end tests for `agents routines webhook`.
 *
 * The webhook receiver logic (`matchJobsToWebhook` / `fireWebhookJobs` in
 * `../lib/triggers/webhook.ts`) is unit-tested in isolation, but until this
 * command existed nothing CALLED it — a `--on-registered` (trigger) routine had
 * no reachable local entrypoint. These tests drive the REAL CLI as a subprocess
 * against an isolated HOME, so they exercise the full path a user hits:
 *
 *   payload (--file) -> listJobs() (real disk read) -> matchJobsToWebhook
 *     -> executeJobDetached (the same dispatch cron uses)
 *
 * Nothing here is mocked: the matcher, the job loader, and the dispatch path all
 * run for real. Before the `webhook` subcommand is registered these fail with
 * commander's "unknown command" (non-zero exit, no run dirs created).
 */
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

// src/commands/ -> repo root is two levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A realistic GitHub `pull_request` delivery body for repo owner/name @ base. */
function pullRequestPayload(fullName: string, baseRef = 'main'): Record<string, unknown> {
  return {
    action: 'opened',
    repository: { full_name: fullName },
    pull_request: { base: { ref: baseRef }, head: { ref: 'feature' } },
  };
}

function labeledPullRequestPayload(fullName: string, label: string): Record<string, unknown> {
  return {
    action: 'labeled',
    repository: { full_name: fullName },
    label: { name: label },
    pull_request: {
      base: { ref: 'main' },
      head: { ref: 'feature' },
      labels: [{ name: label }],
    },
  };
}

/** Provision an isolated ~/.agents HOME with the given routine YAMLs on disk. */
function makeHome(jobs: Record<string, unknown>[]): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-webhook-home-'));
  const routinesDir = path.join(home, '.agents', 'routines');
  fs.mkdirSync(routinesDir, { recursive: true });
  // A populated config marks this a non-first-run home so the interactive setup
  // path can never trigger (spawnSync is non-TTY anyway).
  fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents: {}\n');
  // ensureInitialized() gates every non-setup command on the system repo being a
  // git checkout (isGitRepo → ~/.agents/.system/.git exists). Seed it so the
  // command runs instead of erroring "agents-cli is not set up".
  fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
  const deviceDir = path.join(home, '.agents', 'devices', 'webhook-test');
  fs.mkdirSync(deviceDir, { recursive: true });
  fs.writeFileSync(
    path.join(deviceDir, 'agents.yaml'),
    `routines:\n${jobs.map((job) => `  - ${job.name}`).join('\n')}\n`,
  );
  for (const job of jobs) {
    const yamlLines = Object.entries(job).map(([k, v]) =>
      typeof v === 'object' ? `${k}: ${JSON.stringify(v)}` : `${k}: ${JSON.stringify(v)}`,
    );
    fs.writeFileSync(path.join(routinesDir, `${job.name}.yml`), yamlLines.join('\n') + '\n');
  }
  return home;
}

/** Run the real CLI (`agents routines webhook ...`) against an isolated HOME. */
function runWebhook(home: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('node', ['--import', 'tsx', 'src/index.ts', 'routines', 'webhook', ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENTS_SKIP_MIGRATION: '1',
      AGENTS_SYNC_MACHINE_ID: 'webhook-test',
    },
    encoding: 'utf-8',
  });
}

const matchingJob = {
  name: 'pr-job',
  agent: 'claude',
  mode: 'plan',
  prompt: 'review the PR',
  sandbox: false, // keep the detached dispatch a plain spawn (no overlay-home setup)
  trigger: { type: 'github_event', event: 'pull_request', repo: 'octo/repo' },
};

// A schedule-only routine: it has no trigger, so no webhook must ever fire it.
const nonMatchingJob = {
  name: 'nightly',
  agent: 'claude',
  mode: 'plan',
  prompt: 'nightly digest',
  schedule: '0 3 * * *',
};

const uxApprovedJob = {
  name: 'ux-tests',
  agent: 'claude',
  mode: 'plan',
  prompt: 'Run the UX test agent and post Playwright plus visual regression results to the PR.',
  sandbox: false,
  trigger: {
    type: 'github_event',
    event: 'pull_request',
    repo: 'octo/repo',
    action: 'labeled',
    label: 'ux-approved',
  },
};

describe('agents routines webhook', () => {
  it('dry-run selects the matching trigger routine and leaves the schedule-only one out', () => {
    const home = makeHome([matchingJob, nonMatchingJob]);
    try {
      const payloadPath = path.join(home, 'pr.json');
      fs.writeFileSync(payloadPath, JSON.stringify(pullRequestPayload('octo/repo')));

      const res = runWebhook(home, ['--event', 'pull_request', '--file', payloadPath, '--dry-run']);

      expect(res.status).toBe(0);
      expect(res.stdout).toContain('pr-job');
      expect(res.stdout).not.toContain('nightly');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('fires the matching routine through the cron dispatch path and not the non-matching one', () => {
    const home = makeHome([matchingJob, nonMatchingJob]);
    const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', '__daemon-run'], { stdio: 'ignore' });
    try {
      // Pre-seed a real daemon command identity so the command sees the
      // scheduler as already running and does NOT spawn a real daemon.
      const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
      fs.mkdirSync(daemonDir, { recursive: true });
      fs.writeFileSync(path.join(daemonDir, 'daemon.pid'), String(daemon.pid));

      const payloadPath = path.join(home, 'pr.json');
      fs.writeFileSync(payloadPath, JSON.stringify(pullRequestPayload('octo/repo')));

      // No --dry-run: fireWebhookJobs -> executeJobDetached actually runs.
      // executeJobDetached writes the run's meta.json synchronously, then spawns
      // the (absent-in-test) agent binary detached — so exit code is irrelevant;
      // the run directory is the observable proof the routine was dispatched.
      runWebhook(home, ['--event', 'pull_request', '--file', payloadPath]);

      const runsDir = path.join(home, '.agents', '.history', 'runs');
      const firedMatching = fs.existsSync(path.join(runsDir, 'pr-job'));
      const firedNonMatching = fs.existsSync(path.join(runsDir, 'nightly'));

      expect(firedMatching).toBe(true);
      expect(firedNonMatching).toBe(false);
    } finally {
      daemon.kill('SIGKILL');
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('fires a pull_request.labeled routine only for the configured GitHub label', () => {
    const home = makeHome([uxApprovedJob, nonMatchingJob]);
    const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', '__daemon-run'], { stdio: 'ignore' });
    try {
      const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
      fs.mkdirSync(daemonDir, { recursive: true });
      fs.writeFileSync(path.join(daemonDir, 'daemon.pid'), String(daemon.pid));

      const wrongPayloadPath = path.join(home, 'wrong-label.json');
      fs.writeFileSync(wrongPayloadPath, JSON.stringify(labeledPullRequestPayload('octo/repo', 'bug')));
      runWebhook(home, ['--event', 'pull_request', '--file', wrongPayloadPath]);
      expect(fs.existsSync(path.join(home, '.agents', '.history', 'runs', 'ux-tests'))).toBe(false);

      const payloadPath = path.join(home, 'ux-approved.json');
      fs.writeFileSync(payloadPath, JSON.stringify(labeledPullRequestPayload('octo/repo', 'ux-approved')));
      runWebhook(home, ['--event', 'pull_request', '--file', payloadPath]);

      expect(fs.existsSync(path.join(home, '.agents', '.history', 'runs', 'ux-tests'))).toBe(true);
      expect(fs.existsSync(path.join(home, '.agents', '.history', 'runs', 'nightly'))).toBe(false);
    } finally {
      daemon.kill('SIGKILL');
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
