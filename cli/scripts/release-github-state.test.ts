import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, 'release-github-state.sh');

function run(mode: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-github-state-'));
  fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env bash
case "$GITHUB_MODE" in
  present) printf '%s\\n' 'HTTP/2.0 200 OK' ;;
  absent) printf '%s\\n' 'HTTP/2.0 404 Not Found'; exit 1 ;;
  error) printf '%s\\n' 'HTTP/2.0 401 Unauthorized'; exit 1 ;;
esac
`, { mode: 0o755 });
  const result = spawnSync('bash', [SCRIPT, 'phnx-labs/agi-cli', 'v1.2.3'], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_MODE: mode },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('GitHub release state', () => {
  it('distinguishes a present release', () => {
    const result = run('present');
    expect(result.status, result.out).toBe(0);
    expect(result.out.trim()).toBe('present');
  });

  it('distinguishes a confirmed 404 absence', () => {
    const result = run('absent');
    expect(result.status, result.out).toBe(0);
    expect(result.out.trim()).toBe('absent');
  });

  it('fails closed on API and authentication errors', () => {
    const result = run('error');
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('401 Unauthorized');
  });
});
