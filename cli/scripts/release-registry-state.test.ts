import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, 'release-registry-state.sh');

function run(mode: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-registry-state-'));
  fs.writeFileSync(path.join(dir, 'npm'), `#!/usr/bin/env bash
case "$REGISTRY_MODE" in
  present) printf '%s\\n' '["1.0.0","1.2.3"]' ;;
  absent) printf '%s\\n' '["1.0.0"]' ;;
  error) echo 'registry unavailable' >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  const result = spawnSync('bash', [SCRIPT, '@scope/package', '1.2.3'], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, REGISTRY_MODE: mode },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('npm release version state', () => {
  it('distinguishes a present immutable version', () => {
    const result = run('present');
    expect(result.status, result.out).toBe(0);
    expect(result.out.trim()).toBe('present');
  });

  it('distinguishes a confirmed absence', () => {
    const result = run('absent');
    expect(result.status, result.out).toBe(0);
    expect(result.out.trim()).toBe('absent');
  });

  it('fails closed on registry query errors', () => {
    const result = run('error');
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('could not query npm versions');
  });
});
