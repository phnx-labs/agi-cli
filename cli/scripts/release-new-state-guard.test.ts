import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, 'release-new-state-guard.sh');

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-new-state-'));
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'state');
  git(root, 'init', '--bare', remote);
  fs.mkdirSync(repo);
  git(repo, 'init');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'fixture');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', 'origin', 'HEAD:refs/heads/main');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), `#!/usr/bin/env bash
mode="$(cat "$RELEASE_TEST_STATE")"
if [[ "$*" == "view @phnx-labs/agents-cli@latest version" ]]; then
  [[ "$mode" == newer ]] && echo 1.2.4 || echo 1.2.2
elif [[ "$*" == "view @phnx-labs/agents-cli versions --json" ]]; then
  [[ "$mode" == published ]] && echo '["1.2.2","1.2.3"]' || echo '["1.2.2"]'
else
  exit 1
fi
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash
mode="$(cat "$RELEASE_TEST_STATE")"
if [[ "$mode" == other-pr ]]; then
  printf '%s\n' '[{"number":44,"head":{"ref":"release/1.2.4","repo":{"full_name":"phnx-labs/agi-cli"}},"base":{"ref":"main","repo":{"full_name":"phnx-labs/agi-cli"}}}]'
else
  echo '[]'
fi
`, { mode: 0o755 });
  fs.writeFileSync(state, 'clear');
  return { bin, repo, state };
}

function guard(f: ReturnType<typeof fixture>) {
  const result = spawnSync('bash', [
    SCRIPT, '@phnx-labs/agents-cli', '1.2.3', '1.2.2',
    'phnx-labs/agi-cli', 'main', 'release/1.2.3',
  ], {
    cwd: f.repo,
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      RELEASE_TEST_STATE: f.state,
    },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('new-release state guard', () => {
  it('invalidates a stale preflight when another release PR appears', () => {
    const f = fixture();
    const initial = guard(f);
    expect(initial.status, initial.out).toBe(0);
    expect(initial.out.trim()).toBe('patch 1.2.2');

    fs.writeFileSync(f.state, 'other-pr');
    const decisive = guard(f);
    expect(decisive.status).not.toBe(0);
    expect(decisive.out).toContain('#44 release/1.2.4');
  });

  it('rejects a target made stale by a newer completed release', () => {
    const f = fixture();
    expect(guard(f).status).toBe(0);
    fs.writeFileSync(f.state, 'newer');
    const decisive = guard(f);
    expect(decisive.status).not.toBe(0);
    expect(decisive.out).toContain('invalid bump: 1.2.4 -> 1.2.3');
  });

  it('rejects a target that appeared in the registry during preparation', () => {
    const f = fixture();
    expect(guard(f).status).toBe(0);
    fs.writeFileSync(f.state, 'published');
    const decisive = guard(f);
    expect(decisive.status).not.toBe(0);
    expect(decisive.out).toContain('already present in the immutable registry');
  });

});
