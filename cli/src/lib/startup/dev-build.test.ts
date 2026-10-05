import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectDevBuild } from './dev-build.js';

const tmpDirs: string[] = [];
function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'devbuild-'));
  tmpDirs.push(d);
  return d;
}
function writeFile(p: string, body = ''): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('detectDevBuild', () => {
  it('a 0.0.0-dev version is always a dev build', () => {
    expect(detectDevBuild('/anything', '0.0.0-dev.abc123')).toBe(true);
  });

  it('Homebrew-node npm-global install is NOT a dev build (the bug)', () => {
    // Reproduce the real layout: a brew prefix that is itself a git repo, with `agents` symlinked
    // from <prefix>/bin into the installed package under <prefix>/lib/node_modules. The naive
    // dirname(dirname(symlink)) reached <prefix>, saw .git, and false-positived as a dev build.
    const prefix = mkTmp();
    fs.mkdirSync(path.join(prefix, '.git')); // Homebrew's own repo
    const pkgDir = path.join(prefix, 'lib', 'node_modules', '@phnx-labs', 'agents-cli');
    writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@phnx-labs/agents-cli' }));
    const entry = path.join(pkgDir, 'dist', 'index.js');
    writeFile(entry, '// cli');
    const binLink = path.join(prefix, 'bin', 'agents');
    fs.mkdirSync(path.dirname(binLink), { recursive: true });
    fs.symlinkSync(entry, binLink);

    expect(detectDevBuild(binLink, '1.20.27')).toBe(false);
  });

  it('a real agents-cli source checkout IS a dev build', () => {
    const repo = mkTmp();
    fs.mkdirSync(path.join(repo, '.git'));
    writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: '@phnx-labs/agents-cli' }));
    const entry = path.join(repo, 'dist', 'index.js');
    writeFile(entry, '// cli');

    expect(detectDevBuild(entry, '1.20.27')).toBe(true);
  });

  it('an unrelated ancestor git repo does not count as a dev build', () => {
    // A git repo whose root is NOT the agents-cli package (no/foreign package.json).
    const root = mkTmp();
    fs.mkdirSync(path.join(root, '.git'));
    writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'some-other-thing' }));
    const entry = path.join(root, 'dist', 'index.js');
    writeFile(entry, '// cli');

    expect(detectDevBuild(entry, '1.20.27')).toBe(false);
  });

  it('a plain install with no ancestor git repo is not a dev build', () => {
    const dir = mkTmp();
    const entry = path.join(dir, 'pkg', 'dist', 'index.js');
    writeFile(entry, '// cli');
    expect(detectDevBuild(entry, '1.20.27')).toBe(false);
  });

  it('a monorepo source checkout (package nested under cli) IS a dev build', () => {
    // This repo's layout: `.git` is at the true repo root, one level above the package (`cli`).
    // Both tsx from `cli/src/index.ts` and a built `cli/dist/index.js` must still be recognized as
    // a dev build (RUSH-2749).
    const repoRoot = mkTmp();
    fs.mkdirSync(path.join(repoRoot, '.git'));
    const packageRoot = path.join(repoRoot, 'apps', 'cli');
    writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@phnx-labs/agents-cli' }));

    const srcEntry = path.join(packageRoot, 'src', 'index.ts');
    writeFile(srcEntry, '// cli');
    expect(detectDevBuild(srcEntry, '1.22.39')).toBe(true);

    const distEntry = path.join(packageRoot, 'dist', 'index.js');
    writeFile(distEntry, '// cli');
    expect(detectDevBuild(distEntry, '1.22.39')).toBe(true);
  });

  it('a deeply nested global install stays outside the bounded ancestor search', () => {
    // nvm's global install layout: <nvm-root>/versions/node/vX/lib/node_modules/
    // @phnx-labs/agents-cli, with the nvm checkout's own `.git` several levels
    // above that -- well past the bound, so it must never read as a dev build.
    const nvmRoot = mkTmp();
    fs.mkdirSync(path.join(nvmRoot, '.git'));
    const pkgDir = path.join(nvmRoot, 'versions', 'node', 'v24.0.0', 'lib', 'node_modules', '@phnx-labs', 'agents-cli');
    writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@phnx-labs/agents-cli' }));
    const entry = path.join(pkgDir, 'dist', 'index.js');
    writeFile(entry, '// cli');

    expect(detectDevBuild(entry, '1.22.39')).toBe(false);
  });
});
