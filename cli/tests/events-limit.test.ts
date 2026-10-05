/**
 * `agents events --limit` truncation tests. Drive the REAL CLI entry (via tsx)
 * against a temp HOME seeded with a real events.jsonl, then assert on the
 * records it returns.
 *
 * The bug these cover: `--limit` defaulted to 50 and was applied silently, with
 * `--limit 0` collapsing to 50 (`0 || 50`), so there was no way to read the
 * whole stream. Any aggregation over `--json` therefore ranked the newest 50
 * records and reported a confidently wrong answer — measured on a real 7-day
 * friction corpus (2135 events, 9 classes): 8 of 9 ranks wrong, counts off by
 * ~100x, no warning.
 *
 * No mocking — the same code path a real invocation takes.
 */
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

/**
 * Seed `alpha` (older, more numerous) and `beta` (newest) so the two answers
 * disagree: over the full set alpha wins 55-45; over the newest 50 beta wins
 * 45-5. That inversion is exactly what a silent cap produces.
 */
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

/** Parse `--json` stdout into records, ignoring the CLI's own audit rows. */
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
      /* best-effort */
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
    // The true answer: alpha is the more frequent module.
    expect(winner(records)).toBe('alpha');
    // Nothing was capped, so nothing is announced.
    expect(res.stderr).not.toContain('--limit 0 for all');
  });

  it('caps at the default 50 and says so, instead of silently truncating', () => {
    const home = makeTempHome();
    seedEvents(home);

    const res = runEvents(home, ['--event', 'pr.opened', '--json']);
    expect(res.status, res.stderr).toBe(0);
    const records = seededRecords(res.stdout);

    expect(records.length).toBeLessThan(ALPHA + BETA);
    // The clipped slice yields the WRONG winner — which is why the cap must be
    // announced rather than left for the caller to discover.
    expect(winner(records)).toBe('beta');
    expect(res.stderr).toContain('Showing the newest 50');
    expect(res.stderr).toContain('--limit 0 for all');
  });

  it('keeps stdout valid JSON when the cap notice fires', () => {
    const home = makeTempHome();
    seedEvents(home);

    const res = runEvents(home, ['--event', 'pr.opened', '--json']);
    // The notice must not contaminate the pipe: stdout parses on its own.
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

  // `Number('')` and `Number('   ')` are both 0, which the cap resolver reads as
  // "no cap". An unset shell variable — `agents events --limit "$LIMIT"` — would
  // therefore return the entire unbounded stream with exit 0 and no notice: the
  // same silent-wrong-answer this ticket exists to remove, in the other direction.
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
