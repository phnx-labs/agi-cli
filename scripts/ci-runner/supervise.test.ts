import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SUPERVISE = join(import.meta.dir, 'supervise.sh');

describe('supervise.sh', () => {
  test('refuses to run without CI_BOX_IP instead of dialing a baked-in address', () => {
    const env = { ...process.env };
    delete env.CI_BOX_IP;
    const r = spawnSync('bash', [SUPERVISE, '--once'], { encoding: 'utf8', env });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('CI_BOX_IP is not set');
    expect(r.stdout).toBe('');
  });
});
