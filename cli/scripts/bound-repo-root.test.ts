import { describe, expect, it } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BOUND = path.resolve(__dirname, 'bound-repo-root.sh');

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8' }).trim();
}
function bound(dir: string): void {
  execFileSync('bash', [BOUND, dir], { stdio: 'pipe' });
}

describe('bound-repo-root.sh', () => {
  it('bounds a .git-less tree that would otherwise escape to a git ancestor', () => {
    const ancestor = tmp('bound-ancestor-');
    git('init -q', ancestor);
    fs.writeFileSync(path.join(ancestor, 'ancestor.txt'), 'x');
    git('add -A', ancestor);
    git('-c user.email=t@t -c user.name=t commit -q -m ancestor', ancestor);
    const shipped = path.join(ancestor, 'test-runs', 'agents-cli');
    fs.mkdirSync(shipped, { recursive: true });
    fs.writeFileSync(path.join(shipped, 'marker.txt'), 'x');

    expect(git('rev-parse --show-toplevel', shipped)).toBe(ancestor);

    bound(shipped);

    expect(git('rev-parse --show-toplevel', shipped)).toBe(shipped);
    fs.rmSync(ancestor, { recursive: true, force: true });
  });

  it('repairs a STALE commit-less .git left by an earlier run', () => {
    const shipped = tmp('bound-stale-');
    fs.writeFileSync(path.join(shipped, 'marker.txt'), 'x');
    git('init -q', shipped);
    expect(() => git('rev-parse --verify HEAD', shipped)).toThrow();

    bound(shipped);

    expect(() => git('rev-parse --verify HEAD', shipped)).not.toThrow();
    fs.rmSync(shipped, { recursive: true, force: true });
  });

  it('re-running an already-bound tree does not re-initialise it', () => {
    const shipped = tmp('bound-idem-');
    fs.writeFileSync(path.join(shipped, 'marker.txt'), 'x');
    bound(shipped);
    const head = git('rev-parse HEAD', shipped);
    fs.writeFileSync(path.join(shipped, '.git', 'agents-bound-marker'), 'first');

    bound(shipped);

    expect(fs.existsSync(path.join(shipped, '.git', 'agents-bound-marker'))).toBe(true);
    expect(git('rev-parse HEAD', shipped)).toBe(head);
    fs.rmSync(shipped, { recursive: true, force: true });
  });

  it('does not write the caller machine git identity into the tree config', () => {
    const shipped = tmp('bound-ident-');
    fs.writeFileSync(path.join(shipped, 'marker.txt'), 'x');
    bound(shipped);
    const email = execSync('git config --local --get user.email || true', {
      cwd: shipped, encoding: 'utf-8',
    }).trim();
    expect(email).toBe('');
    fs.rmSync(shipped, { recursive: true, force: true });
  });
});
