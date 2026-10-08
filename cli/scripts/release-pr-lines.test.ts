import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, 'release-pr-lines.sh');

describe('canonical release PR filtering', () => {
  it('ignores same-name fork heads and other base repositories', () => {
    const input = [
      { number: 10, head: { ref: 'release/1.2.3', repo: { full_name: 'fork/agi-cli' } }, base: { ref: 'main', repo: { full_name: 'phnx-labs/agi-cli' } } },
      { number: 11, head: { ref: 'release/1.2.3', repo: { full_name: 'phnx-labs/agi-cli' } }, base: { ref: 'main', repo: { full_name: 'phnx-labs/agi-cli' } } },
      { number: 12, head: { ref: 'release/1.2.4', repo: { full_name: 'phnx-labs/agi-cli' } }, base: { ref: 'main', repo: { full_name: 'other/repo' } } },
    ];
    const result = spawnSync('bash', [SCRIPT, 'phnx-labs/agi-cli', 'main'], {
      encoding: 'utf-8',
      input: JSON.stringify(input),
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe('11 release/1.2.3');
  });
});
