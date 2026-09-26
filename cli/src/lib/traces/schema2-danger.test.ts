import { describe, expect, it } from 'vitest';
import { classifyActionDanger } from './schema2-danger.js';
import { tokenizeBash } from '@phnx-labs/sessions-cli/reader';

/** Tokenize a single command into its first segment's argv, as the producer does. */
function argv(cmd: string): string[] {
  const segs = tokenizeBash(cmd);
  return segs[0] ?? [];
}

describe('classifyActionDanger — DESTRUCTIVE', () => {
  const destructive: Array<[string, string]> = [
    ['rm -rf dist', 'recursive-force-delete'],
    ['rm -fr /tmp/x', 'recursive-force-delete'],
    ['rm -r build', 'recursive-delete'],
    ['rm --recursive --force node_modules', 'recursive-force-delete'],
    ['rm -rf $DIR', 'recursive-force-delete'], // destructive regardless of expansion
    ['git reset --hard', 'git-reset-hard'],
    ['git reset --hard HEAD~1', 'git-reset-hard'],
    ['git clean -fd', 'git-clean-force'],
    ['git clean -fdx', 'git-clean-force'],
    ['git push --force origin main', 'git-push-force'],
    ['git push -f', 'git-push-force'],
    ['git push --force-with-lease', 'git-push-force'],
    ['git push origin +main', 'git-push-force'],
    ['git push origin +refs/heads/main:main', 'git-push-force'],
    ['git push origin +HEAD:main', 'git-push-force'],
    ['git checkout -- .', 'git-checkout-discard'],
    ['git stash drop', 'git-stash-drop'],
    ['git stash clear', 'git-stash-drop'],
    ['kill -9 1234', 'kill-9'],
    ['pkill -9 node', 'kill-9'],
    ['dd of=/dev/sda if=/dev/zero', 'dd-write'],
    ['mkfs.ext4 /dev/sdb1', 'mkfs'],
    ['psql -c "DROP TABLE users"', 'sql-drop-table'],
    ['psql -c "TRUNCATE sessions"', 'sql-truncate'],
    ['mysql -e "DELETE FROM logs"', 'sql-delete-no-where'],
  ];
  for (const [cmd, op] of destructive) {
    it(`flags "${cmd}" DESTRUCTIVE (${op})`, () => {
      const v = classifyActionDanger(argv(cmd));
      expect(v.danger).toBe('DESTRUCTIVE');
      expect(v.destructiveOperation).toBe(op);
    });
  }

  it('flags a redirect that overwrites a raw device', () => {
    // The tokenizer keeps `>` and its target as separate tokens.
    const v = classifyActionDanger(['dd', 'if=/dev/zero', '>', '/dev/sda']);
    expect(v.danger).toBe('DESTRUCTIVE');
  });

  it('flags a fused >/dev/sda redirect', () => {
    const v = classifyActionDanger(['cat', 'x', '>/dev/sdb']);
    expect(v.danger).toBe('DESTRUCTIVE');
    expect(v.destructiveOperation).toBe('overwrite-device');
  });
});

describe('classifyActionDanger — potentially-destructive', () => {
  const cases: Array<[string, string]> = [
    ['rm file.txt', 'delete'],
    ['rm -f file.txt', 'delete'], // force without recursion is still just a delete
    ['git reset HEAD~1', 'git-reset'], // soft/mixed
    ['git reset --soft HEAD~1', 'git-reset'],
    ['git clean -n', 'git-clean'], // dry-run, no force
    ['kill 1234', 'kill'],
    ['killall node', 'kill'],
    ['mv old new', 'move-overwrite'],
  ];
  for (const [cmd, op] of cases) {
    it(`flags "${cmd}" potentially-destructive (${op})`, () => {
      const v = classifyActionDanger(argv(cmd));
      expect(v.danger).toBe('potentially-destructive');
      expect(v.destructiveOperation).toBe(op);
    });
  }
});

describe('classifyActionDanger — normal (conservative default)', () => {
  const normal = [
    'ls -la',
    'cat file.txt',
    'bun test',
    'git status',
    'git commit -m "x"',
    'git push origin feature', // no --force
    'git log --oneline',
    'echo hello',
    'grep -r foo .',
    'npm install',
    'mysql -e "DELETE FROM logs WHERE id = 1"', // scoped DELETE with WHERE
    'psql -c "SELECT * FROM users"',
    'node build.js',
    'mkdir -p out',
    'cp a b', // copy is not flagged
    'sed -i s/a/b/ file',
  ];
  for (const cmd of normal) {
    it(`treats "${cmd}" as normal`, () => {
      const v = classifyActionDanger(argv(cmd));
      expect(v.danger).toBe('normal');
      expect(v.destructiveOperation).toBeUndefined();
    });
  }

  it('does not flag a DELETE that has a WHERE, even with newlines', () => {
    const v = classifyActionDanger(argv('psql -c "DELETE FROM t WHERE x=1"'));
    expect(v.danger).toBe('normal');
  });

  it('does not treat an rm-looking ARGUMENT to another tool as rm', () => {
    // `find . -name rm` — `rm` is an argument, argv[0] is find.
    const v = classifyActionDanger(['find', '.', '-name', 'rm']);
    expect(v.danger).toBe('normal');
  });

  it('returns normal for empty argv', () => {
    expect(classifyActionDanger([])).toEqual({ danger: 'normal' });
  });

  it('classifies a full-path executable by basename', () => {
    expect(classifyActionDanger(['/bin/rm', '-rf', 'x']).danger).toBe('DESTRUCTIVE');
  });
});
