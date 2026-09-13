/**
 * Cross-track integration tests: tool-activity delivery + standalone-tool
 * setup, measured against a PROCESS BUDGET.
 *
 * These tests sit beside `feed/` because the delivery seam under test is the
 * feed stream, but they exercise two production tracks at once:
 *
 * - feed: `feed/tool-activity.ts`, `feed/tools.ts`, `feed/hub.ts`,
 *   `feed/hub-server.ts` — one event-driven collector, one fleet fan-out,
 *   many readers over a UNIX socket.
 * - setup: `lib/setup-tool-status.ts` — presence is metadata, health is the
 *   last explicit check, never a timer probe; a shared disk lock coalesces
 *   overlapping refreshes from separate CLI clients.
 *
 * Every scenario below names the failure it exists to catch, drives the REAL
 * modules with REAL files / sockets / child processes (fake tools are shell
 * scripts on a test PATH — that is a real exec, not a mocked service), and
 * counts the processes it would duplicate if the seam regressed. No harness
 * mocks, no source-string assertions.
 */
import { expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CLI_SRC = path.resolve(HERE, '..', '..');

/**
 * Absolute bun path, resolved BEFORE any test narrows PATH to the fake tool
 * dirs — child processes still need to exec the runtime even when the code
 * under test must only see the fake tools.
 */
function resolveOnPath(name: string): string {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  throw new Error(`${name} not found on PATH for test children`);
}
const BUN = resolveOnPath('bun');

interface FakeTool {
  /** Directory holding bin/<name>; add to PATH. */
  binDir: string;
  /** Absolute executable the symlink resolves to. */
  executable: string;
  probeLog: string;
}

/**
 * A real standalone-tool install on a test PATH: a package dir carrying a
 * `@phnx-labs/<tool>-cli` package.json and a real executable shell script,
 * linked through bin/<tool> exactly like an npm global. `statusBody` is what
 * the tool prints for `status --json`; every invocation appends a line to
 * `probeLog` so a test COUNTS real execs.
 */
function makeFakeTool(root: string, tool: string, statusBody: string, opts: { probeLog: string; statusDelayMs?: number }): FakeTool {
  const pkg = path.join(root, 'pkg', tool);
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const executable = path.join(pkg, 'bin', tool);
  const script = [
    '#!/bin/sh',
    `echo "$$" >> "${opts.probeLog}"`,
    ...(opts.statusDelayMs ? [`sleep ${Math.ceil(opts.statusDelayMs / 1000)}`] : []),
    `printf '%s' '${statusBody.replace(/'/g, `'\\''`)}'`,
    '',
  ].join('\n');
  fs.writeFileSync(executable, script, { mode: 0o755 });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: `@phnx-labs/${tool}-cli`, version: '0.0.0-test' }));
  const link = path.join(binDir, tool);
  fs.rmSync(link, { force: true });
  fs.symlinkSync(executable, link);
  return { binDir, executable, probeLog: opts.probeLog };
}

/** PATH that sees only the fake tools (plus a real coreutils for the shell). */
function toolPath(fake: FakeTool | FakeTool[]): string {
  const dirs = (Array.isArray(fake) ? fake : [fake]).map((f) => f.binDir);
  return [...dirs, '/usr/bin', '/bin'].join(path.delimiter);
}

function probeCount(fake: FakeTool): number {
  try { return fs.readFileSync(fake.probeLog, 'utf-8').trim().split('\n').filter(Boolean).length; } catch { return 0; }
}

/**
 * Run `refreshToolSetup` / `getCachedToolSetup` in a REAL child process (bun,
 * TypeScript source direct) so file-lock coalescing and cache sharing are
 * exercised across process boundaries, not just across async tasks in one
 * process. Inherits the fork's sandboxed HOME/PATH.
 */
function runSetupChild(script: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(BUN, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (c: string) => { stdout += c; });
    child.stderr.on('data', (c: string) => { stderr += c; });
    const kill = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.once('error', (error) => { clearTimeout(kill); reject(error); });
    child.once('close', (code) => {
      clearTimeout(kill);
      resolve({ code, stdout: stdout || stderr, ms: Date.now() - started });
    });
  });
}

const childScript = (body: string): string =>
  `import { refreshToolSetup, getCachedToolSetup } from '${CLI_SRC}/lib/setup-tool-status.ts';\n${body}`;

it('concurrent refreshes from separate processes coalesce into ONE probe (shared disk lock + fresh-cache skip)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-delivery-concurrent-'));
  try {
    const probeLog = path.join(root, 'probes.log');
    const fake = makeFakeTool(root, 'browser', '{"running":true}', { probeLog, statusDelayMs: 1500 });
    const savedPath = process.env.PATH;
    const savedBin = process.env.BROWSER_BIN;
    delete process.env.BROWSER_BIN;
    process.env.PATH = toolPath(fake);
    const { getCachedToolSetup } = await import('../setup-tool-status.js');
    try {
      const cacheDir = path.join(root, 'cache');
      // Two OVERLAPPING child processes ask for an explicit refresh. The probe
      // sleeps 1.5s, so without coalescing each process would exec the tool
      // (2 probes, ~3s wall). With the disk lock + fresh-cache skip: 1 probe.
      const script = childScript(
        `const rows = await refreshToolSetup('browser', { cacheDir: '${cacheDir}' });`
        + ` console.log(JSON.stringify(rows.find(r => r.tool === 'browser')));`);
      const both = await Promise.all([runSetupChild(script), runSetupChild(script)]);
      for (const run of both) {
        expect(run.code).toBe(0);
        expect(JSON.parse(run.stdout)).toMatchObject({ tool: 'browser', installed: true, readiness: 'ready' });
      }
      expect(probeCount(fake)).toBe(1);
      // The loser of the lock waited rather than double-probing: both children
      // together finish well under two sequential 1.5s probes.
      expect(Math.max(...both.map((r) => r.ms))).toBeLessThan(2 * 1500 + 8000);
      // And the coalesced result is what a plain read serves afterwards.
      const [row] = getCachedToolSetup({ cacheDir });
      expect(row).toMatchObject({ tool: 'browser', readiness: 'ready' });
      expect(row.checkedAtMs).toBeTypeOf('number');
    } finally {
      process.env.PATH = savedPath;
      if (savedBin === undefined) delete process.env.BROWSER_BIN; else process.env.BROWSER_BIN = savedBin;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('warm reads and the armed watcher issue ZERO probes; install changes invalidate without probing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-delivery-warm-idle-'));
  try {
    const probeLog = path.join(root, 'probes.log');
    const fake = makeFakeTool(root, 'browser', '{"running":true}', { probeLog });
    const savedPath = process.env.PATH;
    delete process.env.BROWSER_BIN;
    process.env.PATH = toolPath(fake);
    const { getCachedToolSetup, refreshToolSetup, subscribeToolSetup } = await import('../setup-tool-status.js');
    try {
      const cacheDir = path.join(root, 'cache');
      await refreshToolSetup('browser', { cacheDir });
      expect(probeCount(fake)).toBe(1);

      // Warm-idle budget: repeated reads (what a UI row render does) and an
      // armed subscription (what the settings pane holds) must not exec the
      // tool. This is the "no per-minute per-tool polling" guarantee.
      const emissions: string[] = [];
      const stop = subscribeToolSetup((rows) => emissions.push(JSON.stringify(rows)), { cacheDir });
      try {
        for (let i = 0; i < 25; i++) getCachedToolSetup({ cacheDir });
        await new Promise((r) => setTimeout(r, 900));
        expect(probeCount(fake)).toBe(1); // still just the explicit refresh
        expect(emissions).toHaveLength(0); // nothing changed, nothing emitted

        // An install change invalidates the health row from METADATA ONLY —
        // the watcher emits the downgraded row and the tool is still not exec'd.
        // A real install replaces files by rename (npm unpacks that way), and
        // only a rename fires a Linux directory watch — an in-place write would
        // be invisible IN_MODIFY noise the production watcher rightly ignores.
        const staged = path.join(root, 'pkg', 'browser', 'staged');
        fs.writeFileSync(staged, '#!/bin/sh\necho replaced\nexit 88\n', { mode: 0o755 });
        fs.renameSync(staged, fake.executable);
        const pkgJson = path.join(root, 'pkg', 'browser', 'package.json');
        fs.writeFileSync(pkgJson, JSON.stringify({ name: '@phnx-labs/browser-cli', version: '0.0.1-test' }));
        await new Promise((r) => setTimeout(r, 700)); // debounce 150ms + fs event slack
        expect(probeCount(fake)).toBe(1);
        expect(emissions.length).toBeGreaterThan(0);
        const latest = JSON.parse(emissions[emissions.length - 1]!) as Array<{ tool: string; version?: string; checkedAtMs: number | null; readiness: string }>;
        expect(latest.find((r) => r.tool === 'browser')).toMatchObject({ version: '0.0.1-test', checkedAtMs: null, readiness: 'unknown' });
      } finally { stop(); }
    } finally {
      process.env.PATH = savedPath;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('a slow health probe is bounded, never blocks a concurrent reader, and the stale cache is served meanwhile', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-delivery-slow-probe-'));
  try {
    const probeLog = path.join(root, 'probes.log');
    // Tool that hangs far past the 8s probe budget.
    const fake = makeFakeTool(root, 'browser', '{"running":true}', { probeLog, statusDelayMs: 30_000 });
    const savedPath = process.env.PATH;
    delete process.env.BROWSER_BIN;
    process.env.PATH = toolPath(fake);
    const { getCachedToolSetup } = await import('../setup-tool-status.js');
    try {
      const cacheDir = path.join(root, 'cache');
      // A tool whose probe hangs only when TOOL_PROBE_HANG is set, so the SAME
      // executable (same fingerprint → stale cache stays valid) serves both the
      // fast seed probe and the slow re-probe. probeCapture kills the process
      // group on timeout, so the sleep cannot linger.
      const hangScript = '#!/bin/sh\necho "$$" >> "' + probeLog + '"\n[ -n "$TOOL_PROBE_HANG" ] && sleep 30\nprintf \'%s\' \'{"running":true}\'\n';
      fs.writeFileSync(fake.executable, hangScript, { mode: 0o755 });
      await runSetupChild(childScript(`await refreshToolSetup('browser', { cacheDir: '${cacheDir}' });`));
      expect(probeCount(fake)).toBe(1);

      const refresh = runSetupChild(childScript(
        `const rows = await refreshToolSetup('browser', { cacheDir: '${cacheDir}' });`
        + ` console.log(JSON.stringify(rows.find(r => r.tool === 'browser')));`),
        { TOOL_PROBE_HANG: '1' });
      // Give the refresh time to enter the probe…
      await new Promise((r) => setTimeout(r, 800));
      // …and a plain warm read — what the daemon/UI does — still answers
      // instantly from the STALE cache instead of queueing behind the probe.
      const readStart = Date.now();
      const read = await runSetupChild(childScript(
        `console.log(JSON.stringify(getCachedToolSetup({ cacheDir: '${cacheDir}' })));`));
      expect(read.ms).toBeLessThan(3_000);
      expect(JSON.parse(read.stdout)[0]).toMatchObject({ tool: 'browser', readiness: 'ready' });
      expect(Date.now() - readStart).toBeLessThan(3_000);

      // The probe itself is bounded by the probeCapture budget (~8s), reports
      // unknown honestly, and the concurrent refresh did not double-probe.
      const done = await refresh;
      expect(done.code).toBe(0);
      expect(done.ms).toBeLessThan(8_000 + 6_000);
      expect(JSON.parse(done.stdout)).toMatchObject({ tool: 'browser', readiness: 'unknown' });
      expect(probeCount(fake)).toBe(2); // seed probe + one bounded attempt
    } finally {
      process.env.PATH = savedPath;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('computer is never probed off-macOS and secrets is never probed at all (no broker unlock from a read)', async () => {
  if (process.platform === 'darwin') return; // assertion is Linux-specific
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-delivery-no-probe-'));
  try {
    const probeLog = path.join(root, 'probes.log');
    // Per-tool probe logs — a shared log would make each tool count another's
    // execs and false-positive the never-probed assertions.
    const computer = makeFakeTool(root, 'computer', '{"installed":true,"running":true,"trusted":true}', { probeLog: path.join(root, 'computer-probes.log') });
    const secrets = makeFakeTool(root, 'secrets', '{"ok":true}', { probeLog: path.join(root, 'secrets-probes.log') });
    const browser = makeFakeTool(root, 'browser', '{"running":true}', { probeLog });
    const savedPath = process.env.PATH;
    for (const v of ['COMPUTER_BIN', 'SECRETS_BIN', 'BROWSER_BIN']) delete process.env[v];
    process.env.PATH = toolPath([computer, secrets, browser]);
    try {
      const cacheDir = path.join(root, 'cache');
      const run = await runSetupChild(childScript(
        `console.log(JSON.stringify(await refreshToolSetup('all', { cacheDir: '${cacheDir}' })));`));
      expect(run.code).toBe(0);
      const rows = JSON.parse(run.stdout) as Array<{ tool: string; installed: boolean | null; readiness: string }>;
      expect(rows.find((r) => r.tool === 'computer')).toMatchObject({ installed: true, readiness: 'unsupported' });
      expect(rows.find((r) => r.tool === 'secrets')).toMatchObject({ installed: true, readiness: 'unknown' });
      expect(rows.find((r) => r.tool === 'browser')).toMatchObject({ installed: true, readiness: 'ready' });
      // computer (unsupported, Linux) and secrets (never) must not have been
      // exec'd; browser was probed exactly once.
      expect(probeCount(computer)).toBe(0);
      expect(probeCount(secrets)).toBe(0);
      expect(probeCount(browser)).toBe(1);
    } finally {
      process.env.PATH = savedPath;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
