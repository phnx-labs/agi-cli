import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe.skipIf(process.platform === 'win32')('agents view — isolated installs vs the global CLI', () => {
  let home: string;
  const GLOBAL_VERSION = '0.55.0';

  const versionDir = (v: string) => path.join(home, '.agents', '.history', 'versions', 'codex', v);

  function plantVersion(version: string, { isolated }: { isolated: boolean }) {
    const binDir = path.join(versionDir(version), 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(versionDir(version), 'home', '.codex'), { recursive: true });
    fs.writeFileSync(path.join(binDir, 'codex'), `#!/bin/sh\necho "codex-cli ${version}"\n`);
    fs.chmodSync(path.join(binDir, 'codex'), 0o755);
    if (isolated) fs.writeFileSync(path.join(versionDir(version), '.isolated'), `${new Date().toISOString()}\n`);
  }

  function view(diagnostics = true): string {
    return execFileSync('bun', [path.resolve(process.cwd(), 'src/index.ts'), 'view', 'codex', ...(diagnostics ? ['--versions'] : [])], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        PATH: `${path.join(home, 'npm-global', 'bin')}:${process.env.PATH}`,
        SHELL: '/bin/bash',
        AGENTS_NO_NUDGE: '1',
        FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString('utf-8');
  }

  function viewJson(): { versions: Array<{ version: string; authVerdict: string | null; signedIn: boolean; launchable: boolean }> } {
    return JSON.parse(execFileSync('bun', [path.resolve(process.cwd(), 'src/index.ts'), 'view', 'codex', '--json'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        PATH: `${path.join(home, 'npm-global', 'bin')}:${process.env.PATH}`,
        SHELL: '/bin/bash',
        AGENTS_NO_NUDGE: '1',
        AGENTS_SYNC_MACHINE_ID: 'view-json-test-host',
        FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString('utf-8')) as { versions: Array<{ version: string; authVerdict: string | null }> };
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'view-isolated-'));
    const pkgBin = path.join(home, 'npm-global', 'lib', 'node_modules', '@openai', 'codex', 'bin');
    fs.mkdirSync(pkgBin, { recursive: true });
    fs.mkdirSync(path.join(home, 'npm-global', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkgBin, 'codex.js'), `#!/bin/sh\necho "codex-cli ${GLOBAL_VERSION}"\n`);
    fs.chmodSync(path.join(pkgBin, 'codex.js'), 0o755);
    fs.symlinkSync('../lib/node_modules/@openai/codex/bin/codex.js', path.join(home, 'npm-global', 'bin', 'codex'));
    const systemDir = path.join(home, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: systemDir, stdio: 'ignore' });
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('lists an isolated copy AND the untouched global install, tagging the isolated one', () => {
    plantVersion('9.9.4', { isolated: true });
    const out = view();

    expect(out).toContain('9.9.4');
    expect(out).toContain('(isolated)');
    expect(out).toContain('Not Managed by Agents CLI');
    expect(out).toContain(`${GLOBAL_VERSION} (global)`);
  }, 120_000);

  it('still hides the global row once a NORMAL version takes over the launcher', () => {
    plantVersion('9.9.4', { isolated: false });
    const out = view();

    expect(out).toContain('9.9.4');
    expect(out).not.toContain('Not Managed by Agents CLI');
    expect(out).not.toContain('(isolated)');
  }, 120_000);

  it('reports the global install alone when nothing is managed', () => {
    const out = view();

    expect(out).toContain('Not Managed by Agents CLI');
    expect(out).toContain(`${GLOBAL_VERSION} (global)`);
    expect(out).not.toContain('(isolated)');
  }, 120_000);

  it('emits each installed version auth verdict in JSON for remote placement', () => {
    plantVersion('9.9.4', { isolated: false });
    const cacheDir = path.join(home, '.agents', '.cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, '.auth-health.json'), JSON.stringify({
      version: 1,
      entries: {
        'view-json-test-host:codex:9.9.4': { verdict: 'revoked', checkedAt: 1 },
      },
    }));

    expect(viewJson().versions).toContainEqual(expect.objectContaining({
      version: '9.9.4',
      authVerdict: 'revoked',
    }));
  }, 120_000);

  it('emits a per-version launchable flag in JSON for remote placement', () => {
    plantVersion('9.9.4', { isolated: false });
    const version = viewJson().versions.find((v) => v.version === '9.9.4');
    expect(version).toBeDefined();
    expect(version!.signedIn).toBe(false);
    expect(version!.launchable).toBe(false);
  }, 120_000);

  it('groups duplicate native identities without deleting homes, while JSON retains both installations', () => {
    const labels = ['9.9.4', '9.9.5'];
    const payload = Buffer.from(JSON.stringify({
      email: 'account-view@example.com',
      'https://api.openai.com/auth': { chatgpt_account_id: 'view-fixture-account', chatgpt_user_id: 'view-fixture-user' },
    })).toString('base64url');
    const credential = JSON.stringify({ tokens: { id_token: `fixture.${payload}.unsigned` } });
    for (const label of labels) {
      plantVersion(label, { isolated: false });
      fs.writeFileSync(path.join(versionDir(label), 'home', '.codex', 'auth.json'), credential);
    }

    const normal = view(false);
    expect(normal.match(/account-view@example\.com/g)).toHaveLength(1);
    expect(normal).not.toContain('9.9.4');
    expect(normal).not.toContain('9.9.5');
    const diagnostics = view();
    expect(diagnostics).toContain('9.9.4');
    expect(diagnostics).toContain('9.9.5');
    const data = viewJson() as ReturnType<typeof viewJson> & { accounts: unknown[] };
    expect(data.versions).toHaveLength(2);
    expect(data.accounts).toHaveLength(1);
    for (const label of labels) {
      expect(fs.readFileSync(path.join(versionDir(label), 'home', '.codex', 'auth.json'), 'utf-8')).toBe(credential);
    }
  }, 120_000);
});
