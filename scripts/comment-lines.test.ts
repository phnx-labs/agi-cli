import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { COMMENT_TARGET, checkBudget, classifyPath, scanRepository, scanSource } from './comment-lines';

function lines(source: string, language: string): Array<[number, number, string]> {
  return scanSource(source, language).map((item) => [item.start, item.end, item.kind]);
}

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'comments@example.invalid',
      GIT_AUTHOR_NAME: 'Comment Test',
      GIT_COMMITTER_EMAIL: 'comments@example.invalid',
      GIT_COMMITTER_NAME: 'Comment Test',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) throw new Error(Buffer.from(proc.stderr).toString('utf8'));
  return Buffer.from(proc.stdout).toString('utf8').trim();
}

function write(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

describe('language scanners', () => {
  test('TypeScript excludes strings, regexes, and template text but scans interpolation', () => {
    const source = [
      "const url = 'https://example.test/a/*b';",
      'const matcher = /https?:\\/\\/[^/]+/;',
      `const escaped = value.replace(/([\\"$])/g, '\\$1');`,
      '// after regex',
      'const raw = `// text ${value /* kept */} still text`;',
      '// line',
      'const x = 1; /* first',
      'second */',
    ].join('\n');
    expect(lines(source, 'typescript')).toEqual([
      [4, 4, 'line'],
      [5, 5, 'block'],
      [6, 6, 'line'],
      [7, 8, 'block'],
    ]);
  });

  test('TSX excludes JSX text and scans JSX expressions', () => {
    const source = 'const node = <div>https://example.test{/* visible */}{value && <b /> // note\n}</div>;\n// after jsx';
    expect(lines(source, 'tsx')).toEqual([
      [1, 1, 'block'],
      [1, 1, 'line'],
      [3, 3, 'line'],
    ]);
  });

  test('shell keeps shebangs and parameter lengths out of the count', () => {
    const source = '#!/usr/bin/env bash\nvalue=${#items[@]}\necho "# text" # note\n# full\n';
    expect(lines(source, 'shell')).toEqual([
      [3, 3, 'hash'],
      [4, 4, 'hash'],
    ]);
  });

  test('YAML block scalars and Python triple strings are not comments', () => {
    expect(lines('script: |\n  # data\nnext: ok # note\n', 'yaml')).toEqual([[3, 3, 'hash']]);
    expect(lines('- |\n  # sequence data\nnext: ok # note\n', 'yaml')).toEqual([[3, 3, 'hash']]);
    expect(lines('url: https://example.test/a#section\nnext: ok # note\n', 'yaml')).toEqual([[2, 2, 'hash']]);
    expect(lines('value = """\n# data\n"""\n# note\n', 'python')).toEqual([[4, 4, 'hash']]);
  });

  test('counts executable embedded scripts without treating literal heredoc payloads as shell comments', () => {
    expect(lines('const hook = String.raw`#!/usr/bin/env python3\n# generated\nprint("ok")  # inline\n`;', 'typescript')).toEqual([
      [2, 2, 'hash'],
      [3, 3, 'hash'],
    ]);
    expect(lines('const program = String.raw`\n// executable\nrun();\n`;', 'typescript')).toEqual([[2, 2, 'line']]);
    expect(lines("cat <<'DATA'\n# payload\nDATA\npython3 <<'PY'\n# executable\nPY\n", 'shell')).toEqual([[5, 5, 'hash']]);
    expect(lines('cat <<SNIPPET\nset -euo pipefail\n# generated shell\nSNIPPET\n', 'shell')).toEqual([[3, 3, 'hash']]);
    expect(lines('value=$(jq -r .path <<<"$json")\n# still shell code\n', 'shell')).toEqual([[2, 2, 'hash']]);
  });

  test('uses CSS and HTML comment grammars', () => {
    expect(lines('a{background:url(https://cdn.example/x.png)} /* note */', 'css')).toEqual([[1, 1, 'block']]);
    expect(lines('<style>a{background:url(https://cdn.example/x.png)} /* css */</style>\n<script>// js\nrun()</script>', 'html')).toEqual([
      [1, 1, 'block'],
      [2, 2, 'line'],
    ]);
  });

  test('XML comments span every physical line they occupy', () => {
    expect(lines('<a><!-- first\nsecond --></a>', 'xml')).toEqual([[1, 2, 'xml']]);
  });
});

describe('tracked inventory and budget', () => {
  test('classifies code and known non-code while rejecting a new language silently omitted from policy', () => {
    expect(classifyPath('cli/src/a.ts')).toBe('typescript');
    expect(classifyPath('.agents/artifacts/x.ts')).toBeNull();
    expect(classifyPath('README.md')).toBeNull();
    expect(classifyPath('cli/HEALTH.html')).toBeNull();
    expect(classifyPath('cli/docs.html')).toBe('html');
    expect(() => classifyPath('src/main.rs')).toThrow('unclassified tracked file');
    expect(() => classifyPath('scripts/tool', 'echo ok\n')).toThrow('unclassified tracked file');
  });

  test('counts tracked files, deduplicates two tokens on one line, and enforces a non-increasing exact ceiling', () => {
    const root = mkdtempSync(join(tmpdir(), 'comment-lines-'));
    try {
      git(root, 'init');
      write(root, 'src/a.ts', `${Array.from({ length: COMMENT_TARGET }, (_, index) => `// ${index}`).join('\n')}\n`);
      write(root, 'scripts/comment-budget.json', `${JSON.stringify({ schema: 'comment-budget-v1', target: COMMENT_TARGET, ceiling: COMMENT_TARGET })}\n`);
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'base');
      const base = git(root, 'rev-parse', 'HEAD');
      const report = scanRepository(root);
      expect(report.total).toBe(COMMENT_TARGET);
      expect(checkBudget(root, report, base).ceiling).toBe(COMMENT_TARGET);

      write(root, 'src/a.ts', `${Array.from({ length: COMMENT_TARGET - 1 }, (_, index) => `// ${index}`).join('\n')}\n`);
      write(root, 'scripts/comment-budget.json', `${JSON.stringify({ schema: 'comment-budget-v1', target: COMMENT_TARGET, ceiling: COMMENT_TARGET - 1 })}\n`);
      expect(checkBudget(root, scanRepository(root), base).ceiling).toBe(COMMENT_TARGET - 1);

      write(root, 'src/a.ts', `${Array.from({ length: COMMENT_TARGET + 1 }, (_, index) => `// ${index}`).join('\n')}\n`);
      write(root, 'scripts/comment-budget.json', `${JSON.stringify({ schema: 'comment-budget-v1', target: COMMENT_TARGET, ceiling: COMMENT_TARGET + 1 })}\n`);
      expect(() => checkBudget(root, scanRepository(root), base)).toThrow('comment ceiling increased');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
