import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const cliEntry = path.join(repoRoot, 'src', 'index.ts');
const tsxBin = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

let home: string;

function run(args: string[]) {
  const res = spawnSync(process.execPath, [tsxBin, cliEntry, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, NODE_NO_WARNINGS: '1', AGENTS_SESSIONS_DB: '' },
    encoding: 'utf-8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function bothSpellings(extra: string[], selector?: string) {
  const sel = selector ? [selector] : [];
  return [run(['cloud', 'transcripts', ...sel, ...extra]), run(['sessions', ...sel, '--cloud', ...extra])];
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-transcripts-'));
  fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
  const local = path.join(home, '.claude', 'projects', '-work-proj');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(
    path.join(local, '44444444-4444-4444-8444-444444444444.jsonl'),
    JSON.stringify({ type: 'user', timestamp: '2026-10-01T00:00:00.000Z', sessionId: '44444444-4444-4444-8444-444444444444', cwd: '/work/proj', uuid: 'u1', message: { role: 'user', content: 'local only' } }) + '\n',
  );
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('agents cloud transcripts (real CLI)', () => {
  it('exits 1 without a Rush login and never falls back to local sessions, like sessions --cloud', () => {
    for (const selector of [undefined, '44444444']) {
      for (const res of bothSpellings(['--json'], selector)) {
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('Failed to list cloud sessions: Not logged in to Rush');
        expect(res.stdout).toBe('');
      }
    }
  });

  it('exits 1 on an expired Rush session', () => {
    fs.mkdirSync(path.join(home, '.rush'), { recursive: true });
    fs.writeFileSync(path.join(home, '.rush', 'user.yaml'), 'session:\n  access_token: synthetic\n  expires_at: 1000\n');
    try {
      for (const res of bothSpellings(['--json'])) {
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('Rush session expired at 1970-01-01T00:00:01.000Z');
      }
    } finally {
      fs.rmSync(path.join(home, '.rush'), { recursive: true, force: true });
    }
  });

  it('rejects conflicting turn filters before contacting the service', () => {
    for (const res of bothSpellings(['--first', '1', '--last', '1'])) {
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('--first and --last are mutually exclusive');
    }
  });
});
