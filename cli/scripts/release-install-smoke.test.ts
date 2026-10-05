/** Real npm install of a packed tarball, no mocks: the bytes that would be published must install
 * and run. */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, 'release-install-smoke.sh');
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

describeUnix('release-install-smoke.sh', () => {
  it('installs a real npm tarball and runs the installed binary --version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-smoke-pkg-'));
    temps.push(dir);
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'dist', 'index.js'),
      '#!/usr/bin/env node\nconsole.log("9.9.9-smoke");\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: '@phnx-labs/agents-cli',
        version: '9.9.9-smoke',
        bin: { agents: 'dist/index.js' },
        files: ['dist'],
      }),
    );
    const pack = spawnSync('npm', ['pack', '--json'], { cwd: dir, encoding: 'utf-8' });
    expect(pack.status, pack.stderr).toBe(0);
    const packed = JSON.parse(pack.stdout) as Array<{ filename: string }>;
    const tgz = path.join(dir, packed[0].filename);
    expect(fs.existsSync(tgz)).toBe(true);

    const run = spawnSync('bash', [SCRIPT, tgz, '9.9.9-smoke'], { encoding: 'utf-8' });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(`${run.stdout}${run.stderr}`).toContain('9.9.9-smoke');
  });

  it('fails closed when the tarball is missing', () => {
    const run = spawnSync('bash', [SCRIPT, '/no/such/file.tgz'], { encoding: 'utf-8' });
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toContain('tarball not found');
  });
});
