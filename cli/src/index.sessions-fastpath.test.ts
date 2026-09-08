import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { runAgents, writeUpdateCache } from './commands/sessions.test-fixture.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function stubSessions(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-fastpath-'));
  temps.push(dir);
  const bin = path.join(dir, 'sessions');
  fs.writeFileSync(
    bin,
    `#!/bin/sh\necho STUB_SESSIONS_OK\nprintf '%s\\n' "$@" > "${dir}/argv"\n`,
    { mode: 0o755 },
  );
  return bin;
}

describe('index.ts sessions read fast-path (PHNX-4012)', () => {
  it('execs SESSIONS_BIN for a search without loading the sessions command module', () => {
    const bin = stubSessions();
    const r = spawnSync('bun', [INDEX, 'sessions', 'auth', '--json', '--limit', '5'], {
      cwd: REPO_ROOT,
      env: { ...process.env, SESSIONS_BIN: bin, AGENTS_NO_AUTOPULL: '1' },
      encoding: 'utf-8',
      timeout: 15_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('STUB_SESSIONS_OK');
    const argv = fs.readFileSync(path.join(path.dirname(bin), 'argv'), 'utf-8').trim().split('\n');
    expect(argv).toEqual(['auth', '--json', '--limit', '5']);
  });

  it('falls through to the in-repo engine when no standalone sessions binary is installed', () => {
    // Every fleet worker and CI runner is a box without @phnx-labs/sessions-cli
    // (it is not published yet). A read query there must answer as it did
    // before PHNX-4012, not refuse with "not installed": main's attestation
    // suite went red on exactly that (sessions.cli-list / sessions.fleet-json).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-fallback-'));
    try {
      writeUpdateCache(home);
      const cleanPath = (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter((dir) => dir && !fs.existsSync(path.join(dir, 'sessions')))
        .join(path.delimiter);
      const r = runAgents(['sessions', '--json', '--no-interactive'], REPO_ROOT, home, { PATH: cleanPath, SESSIONS_BIN: '', AGENTS_NO_AUTOPULL: '1' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain('using the in-process engine');
      expect(r.stderr).not.toContain('Install it, then re-run');
      expect(() => JSON.parse(r.stdout)).not.toThrow();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not intercept resume — that stays on the in-repo engine', () => {
    const bin = stubSessions();
    const r = spawnSync('bun', [INDEX, 'sessions', 'resume', '--help'], {
      cwd: REPO_ROOT,
      env: { ...process.env, SESSIONS_BIN: bin, AGENTS_NO_AUTOPULL: '1' },
      encoding: 'utf-8',
      timeout: 20_000,
    });
    expect(r.stdout).not.toContain('STUB_SESSIONS_OK');
  });
});
