/** Annotated release tags from the folded changelog, running the real
 * create-annotated-release-tag.sh against a real git repository (no mocks). release.sh needs live
 * npm and GitHub, so extracting this contract is what makes the path testable. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, 'create-annotated-release-tag.sh');
const RELEASE_SH = fs.readFileSync(path.resolve(__dirname, 'release.sh'), 'utf-8');

const describeTag = process.platform === 'win32' ? describe.skip : describe;

let repo: string;

function git(...args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function runTag(version: string, commit: string, force = false) {
  const args = [SCRIPT, version, commit];
  if (force) args.push('--force');
  return spawnSync('bash', args, { cwd: repo, encoding: 'utf-8' });
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'annotated-tag-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.mkdirSync(path.join(repo, 'cli/.changelog'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'cli/.changelog/9.9.9.md'),
    '- **Ship annotated tags.** Notes from the fold.\n',
  );
  fs.writeFileSync(
    path.join(repo, 'cli/package.json'),
    '{"name":"@phnx-labs/agents-cli","version":"9.9.9"}\n',
  );
  git('add', 'cli/.changelog/9.9.9.md', 'cli/package.json');
  git('commit', '-q', '-m', 'prep 9.9.9');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describeTag('create-annotated-release-tag.sh', () => {
  it('creates an annotated tag whose message is Release <ver> + folded notes', () => {
    const head = git('rev-parse', 'HEAD');
    const r = runTag('9.9.9', head);
    expect(r.status, r.stderr).toBe(0);
    expect(git('cat-file', '-t', 'refs/tags/v9.9.9')).toBe('tag');
    expect(git('rev-parse', 'refs/tags/v9.9.9^{commit}')).toBe(head);
    const contents = git('for-each-ref', '--format=%(contents)', 'refs/tags/v9.9.9');
    expect(contents).toContain('Release 9.9.9');
    expect(contents).toContain('Ship annotated tags');
  });

  it('fails loud when the commit has no folded changelog file', () => {
    fs.unlinkSync(path.join(repo, 'cli/.changelog/9.9.9.md'));
    git('add', '-A');
    git('commit', '-q', '-m', 'drop notes');
    const r = runTag('9.9.9', 'HEAD');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/has no apps\/cli\/\.changelog\/9\.9\.9\.md/);
  });

  it('--force upgrades a lightweight local tag to annotated', () => {
    const head = git('rev-parse', 'HEAD');
    git('tag', 'v9.9.9', head);
    expect(git('cat-file', '-t', 'refs/tags/v9.9.9')).toBe('commit');
    const r = runTag('9.9.9', head, true);
    expect(r.status, r.stderr).toBe(0);
    expect(git('cat-file', '-t', 'refs/tags/v9.9.9')).toBe('tag');
    expect(git('for-each-ref', '--format=%(contents)', 'refs/tags/v9.9.9')).toContain(
      'Release 9.9.9',
    );
  });
});

describeTag('release.sh wires create-annotated-release-tag.sh', () => {
  it('delegates both tag sites through create_annotated_release_tag and upgrades lightweight locals', () => {
    expect(RELEASE_SH).toContain('scripts/create-annotated-release-tag.sh "$@"');
    expect(RELEASE_SH).toContain('create_annotated_release_tag "$TARGET" "$PUBLISH_SHA"');
    expect(RELEASE_SH).toContain(
      'create_annotated_release_tag "$TARGET" "$(git rev-parse "$TAG_TARGET^{commit}")" --force',
    );
    expect(RELEASE_SH).toContain('git cat-file -t "refs/tags/v$TARGET"');
    expect(RELEASE_SH).toContain('Upgraded lightweight local tag');
  });
});
