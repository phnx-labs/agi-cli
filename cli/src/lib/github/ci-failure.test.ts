import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { actionsIds, excerptFromLog, EXCERPT_LIMIT, readCiFailure, rerunFailedJobs } from './ci-failure.js';

const testdata = (name: string) => fs.readFileSync(path.join(__dirname, 'testdata', name), 'utf-8');

// Recorded from phnx-labs/agi-cli main at 4b709a7 (2026-10-04): every check green
// except `windows`, whose job log is actions-job-windows.txt.
const SHA = '4b709a7e5c7026f4dcc56336235180386a992b03';
const REPO = 'phnx-labs/agi-cli';
const WINDOWS_EXCERPT = [
  'No test files found, exiting with code 1',
  '⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯',
  'Error: Installing @phnx-labs/secrets-cli@0.1.5 into C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\agents-secrets-cli-0.1.5 failed (exit 0). The suite needs the real standalone; set AGENTS_TEST_SECRETS_BIN to a built secrets-cli entrypoint to skip the install.',
  '    118|     if (result.status !== 0 || !fs.existsSync(entry)) {',
  '    119|       throw new Error(',
  '       |             ^',
  'error: script "test" exited with code 1',
  'Process completed with exit code 1.',
];

/** A gh runner answering from recorded payloads, keyed by the REST path; records what was asked. */
function recordedGh(routes: Record<string, string | Error>) {
  const asked: string[][] = [];
  const gh = async (args: string[]) => {
    asked.push(args);
    const endpoint = args.find((a) => a.startsWith('repos/'));
    const hit = endpoint === undefined ? undefined : routes[endpoint];
    if (hit === undefined) throw new Error(`unexpected gh ${args.join(' ')}`);
    if (hit instanceof Error) throw hit;
    return hit;
  };
  return { gh, asked };
}

/** gh's failure as execFile reports it: the message GitHub returned is on stderr. */
const ghError = (stderr: string) => Object.assign(new Error('Command failed: gh'), { stderr });

describe('excerptFromLog', () => {
  it('keeps the error lines of a real failed job and none of the runner setup or cleanup', () => {
    const excerpt = excerptFromLog(testdata('actions-job-windows.txt'));
    expect(excerpt).toEqual(WINDOWS_EXCERPT);
    // The recorded log mentions credentials and $ErrorActionPreference in the
    // checkout and its cleanup; neither is the failure.
    expect(excerpt.join('\n')).not.toMatch(/includeif|ErrorActionPreference|\x1b|^\d{4}-\d\d-\d\dT/m);
  });

  it('caps a long run of errors at the first seven and the last four lines', () => {
    const log = Array.from({ length: 30 }, (_, i) => `2026-10-04T23:18:06.0000000Z FAIL test ${i}`).join('\n');
    const excerpt = excerptFromLog(log);
    expect(excerpt).toHaveLength(EXCERPT_LIMIT);
    expect(excerpt.slice(0, 7)).toEqual(['FAIL test 0', 'FAIL test 1', 'FAIL test 2', 'FAIL test 3', 'FAIL test 4', 'FAIL test 5', 'FAIL test 6']);
    expect(excerpt[7]).toBe('…');
    expect(excerpt.slice(8)).toEqual(['FAIL test 26', 'FAIL test 27', 'FAIL test 28', 'FAIL test 29']);
  });
});

describe('actionsIds', () => {
  it('reads the run and job from an Actions job page and nothing from another check page', () => {
    expect(actionsIds('https://github.com/phnx-labs/agi-cli/actions/runs/37243157132/job/111555723085'))
      .toEqual({ runId: 37243157132, jobId: 111555723085 });
    expect(actionsIds('https://ci.example.com/build/42')).toEqual({ runId: null, jobId: null });
    expect(actionsIds(null)).toEqual({ runId: null, jobId: null });
  });
});

describe('readCiFailure', () => {
  const routes = {
    [`repos/${REPO}/commits/${SHA}/check-runs`]: testdata('check-runs-main-windows-red.ndjson'),
    [`repos/${REPO}/commits/${SHA}/status`]: testdata('status-main-windows-red.ndjson'),
    [`repos/${REPO}/actions/jobs/111555723085/logs`]: testdata('actions-job-windows.txt'),
  };

  it('names only the failing check, with its run, job and the error lines of its log', async () => {
    const { gh, asked } = recordedGh(routes);
    expect(await readCiFailure(REPO, SHA, gh)).toEqual({
      repo: REPO,
      sha: SHA,
      error: null,
      checks: [{
        name: 'windows',
        url: 'https://github.com/phnx-labs/agi-cli/actions/runs/37243157132/job/111555723085',
        runId: 37243157132,
        jobId: 111555723085,
        conclusion: 'FAILURE',
        excerpt: WINDOWS_EXCERPT,
        excerptError: null,
      }],
    });
    // gh refuses to print a log carrying escape sequences unless allowed to.
    expect(asked.find((a) => a.includes(`repos/${REPO}/actions/jobs/111555723085/logs`))).toContain('--allow-escape-sequences');
  });

  it('reports an unreadable log on that check instead of failing the report', async () => {
    const { gh } = recordedGh({
      ...routes,
      [`repos/${REPO}/actions/jobs/111555723085/logs`]: ghError('gh: Not Found (HTTP 404)\n'),
    });
    const report = await readCiFailure(REPO, SHA, gh);
    expect(report.error).toBeNull();
    expect(report.checks[0]).toMatchObject({ name: 'windows', excerpt: [], excerptError: 'Not Found (HTTP 404)' });
  });

  it('says the checks could not be read rather than reporting none failing', async () => {
    const { gh } = recordedGh({ ...routes, [`repos/${REPO}/commits/${SHA}/check-runs`]: ghError('gh: Bad credentials (HTTP 401)\n') });
    expect(await readCiFailure(REPO, SHA, gh)).toEqual({ repo: REPO, sha: SHA, checks: [], error: 'Bad credentials (HTTP 401)' });
  });
});

describe('rerunFailedJobs', () => {
  it('posts the rerun of the failed jobs and reports it requested', async () => {
    const { gh, asked } = recordedGh({ [`repos/${REPO}/actions/runs/37243157132/rerun-failed-jobs`]: '' });
    expect(await rerunFailedJobs(REPO, 37243157132, gh)).toEqual({
      repo: REPO, runId: 37243157132, requested: true, message: 'Re-run of the failed jobs requested',
    });
    expect(asked[0]).toEqual(['api', '-X', 'POST', `repos/${REPO}/actions/runs/37243157132/rerun-failed-jobs`]);
  });

  it('passes GitHub\'s refusal through', async () => {
    const { gh } = recordedGh({ [`repos/${REPO}/actions/runs/37243157132/rerun-failed-jobs`]: ghError(testdata('rerun-refused.stderr')) });
    const result = await rerunFailedJobs(REPO, 37243157132, gh);
    expect(result.requested).toBe(false);
    expect(result.message).toBe('This workflow is already running (HTTP 403)');
  });
});
