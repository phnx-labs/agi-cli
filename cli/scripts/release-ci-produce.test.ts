import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SOURCE = path.resolve(__dirname, 'release-ci-produce.sh');

function run(mode: '--inherit' | '--impact') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-ci-produce-'));
  const scripts = path.join(root, 'scripts');
  const log = path.join(root, 'args');
  fs.mkdirSync(scripts);
  fs.copyFileSync(SOURCE, path.join(scripts, 'release-ci-produce.sh'));
  fs.writeFileSync(path.join(scripts, 'release-attestation-produce.sh'), `#!/usr/bin/env bash
printf '%s\n' "$*" > "$PRODUCE_ARGS_LOG"
`, { mode: 0o755 });
  const value = mode === '--inherit' ? '/proof/base.json' : 'abc123';
  const result = spawnSync('bash', [path.join(scripts, 'release-ci-produce.sh'), 'head456', '/store', mode, value], {
    encoding: 'utf-8',
    env: { ...process.env, PRODUCE_ARGS_LOG: log },
  });
  return { result, args: fs.readFileSync(log, 'utf-8').trim() };
}

describe('release CI proof production', () => {
  it('derives from a compatible retained proof without rerunning checks', () => {
    const { result, args } = run('--inherit');
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(args).toBe('head456 --inherit-suite-from /proof/base.json --dir /store');
  });

  it('runs bounded impacted checks from an incompatible retained proof', () => {
    const { result, args } = run('--impact');
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(args).toBe('head456 --test-impact-from abc123 --dir /store');
  });
});
