import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { migrateAgentsYaml } from '../installations/migrate.js';


let tmp: string;
let systemDir: string;
let userDir: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function porcelain(cwd: string): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf-8' }).trim();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-mirror-'));
  systemDir = path.join(tmp, '.agents', '.system');
  userDir = path.join(tmp, '.agents');
  fs.mkdirSync(systemDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('migrateAgentsYaml — system mirror is read-only', () => {
  it('never dirties the tracked agents.yaml in a pull-only system mirror', () => {
    const shipped = 'hooks:\n  session-start:\n    events:\n      - SessionStart\n';
    fs.writeFileSync(path.join(systemDir, 'agents.yaml'), shipped);
    git(systemDir, 'init', '-q');
    git(systemDir, 'add', 'agents.yaml');
    git(systemDir, 'commit', '-q', '-m', 'ship defaults', '--no-gpg-sign');

    expect(porcelain(systemDir)).toBe('');

    migrateAgentsYaml(systemDir, userDir);

    expect(fs.existsSync(path.join(systemDir, 'agents.yaml'))).toBe(true);
    expect(fs.readFileSync(path.join(systemDir, 'agents.yaml'), 'utf-8')).toBe(shipped);
    expect(porcelain(systemDir)).toBe('');

    expect(fs.existsSync(path.join(userDir, 'agents.yaml'))).toBe(false);
  });

  it('is idempotent against a tracked mirror across repeated runs', () => {
    fs.writeFileSync(path.join(systemDir, 'agents.yaml'), 'hooks: {}\n');
    git(systemDir, 'init', '-q');
    git(systemDir, 'add', 'agents.yaml');
    git(systemDir, 'commit', '-q', '-m', 'ship', '--no-gpg-sign');

    migrateAgentsYaml(systemDir, userDir);
    migrateAgentsYaml(systemDir, userDir);

    expect(fs.existsSync(path.join(systemDir, 'agents.yaml'))).toBe(true);
    expect(porcelain(systemDir)).toBe('');
  });

  it('still migrates an UNTRACKED legacy agents.yaml out of a non-git system dir', () => {
    fs.writeFileSync(path.join(systemDir, 'agents.yaml'), 'agents:\n  claude: "1.0.0"\n');

    migrateAgentsYaml(systemDir, userDir);

    expect(fs.existsSync(path.join(systemDir, 'agents.yaml'))).toBe(false);
    expect(fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf-8')).toContain('claude');
  });
});
