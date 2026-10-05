import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_VERSION = (JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'),
) as { version: string }).version;

const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-evlimit-'));
  tempHomes.push(home);
  const systemDir = path.join(home, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: PACKAGE_VERSION }),
  );
  return home;
}

const ALPHA = 55;
const BETA = 45;

function seedEvents(home: string): void {
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const file = path.join(home, '.agents', '.history', 'events', day, 'events.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const base = Date.now() - 6 * 60 * 60 * 1000;
  const lines: string[] = [];
  for (let i = 0; i < ALPHA; i++) {
    lines.push(JSON.stringify({
      ts: new Date(base + i * 1000).toISOString(),
      event: 'pr.opened', level: 'info', module: 'alpha', command: 'alpha run',
    }));
  }
  for (let i = 0; i < BETA; i++) {
    lines.push(JSON.stringify({
      ts: new Date(base + (ALPHA + i) * 1000).toISOString(),
      event: 'pr.opened', level: 'info', module: 'beta', command: 'beta run',
    }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function runEvents(home: string, args: string[]) {
  return spawnSync('node', ['--import', 'tsx', 'src/index.ts', 'events', ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, SHELL: '/bin/zsh', AGENTS_EVENTS_PATH: '' },
    encoding: 'utf-8',
  });
}

function seededRecords(stdout: string): Array<Record<string, unknown>> {
  const start = stdout.indexOf('[');
  const parsed = JSON.parse(stdout.slice(start)) as Array<Record<string, unknown>>;
  return parsed.filter((r) => r.module === 'alpha' || r.module === 'beta');
}

function winner(records: Array<Record<string, unknown>>): string {
  const counts = new Map<string, number>();
  for (const r of records) counts.set(r.module as string, (counts.get(r.module as string) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

afterEach(() => {
  for (const h of tempHomes.splice(0)) {
    try {
      fs.rmSync(h, { recursive: true, force: true });
    } catch {
    }
  }
});

describe('agents events --limit', () => {
  it('reads the whole stream with --limit 0 and ranks correctly', () => {
    const home = makeTempHome();
    seedEvents(home);

    const res = runEvents(home, ['--event', 'pr.opened', '--limit', '0', '--json']);
    expect(res.status, res.stderr).toBe(0);
    const records = seededRecords(res.stdout);

    expect(records).toHaveLength(ALPHA + BETA);
    expect(winner(records)).toBe('alpha');
    expect(res.stderr).not.toContain('--limit 0 for all');
  });

  it('caps at the default 50 and says so, instead of silently truncating', () => {
    const home = makeTempHome();
    seedEvents(home);

    const res = runEvents(home, ['--event', 'pr.opened', '--json']);
    expect(res.status, res.stderr).toBe(0);
    const records = seededRecords(res.stdout);

    expect(records.length).toBeLessThan(ALPHA + BETA);
    expect(winner(records)).toBe('beta');
    expect(res.stderr).toContain('Showing the newest 50');
    expect(res.stderr).toContain('--limit 0 for all');
  });

  it('keeps stdout valid JSON when the cap notice fires', () => {
    const home = makeTempHome();
    seedEvents(home);

    const res = runEvents(home, ['--event', 'pr.opened', '--json']);
    expect(() => JSON.parse(res.stdout.slice(res.stdout.indexOf('[')))).not.toThrow();
  });

  it('rejects a non-numeric --limit instead of falling back to 50', () => {
    const home = makeTempHome();
    seedEvents(home);

    const res = runEvents(home, ['--event', 'pr.opened', '--limit', 'abc', '--json']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('Invalid --limit abc');
  });

  it('rejects a negative --limit', () => {
    const home = makeTempHome();
    seedEvents(home);

    const res = runEvents(home, ['--event', 'pr.opened', '--limit', '-5', '--json']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('Invalid --limit');
  });

  it.each([['empty', ''], ['whitespace', '   ']])(
    'rejects an %s --limit instead of reading the whole stream unannounced',
    (_label, value) => {
      const home = makeTempHome();
      seedEvents(home);

      const res = runEvents(home, ['--event', 'pr.opened', '--limit', value, '--json']);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('Invalid --limit');
    },
  );
});
