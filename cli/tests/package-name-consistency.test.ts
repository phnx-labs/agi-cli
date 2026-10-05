
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const NPM_PACKAGE = '@phnx-labs/agents-cli';
const GITHUB_REPO = 'github.com/phnx-labs/agi-cli';

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

describe('package-name consistency (@phnx-labs canonical)', () => {
  it('package.json declares the canonical npm name', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.name).toBe(NPM_PACKAGE);
    expect(pkg.name).not.toContain('agi-cli');
  });

  it('package.json repository.url points to the real github repo', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.repository?.url ?? '').toContain(GITHUB_REPO);
    expect(pkg.repository?.url ?? '').not.toContain('github.com/companion');
  });

  it('package.json bugs.url points to the real github repo', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.bugs?.url ?? '').toContain(GITHUB_REPO);
    expect(pkg.bugs?.url ?? '').not.toContain('github.com/companion');
  });

  it('slim index.ts and bootstrap never reference the old @companion npm scope', () => {
    expect(read('src/index.ts')).not.toContain('@companion/agents-cli');
    expect(read('src/bootstrap.ts')).not.toContain('@companion/agents-cli');
  });

  it('upgrade installs are built from the canonical package constant', () => {
    const selfUpdate = read('src/lib/self-update.ts');
    expect(selfUpdate).toContain(`export const NPM_PACKAGE_NAME = '${NPM_PACKAGE}';`);
    expect(selfUpdate).not.toContain('@companion');
    const src = read('src/bootstrap.ts');
    const metadataFetches = src.match(/registry\.npmjs\.org\/\$\{NPM_PACKAGE_NAME\}\//g) ?? [];
    expect(metadataFetches.length).toBeGreaterThan(0);
    expect(src).toContain('downloadVerifiedTarball(metadata.tarball, metadata.integrity)');
  });

  it('bootstrap.ts version-check URLs target the canonical package', () => {
    const src = read('src/bootstrap.ts');
    expect(src).toContain(`unpkg.com/${NPM_PACKAGE}`);
    expect(src).toContain(`registry.npmjs.org/${NPM_PACKAGE}/latest`);
    expect(src).not.toContain('unpkg.com/@companion/agents-cli');
    expect(src).not.toContain('registry.npmjs.org/@companion/agents-cli');
  });

  it('postinstall script references the canonical package', () => {
    const post = read('scripts/postinstall.js');
    expect(post).toContain(NPM_PACKAGE);
    expect(post).not.toContain('@companion/agents-cli');
  });

  it('public teams import path comment matches the canonical package', () => {
    const teamsIndex = read('src/lib/teams/index.ts');
    expect(teamsIndex).toContain("'@phnx-labs/agents-cli/teams'");
    expect(teamsIndex).not.toContain('@companion');
  });
});
