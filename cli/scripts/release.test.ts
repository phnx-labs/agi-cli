import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, 'release.sh');
const describeUnix = process.platform === 'win32' ? describe.skip : describe;

function runWithEnv(env: NodeJS.ProcessEnv, ...args: string[]) {
  const result = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf-8', env });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function run(...args: string[]) {
  return runWithEnv(process.env, ...args);
}

describeUnix('release.sh operator boundary', () => {
  it('documents the branch-push publisher in executed help', () => {
    const result = run('--help');
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('release/x.y.z or release/x.y.z-pre.n');
    expect(result.out).toContain('only publisher');
  });

  it.each(['v1.2.3', '1.2', '1.2.3-rc.1', 'release/1.2.3'])('rejects invalid version %s', (version) => {
    const result = run(version);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('version must be x.y.z or x.y.z-pre.n');
  });

  it('fails non-interactive apply before any release mutation', () => {
    const result = run('9.9.9', '--apply', '--orchestration-phase');
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('--yes');
  });

  it('refuses a CI publish outside GitHub Actions', () => {
    const env = { ...process.env };
    delete env.GITHUB_ACTIONS;
    delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete env.NODE_AUTH_TOKEN;
    delete env.NPM_TOKEN;
    const result = runWithEnv(env, '1.22.122', '--ci-publish');
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('restricted to GitHub Actions');
  });
});
