import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateHookShim, type HookShimPaths } from './cache.js';

describe('generated shim — bash execution', () => {
  let tmpHome: string;
  let scriptPath: string;
  let callCounterFile: string;
  let paths: HookShimPaths;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shim-integ-'));
    paths = {
      shimsDir: path.join(tmpHome, 'shims'),
      cacheDir: path.join(tmpHome, 'cache'),
      logsDir: path.join(tmpHome, 'logs'),
      perfDir: path.join(tmpHome, 'perf'),
    };

    callCounterFile = path.join(tmpHome, 'counter');
    fs.writeFileSync(callCounterFile, '0');
    scriptPath = path.join(tmpHome, 'real-hook.sh');
    fs.writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash
read -r line
count=$(cat ${JSON.stringify(callCounterFile)})
count=$((count + 1))
echo "$count" > ${JSON.stringify(callCounterFile)}
echo "call=$count"
`,
      { mode: 0o755 }
    );
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function runShim(shim: string, stdin: string): { stdout: string; exit: number } {
    try {
      const stdout = execFileSync('bash', [shim], { input: stdin, encoding: 'utf-8' });
      return { stdout, exit: 0 };
    } catch (err: any) {
      return { stdout: err.stdout?.toString() ?? '', exit: err.status ?? 1 };
    }
  }

  it('caches stdout — second call within ttl reuses the cached output (no re-invocation)', () => {
    const shim = generateHookShim({
      name: 'counter-hook',
      scriptPath,
      cache: { ttl: 300, key: 'global', prefetch: 'none' },
      paths,
    });

    const first = runShim(shim, '{}');
    expect(first.stdout.trim()).toBe('call=1');
    expect(fs.readFileSync(callCounterFile, 'utf-8').trim()).toBe('1');

    const second = runShim(shim, '{}');
    expect(second.stdout.trim()).toBe('call=1');
    expect(fs.readFileSync(callCounterFile, 'utf-8').trim()).toBe('1');
  });

  it('re-runs the script when the cache file is older than ttl', () => {
    const shim = generateHookShim({
      name: 'short-ttl-hook',
      scriptPath,
      cache: { ttl: 1, key: 'global', prefetch: 'none' },
      paths,
    });

    const first = runShim(shim, '{}');
    expect(first.stdout.trim()).toBe('call=1');

    const cacheFile = path.join(paths.cacheDir!, 'short-ttl-hook.out');
    expect(fs.existsSync(cacheFile)).toBe(true);
    const past = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(cacheFile, past, past);

    const second = runShim(shim, '{}');
    expect(second.stdout.trim()).toBe('call=2');
    expect(fs.readFileSync(callCounterFile, 'utf-8').trim()).toBe('2');
  });

  it('appends a hook.fire event to the daily JSONL on every fire', () => {
    const shim = generateHookShim({
      name: 'logged-hook',
      scriptPath,
      cache: { ttl: 300, key: 'global', prefetch: 'none' },
      paths,
    });

    runShim(shim, '{}');
    runShim(shim, '{}');

    const files = fs.readdirSync(paths.logsDir!).filter(f => f.startsWith('events-'));
    expect(files.length).toBe(1);
    const lines = fs.readFileSync(path.join(paths.logsDir!, files[0]), 'utf-8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(lines.length).toBe(2);
    expect(lines[0].event).toBe('hook.fire');
    expect(lines[0].hook).toBe('logged-hook');
    expect(lines[0].cache).toBe('miss');
    expect(lines[1].cache).toBe('hit');
    expect(typeof lines[0].ms).toBe('number');
  });

  it('appends matching rows to the perf spool for the disposable warehouse', () => {
    const shim = generateHookShim({
      name: 'perf-spooled-hook',
      scriptPath,
      cache: { ttl: 300, key: 'global', prefetch: 'none' },
      paths,
    });

    runShim(shim, '{}');
    runShim(shim, '{}');

    const spool = path.join(paths.perfDir!, 'spool.jsonl');
    expect(fs.existsSync(spool)).toBe(true);
    const lines = fs.readFileSync(spool, 'utf-8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(lines.length).toBe(2);
    expect(lines[0].kind).toBe('hook.fire');
    expect(lines[0].label).toBe('perf-spooled-hook');
    expect(lines[0].cache).toBe('miss');
    expect(lines[1].cache).toBe('hit');
    expect(typeof lines[0].duration_ms).toBe('number');
    expect(typeof lines[0].ts_ms).toBe('number');
  });

  it('per-cwd key produces distinct cache files keyed on stdin cwd', () => {
    const shim = generateHookShim({
      name: 'per-cwd-hook',
      scriptPath,
      cache: { ttl: 300, key: 'per-cwd', prefetch: 'none' },
      paths,
    });

    const a = runShim(shim, JSON.stringify({ cwd: '/some/repo/a' }));
    const b = runShim(shim, JSON.stringify({ cwd: '/some/repo/b' }));
    expect(a.stdout.trim()).toBe('call=1');
    expect(b.stdout.trim()).toBe('call=2');

    const a2 = runShim(shim, JSON.stringify({ cwd: '/some/repo/a' }));
    expect(a2.stdout.trim()).toBe('call=1');
    expect(fs.readFileSync(callCounterFile, 'utf-8').trim()).toBe('2');
  });

  it('carries cwd and session_id from the hook stdin JSON into the perf-spool line', () => {
    const shim = generateHookShim({
      name: 'attributed-hook',
      scriptPath,
      cache: { ttl: 300, key: 'global', prefetch: 'none' },
      paths,
    });

    runShim(shim, JSON.stringify({ cwd: '/some/repo/attributed', session_id: 'sess-123' }));

    const spool = path.join(paths.perfDir!, 'spool.jsonl');
    const [line] = fs.readFileSync(spool, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(line.cwd).toBe('/some/repo/attributed');
    expect(line.session_id).toBe('sess-123');
  });

  it('carries cwd/session_id through the pass-through (no-cache, matcher-only) tail too', () => {
    const shim = generateHookShim({
      name: 'guard-like-hook',
      scriptPath,
      cache: null,
      matches: { tool_name: 'Bash' },
      paths,
    });

    runShim(shim, JSON.stringify({ cwd: '/some/repo/guard', session_id: 'sess-guard', tool_name: 'Bash' }));

    const spool = path.join(paths.perfDir!, 'spool.jsonl');
    const [line] = fs.readFileSync(spool, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(line.cache).toBe('none');
    expect(line.cwd).toBe('/some/repo/guard');
    expect(line.session_id).toBe('sess-guard');
  });

  function waitFor(pred: () => boolean, timeoutMs = 3000): boolean {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pred()) return true;
      execFileSync('bash', ['-c', 'sleep 0.05']);
    }
    return pred();
  }

  it('reclaims a stale bg lockdir and refreshes, instead of stalling forever', () => {
    const shim = generateHookShim({
      name: 'stale-lock-hook',
      scriptPath,
      cache: { ttl: 1, key: 'global', prefetch: 'background' },
      paths,
    });
    const cacheFile = path.join(paths.cacheDir!, 'stale-lock-hook.out');
    const lockDir = `${cacheFile}.bg.lck`;

    expect(runShim(shim, '{}').stdout.trim()).toBe('call=1');
    const past = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(cacheFile, past, past);

    fs.mkdirSync(lockDir, { recursive: true });
    fs.utimesSync(lockDir, past, past);

    const fire = runShim(shim, '{}');
    expect(fire.stdout.trim()).toBe('call=1');

    const refreshed = waitFor(() => {
      try { return fs.readFileSync(cacheFile, 'utf-8').trim() === 'call=2'; }
      catch { return false; }
    });
    expect(refreshed).toBe(true);
    expect(waitFor(() => !fs.existsSync(lockDir))).toBe(true);
  });

  it('does NOT reclaim a fresh bg lockdir — a live refresh is left alone', () => {
    const shim = generateHookShim({
      name: 'fresh-lock-hook',
      scriptPath,
      cache: { ttl: 1, key: 'global', prefetch: 'background' },
      paths,
    });
    const cacheFile = path.join(paths.cacheDir!, 'fresh-lock-hook.out');
    const lockDir = `${cacheFile}.bg.lck`;

    expect(runShim(shim, '{}').stdout.trim()).toBe('call=1');
    const past = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(cacheFile, past, past);

    fs.mkdirSync(lockDir, { recursive: true });

    expect(runShim(shim, '{}').stdout.trim()).toBe('call=1');
    execFileSync('bash', ['-c', 'sleep 0.3']);
    expect(fs.readFileSync(callCounterFile, 'utf-8').trim()).toBe('1');
    expect(fs.existsSync(lockDir)).toBe(true);
  });

  it('omits cwd/session_id from the perf-spool line when stdin carries neither', () => {
    const shim = generateHookShim({
      name: 'unattributed-hook',
      scriptPath,
      cache: { ttl: 300, key: 'global', prefetch: 'none' },
      paths,
    });

    runShim(shim, '{}');

    const spool = path.join(paths.perfDir!, 'spool.jsonl');
    const [line] = fs.readFileSync(spool, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(line.cwd).toBeUndefined();
    expect(line.session_id).toBeUndefined();
  });
});
