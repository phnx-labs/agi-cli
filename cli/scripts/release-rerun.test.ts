import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, 'release-rerun.sh');

function select(sha: string, input: object) {
  const result = spawnSync('bash', [SCRIPT, 'select', sha], {
    encoding: 'utf-8',
    input: JSON.stringify(input),
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('exact-SHA release retry', () => {
  it('selects the newest branch-push run for the immutable tagged commit', () => {
    const result = select('release-sha', {
      workflow_runs: [
        { id: 10, head_sha: 'other-sha', run_number: 8, status: 'completed', html_url: 'other' },
        { id: 11, head_sha: 'release-sha', run_number: 9, status: 'completed', html_url: 'old' },
        { id: 12, head_sha: 'release-sha', run_number: 10, status: 'completed', html_url: 'new' },
      ],
    });
    expect(result.status, result.out).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ id: 12, status: 'completed', html_url: 'new' });
  });

  it('refuses to rerun a workflow from a different commit', () => {
    const result = select('release-sha', {
      workflow_runs: [{ id: 10, head_sha: 'other-sha', run_number: 8, status: 'completed', html_url: 'other' }],
    });
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('no branch-push Release run exists for commit release-sha');
  });

  it('reads runs over REST and posts the rerun for the selected exact SHA', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-rerun-gh-'));
    const log = path.join(dir, 'gh.log');
    const gh = path.join(dir, 'gh');
    fs.writeFileSync(gh, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
if [[ "$*" == *'/runs -f branch='* ]]; then
  printf '%s\\n' '{"workflow_runs":[{"id":42,"head_sha":"release-sha","run_number":7,"status":"completed","html_url":"https://example.test/run/42"}]}'
fi
`, { mode: 0o755 });
    const result = spawnSync('bash', [SCRIPT, 'rerun', 'phnx-labs/agi-cli', 'release/9.9.9', 'release-sha'], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_LOG: log },
    });
    const calls = fs.readFileSync(log, 'utf-8');
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Re-ran Release workflow for exact commit release-sha');
    expect(calls).toContain('repos/phnx-labs/agi-cli/actions/workflows/release.yml/runs');
    expect(calls).toContain('repos/phnx-labs/agi-cli/actions/runs/42/rerun');
  });

  it.each(['requested', 'pending'])('keeps a retry-before-tag branch on its exact SHA while the run is %s', (status) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-rerun-active-'));
    const log = path.join(dir, 'gh.log');
    const gh = path.join(dir, 'gh');
    fs.writeFileSync(gh, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
printf '%s\\n' '{"workflow_runs":[{"id":42,"head_sha":"release-sha","run_number":7,"status":"${status}","html_url":"https://example.test/run/42"}]}'
`, { mode: 0o755 });
    const result = spawnSync('bash', [SCRIPT, 'rerun', 'phnx-labs/agi-cli', 'release/9.9.9', 'release-sha'], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_LOG: log },
    });
    const calls = fs.readFileSync(log, 'utf-8');
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`already ${status}`);
    expect(calls).not.toContain('/actions/runs/42/rerun');
  });
});
