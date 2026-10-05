import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe.skipIf(process.platform === 'win32')('resuming an isolated session', () => {
  let home: string;
  const V = '9.9.4';

  const shimsDir = () => path.join(home, '.agents', '.cache', 'shims');

  function plantIsolated() {
    const vdir = path.join(home, '.agents', '.history', 'versions', 'codex', V);
    fs.mkdirSync(path.join(vdir, 'node_modules', '.bin'), { recursive: true });
    fs.mkdirSync(path.join(vdir, 'home', '.codex'), { recursive: true });
    fs.writeFileSync(path.join(vdir, 'package.json'), '{}');
    fs.writeFileSync(path.join(vdir, 'node_modules', '.bin', 'codex'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(vdir, 'node_modules', '.bin', 'codex'), 0o755);
    fs.writeFileSync(path.join(vdir, '.isolated'), 'x\n');
    fs.mkdirSync(shimsDir(), { recursive: true });
    const alias = path.join(shimsDir(), `codex@${V}`);
    fs.writeFileSync(alias, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(alias, 0o755);
  }

  function resumeCmd(version?: string): string[] | null {
    const script = `
      import { buildResumeCommand } from ${JSON.stringify(path.resolve(process.cwd(), 'src/commands/sessions.ts'))};
      console.log('__R__' + JSON.stringify(buildResumeCommand(
        { agent: 'codex', id: 'sess-123', version: ${version ? JSON.stringify(version) : 'undefined'} }
      )));
    `;
    const out = execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, AGENTS_REAL_HOME: home, SHELL: '/bin/bash' },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString();
    return JSON.parse(out.split('__R__')[1]);
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'isolated-resume-'));
    const systemDir = path.join(home, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: systemDir, stdio: 'ignore' });
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('resolves the versioned alias by absolute path, not through PATH', () => {
    plantIsolated();
    const cmd = resumeCmd(V);
    expect(cmd).not.toBeNull();
    expect(path.isAbsolute(cmd![0])).toBe(true);
    expect(cmd![0]).toBe(path.join(shimsDir(), `codex@${V}`));
    expect((process.env.PATH ?? '').split(path.delimiter)).not.toContain(shimsDir());
  }, 120_000);

  it('uses codex\'s real resume verb, never a /continue slash command', () => {
    plantIsolated();
    expect(resumeCmd(V)!.slice(1)).toEqual(['resume', 'sess-123']);
    expect(resumeCmd()).toEqual(['codex', 'resume', 'sess-123']);
  }, 120_000);

  it('falls back to a real resume against the current version, not /continue', () => {
    const cmd = resumeCmd('0.0.0-missing');
    expect(cmd).toEqual(['codex@0.0.0-missing', 'resume', 'sess-123']);
    expect(cmd!.some((a) => a.startsWith('/'))).toBe(false);
  }, 120_000);
});
