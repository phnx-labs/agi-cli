import { expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { BrowserSessionRow, BrowserArtifact } from '../browser/sessions-list.js';
import type { ComputerRunRow } from '../computer/sessions-list.js';
import type { DeviceProfile } from '../devices/registry.js';
import { streamFromPeer } from '../session/remote/peer-stream.js';
import { watchToolActivity, type ToolDiff } from './tool-activity.js';
import { projectBrowserToolRow, projectComputerToolRow, redactToolUrl, TOOL_ACTION_LIMIT } from './tools.js';
import { FeedHubState, FeedHub } from './hub.js';
import { FeedHubServer, streamFeedFromHub } from './hub-server.js';
import { FeedWatchState, watchFleetFeed, watchLocalFeed, type FeedWatchEnvelope } from './watch.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CLI_SRC = path.resolve(HERE, '..', '..');

function resolveOnPath(name: string): string {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {  }
  }
  throw new Error(`${name} not found on PATH for test children`);
}
const BUN = resolveOnPath('bun');

const EVENTS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-vitest-tool-delivery-events-'));
const EVENTS_FILE = path.join(EVENTS_ROOT, 'events.jsonl');
process.env.AGENTS_EVENTS_PATH = EVENTS_FILE;

interface FakeTool {
  binDir: string;
  executable: string;
  probeLog: string;
}

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

function toolPath(fake: FakeTool | FakeTool[]): string {
  const dirs = (Array.isArray(fake) ? fake : [fake]).map((f) => f.binDir);
  return [...dirs, '/usr/bin', '/bin'].join(path.delimiter);
}

function probeCount(fake: FakeTool): number {
  try { return fs.readFileSync(fake.probeLog, 'utf-8').trim().split('\n').filter(Boolean).length; } catch { return 0; }
}

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
      const script = childScript(
        `const rows = await refreshToolSetup('browser', { cacheDir: '${cacheDir}' });`
        + ` console.log(JSON.stringify(rows.find(r => r.tool === 'browser')));`);
      const both = await Promise.all([runSetupChild(script), runSetupChild(script)]);
      for (const run of both) {
        expect(run.code).toBe(0);
        expect(JSON.parse(run.stdout)).toMatchObject({ tool: 'browser', installed: true, readiness: 'ready' });
      }
      expect(probeCount(fake)).toBe(1);
      expect(Math.max(...both.map((r) => r.ms))).toBeLessThan(2 * 1500 + 8000);
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

      const emissions: string[] = [];
      const stop = subscribeToolSetup((rows) => emissions.push(JSON.stringify(rows)), { cacheDir });
      try {
        for (let i = 0; i < 25; i++) getCachedToolSetup({ cacheDir });
        await new Promise((r) => setTimeout(r, 900));
        expect(probeCount(fake)).toBe(1);
        expect(emissions).toHaveLength(0);

        const staged = path.join(root, 'pkg', 'browser', 'staged');
        fs.writeFileSync(staged, '#!/bin/sh\necho replaced\nexit 88\n', { mode: 0o755 });
        fs.renameSync(staged, fake.executable);
        const pkgJson = path.join(root, 'pkg', 'browser', 'package.json');
        fs.writeFileSync(pkgJson, JSON.stringify({ name: '@phnx-labs/browser-cli', version: '0.0.1-test' }));
        await new Promise((r) => setTimeout(r, 700));
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
    const fake = makeFakeTool(root, 'browser', '{"running":true}', { probeLog, statusDelayMs: 30_000 });
    const savedPath = process.env.PATH;
    delete process.env.BROWSER_BIN;
    process.env.PATH = toolPath(fake);
    const { getCachedToolSetup } = await import('../setup-tool-status.js');
    try {
      const cacheDir = path.join(root, 'cache');
      const hangScript = '#!/bin/sh\necho "$$" >> "' + probeLog + '"\n[ -n "$TOOL_PROBE_HANG" ] && sleep 30\nprintf \'%s\' \'{"running":true}\'\n';
      fs.writeFileSync(fake.executable, hangScript, { mode: 0o755 });
      await runSetupChild(childScript(`await refreshToolSetup('browser', { cacheDir: '${cacheDir}' });`));
      expect(probeCount(fake)).toBe(1);

      const refresh = runSetupChild(childScript(
        `const rows = await refreshToolSetup('browser', { cacheDir: '${cacheDir}' });`
        + ` console.log(JSON.stringify(rows.find(r => r.tool === 'browser')));`),
        { TOOL_PROBE_HANG: '1' });
      await new Promise((r) => setTimeout(r, 800));
      const readStart = Date.now();
      const read = await runSetupChild(childScript(
        `console.log(JSON.stringify(getCachedToolSetup({ cacheDir: '${cacheDir}' })));`));
      expect(read.ms).toBeLessThan(3_000);
      expect(JSON.parse(read.stdout)[0]).toMatchObject({ tool: 'browser', readiness: 'ready' });
      expect(Date.now() - readStart).toBeLessThan(3_000);

      const done = await refresh;
      expect(done.code).toBe(0);
      expect(done.ms).toBeLessThan(8_000 + 6_000);
      expect(JSON.parse(done.stdout)).toMatchObject({ tool: 'browser', readiness: 'unknown' });
      expect(probeCount(fake)).toBe(2);
    } finally {
      process.env.PATH = savedPath;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('secrets is never exec\'d from a status read or refresh (no broker unlock); other tools probe once per explicit refresh only', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-delivery-no-probe-'));
  try {
    const computer = makeFakeTool(root, 'computer', '{"installed":true,"running":true,"trusted":true}', { probeLog: path.join(root, 'computer-probes.log') });
    const secrets = makeFakeTool(root, 'secrets', '{"ok":true}', { probeLog: path.join(root, 'secrets-probes.log') });
    const browser = makeFakeTool(root, 'browser', '{"running":true}', { probeLog: path.join(root, 'browser-probes.log') });
    const savedPath = process.env.PATH;
    for (const v of ['COMPUTER_BIN', 'SECRETS_BIN', 'BROWSER_BIN']) delete process.env[v];
    process.env.PATH = toolPath([computer, secrets, browser]);
    const { getCachedToolSetup } = await import('../setup-tool-status.js');
    try {
      const cacheDir = path.join(root, 'cache');
      const run = await runSetupChild(childScript(
        `console.log(JSON.stringify(await refreshToolSetup('all', { cacheDir: '${cacheDir}' })));`));
      expect(run.code).toBe(0);
      const rows = JSON.parse(run.stdout) as Array<{ tool: string; installed: boolean | null; readiness: string }>;
      expect(rows.find((r) => r.tool === 'computer')).toMatchObject({ installed: true, readiness: 'ready' });
      expect(rows.find((r) => r.tool === 'secrets')).toMatchObject({ installed: true, readiness: 'unknown' });
      expect(rows.find((r) => r.tool === 'browser')).toMatchObject({ installed: true, readiness: 'ready' });
      expect(probeCount(computer)).toBe(1);
      expect(probeCount(secrets)).toBe(0);
      expect(probeCount(browser)).toBe(1);
      for (let i = 0; i < 25; i++) getCachedToolSetup({ cacheDir });
      expect(probeCount(computer)).toBe(1);
      expect(probeCount(secrets)).toBe(0);
      expect(probeCount(browser)).toBe(1);
    } finally {
      process.env.PATH = savedPath;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


function runRow(invocationId: string, verbs: string[], scope = 'dev-a'): ComputerRunRow {
  const now = Date.now();
  return {
    pid: 4242,
    invocationId,
    machine: scope,
    linkStatus: 'unlinked',
    actions: verbs.map((verb, i) => ({ verb, ts: new Date(now - i * 1000).toISOString(), tsMs: now - i * 1000, pid: 4242, invocationId })),
    counts: verbs.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {}),
    startMs: now - (verbs.length - 1) * 1000,
    endMs: now,
  };
}

function browserTaskRow(task: string): BrowserSessionRow {
  const now = Date.now();
  const artifact: BrowserArtifact = { kind: 'screenshot', name: `${task}-0.png`, path: `/tmp/${task}/${task}-0.png`, bytes: 10, mtimeMs: now };
  return {
    kind: 'task', profile: 'work', task, linkStatus: 'unlinked',
    artifacts: [artifact], counts: { screenshot: 1 }, latestMtimeMs: now,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(predicate: () => boolean, budgetMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > budgetMs) throw new Error(`timed out waiting for: ${what}`);
    await sleep(25);
  }
}

it('collector warm-idle: a warm watch does ZERO reads; one change re-projects exactly once, diff-only', async () => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-vitest-tool-watch-a-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-vitest-tool-watch-b-'));
  try {
    const calls = { browser: 0, computer: 0, bindings: 0 };
    let browserRows: BrowserSessionRow[] = [];
    const sources = {
      browserRows: () => { calls.browser++; return browserRows; },
      computerRows: () => { calls.computer++; return []; },
      bindings: () => { calls.bindings++; return []; },
    };
    const diffs: ToolDiff[] = [];
    const controller = new AbortController();
    const watch = watchToolActivity({
      scope: 'dev-x', signal: controller.signal, roots: [rootA, rootB], sources, sweepMs: 100,
      onDiff: (diff) => diffs.push(diff),
    });
    try {
      expect(watch.armed()).toBe(true);
      await sleep(400);
      const warmCalls = { ...calls };
      await sleep(650);
      expect(calls).toEqual(warmCalls);
      expect(diffs).toHaveLength(0);

      browserRows = [browserTaskRow('task-1')];
      fs.writeFileSync(path.join(rootA, 'capture.png'), 'png');
      await until(() => diffs.length === 1, 3000, 'first tool diff');
      expect(calls.browser).toBe(warmCalls.browser + 1);
      expect(diffs[0]!.upserts.map((r) => r.task)).toEqual(['task-1']);
      expect(diffs[0]!.removes).toEqual([]);

      const callsAfterFirstDiff = { ...calls };
      fs.writeFileSync(path.join(rootB, 'unrelated.tmp'), 'x');
      await sleep(400);
      expect(diffs).toHaveLength(1);
      expect(calls.browser).toBe(callsAfterFirstDiff.browser + 1);

      const firstKey = diffs[0]!.upserts[0]!.rowKey;
      browserRows = [];
      fs.writeFileSync(path.join(rootA, 'capture2.png'), 'png');
      await until(() => diffs.length === 2, 3000, 'removal diff');
      expect(diffs[1]).toEqual({ upserts: [], removes: [firstKey] });
    } finally {
      controller.abort();
      watch.stop();
    }
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

it('collector degradation is stated, not silent: an unarmed watch still delivers identical diffs on the sweep', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-vitest-tool-watch-unarmed-'));
  try {
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'not a dir');
    const unarmedRoot = path.join(blocker, 'nope');
    let browserRows: BrowserSessionRow[] = [];
    const diffs: ToolDiff[] = [];
    const controller = new AbortController();
    const watch = watchToolActivity({
      scope: 'dev-x', signal: controller.signal, roots: [unarmedRoot], sweepMs: 100,
      sources: { browserRows: () => browserRows, computerRows: () => [], bindings: () => [] },
      onDiff: (diff) => diffs.push(diff),
    });
    try {
      expect(watch.armed()).toBe(false);
      browserRows = [browserTaskRow('sweep-task')];
      await until(() => diffs.length === 1, 3000, 'sweep-delivered diff');
      expect(diffs[0]!.upserts.map((r) => r.task)).toEqual(['sweep-task']);
    } finally {
      controller.abort();
      watch.stop();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('hub: two socket clients share ONE fleet fan-out — one ssh child per peer, late subscriber costs nothing, last detach stops it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-vitest-tool-hub-'));
  const shimDir = path.join(root, 'shim');
  const binDir = path.join(root, 'bin');
  const socketPath = path.join(root, 'feed-stream.sock');
  const devicesDir = path.join(root, 'devices');
  const savedPath = process.env.PATH;
  const savedDevicesDir = process.env.AGENTS_DEVICES_DIR;
  try {
    fs.mkdirSync(shimDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(devicesDir, { recursive: true });
    const sshLog = path.join(shimDir, 'ssh-spawns.log');
    const agentsLog = path.join(shimDir, 'agents-spawns.log');
    const peerRow = projectComputerToolRow('peer-a', runRow('inv-peer-1', ['click', 'type'], 'peer-a'));
    fs.writeFileSync(path.join(shimDir, 'reset.jsonl'), `${JSON.stringify({
      v: 1, type: 'reset', streamId: 'peer-a-stream', sequence: 1, scope: 'peer-a',
      capturedAt: Date.now(), agents: [], attention: [], tools: [peerRow],
    })}\n`);
    fs.writeFileSync(path.join(shimDir, 'peer-up'), '');
    const sshShim = path.join(binDir, 'ssh');
    fs.writeFileSync(sshShim, `#!/bin/sh
echo "spawn pid=$$ $@" >> "${sshLog}"
if [ -f "${shimDir}/peer-up" ]; then
  cat "${shimDir}/reset.jsonl"
  exec sleep 600
else
  echo "mock: connection refused" >&2
  exit 1
fi
`, { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'agents'), `#!/bin/sh\necho "local agents exec: $@" >> "${agentsLog}"\nexit 99\n`, { mode: 0o755 });
    process.env.PATH = [binDir, ...(savedPath ?? '').split(path.delimiter).filter(Boolean)].join(path.delimiter);
    process.env.AGENTS_DEVICES_DIR = devicesDir;
    fs.writeFileSync(path.join(devicesDir, 'registry.json'), JSON.stringify({
      'peer-a': {
        name: 'peer-a', platform: 'linux', shell: 'posix',
        address: { via: 'manual', ip: '127.0.0.1' }, auth: { method: 'key' },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      } satisfies DeviceProfile,
    }));

    const hub = new FeedHub({ watch: watchFleetFeed, reconnectMs: 300 });
    const server = new FeedHubServer(hub, socketPath);
    await server.start();
    const clients: FeedWatchEnvelope[][] = [[], [], []];
    const signals = [new AbortController(), new AbortController(), new AbortController()];
    const connect = (i: number): Promise<void> =>
      streamFeedFromHub({ signal: signals[i]!.signal, endpoint: socketPath, emit: (event) => clients[i]!.push(event) });
    const running = [connect(0), connect(1)];
    try {
      await until(() => clients[0]!.some((e) => e.type === 'reset' && e.scope === 'peer-a')
        && clients[1]!.some((e) => e.type === 'reset' && e.scope === 'peer-a'), 8000, 'both clients receive the peer reset');
      for (const i of [0, 1]) {
        const reset = clients[i]!.find((e) => e.type === 'reset' && e.scope === 'peer-a');
        if (reset?.type !== 'reset') throw new Error('missing peer reset');
        expect(reset.tools.map((t) => t.rowKey)).toEqual([peerRow.rowKey]);
      }
      const sshSpawns = () => fs.readFileSync(sshLog, 'utf-8').trim().split('\n').filter(Boolean);
      expect(sshSpawns()).toHaveLength(1);
      expect(fs.existsSync(agentsLog)).toBe(false);

      running.push(connect(2));
      await until(() => clients[2]!.some((e) => e.type === 'reset' && e.scope === 'peer-a'), 5000, 'late subscriber synthesized reset');
      const late = clients[2]!.find((e) => e.type === 'reset' && e.scope === 'peer-a');
      if (late?.type !== 'reset') throw new Error('missing late reset');
      expect(late.tools.map((t) => t.rowKey)).toEqual([peerRow.rowKey]);
      expect(late.sequence).toBeGreaterThanOrEqual(1);
      expect(sshSpawns()).toHaveLength(1);

      const heldPid = Number(/pid=(\d+)/.exec(sshSpawns()[0]!)?.[1]);
      process.kill(heldPid, 'SIGTERM');
      fs.rmSync(path.join(shimDir, 'peer-up'));
      await until(() => sshSpawns().length === 4, 8000, 'backoff ladder: 3 failed re-dials after the hold died');
      await until(() => clients[0]!.some((e) => e.type === 'scope' && e.scope === 'peer-a' && String(e.reason).includes('parked')), 5000, 'parked reason reaches client 1');
      await sleep(900);
      expect(sshSpawns()).toHaveLength(4);

      for (const i of [0, 2]) {
        const resets = clients[i]!.filter((e) => e.type === 'reset' && e.scope === 'peer-a');
        expect(resets.length).toBeGreaterThan(0);
        const last = resets[resets.length - 1]!;
        if (last.type !== 'reset') throw new Error('unreachable');
        expect(last.tools.map((t) => t.rowKey)).toEqual([peerRow.rowKey]);
      }

      fs.writeFileSync(path.join(shimDir, 'peer-up'), '');
      fs.writeFileSync(path.join(devicesDir, 'registry.json'), JSON.stringify({
        'peer-a': {
          name: 'peer-a', platform: 'linux', shell: 'posix',
          address: { via: 'manual', ip: '127.0.0.1' }, auth: { method: 'key' },
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        },
      }));
      await until(() => sshSpawns().length === 5, 8000, 'registry-touch re-dial');
      await until(() => clients[0]!.filter((e) => e.type === 'reset' && e.scope === 'peer-a').length >= 2, 5000, 'recovered peer re-announces');

      signals[0]!.abort();
      await sleep(300);
      expect(hub.readerCount).toBe(2);
      expect(sshSpawns()).toHaveLength(5);
      signals[1]!.abort();
      signals[2]!.abort();
      await until(() => hub.readerCount === 0 && !hub.active, 5000, 'fan-out stops on last detach');
      await sleep(600);
      expect(sshSpawns()).toHaveLength(5);
    } finally {
      for (const s of signals) s.abort();
      await server.stop().catch(() => {});
      await Promise.allSettled(running);
    }
  } finally {
    process.env.PATH = savedPath;
    if (savedDevicesDir === undefined) delete process.env.AGENTS_DEVICES_DIR; else process.env.AGENTS_DEVICES_DIR = savedDevicesDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('peer retry budget: past the park ladder a peer is RETIRED to a slow recheck — total ssh work is bounded', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-vitest-peer-retire-'));
  try {
    const sshLog = path.join(root, 'ssh.log');
    const sshBin = path.join(root, 'ssh-fail.sh');
    fs.writeFileSync(sshBin, `#!/bin/sh\necho "spawn $@" >> "${sshLog}"\necho "mock: no route to host" >&2\nexit 1\n`, { mode: 0o755 });
    const device: DeviceProfile = {
      name: 'peer-dead', platform: 'linux', shell: 'posix',
      address: { via: 'manual', ip: '10.255.255.1' }, auth: { method: 'key' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const reasons: string[] = [];
    const controller = new AbortController();
    const run = streamFromPeer({
      device, command: 'agents feed watch --json --local', signal: controller.signal, sshBin,
      backoffBaseMs: 50, backoffCapMs: 400, parkAfterFailures: 3, retireAfterFailures: 4,
      retiredRecheckMs: 60_000, registryPollMs: 50, registryPath: path.join(root, 'registry.json'),
      onLine: () => true,
      onUnavailable: (reason) => reasons.push(reason),
    });
    try {
      await until(() => reasons.some((r) => r.includes('retired')), 6000, 'retired reason');
      const spawns = () => fs.readFileSync(sshLog, 'utf-8').trim().split('\n').filter(Boolean);
      expect(spawns()).toHaveLength(4);
      expect(reasons[reasons.length - 1]).toContain('retired after 4 failed connections');
      await sleep(800);
      expect(spawns()).toHaveLength(4);
    } finally {
      controller.abort();
      await run;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('hub state: resets are per-scope, removals isolate, unavailable retains rows, late snapshots are consistent and contiguous', () => {
  const state = new FeedWatchState();
  const held = new FeedHubState();
  const toolA1 = projectComputerToolRow('dev-a', runRow('inv-a1', ['click'], 'dev-a'));
  const toolA2 = projectComputerToolRow('dev-a', runRow('inv-a2', ['type'], 'dev-a'));
  const toolB = projectBrowserToolRow('dev-b', browserTaskRow('task-b'), { name: 'task-b', url: 'https://example.test', device: 'dev-b' });

  held.apply(state.emit({ type: 'reset', scope: 'dev-a', capturedAt: 1, agents: [], attention: [], tools: [toolA1, toolA2] }));
  held.apply(state.emit({ type: 'reset', scope: 'dev-b', capturedAt: 2, agents: [], attention: [], tools: [toolB] }));
  held.apply(state.emit({ type: 'tool.remove', scope: 'dev-b', rowKey: toolB.rowKey }));
  held.apply(state.emit({ type: 'scope', capturedAt: 3, scope: 'dev-a', status: 'unavailable', reason: 'parked' }));

  const late = new FeedWatchState();
  const snapshot = held.snapshot(late);
  const resets = snapshot.filter((e) => e.type === 'reset');
  expect(resets.map((e) => e.scope).sort()).toEqual(['dev-a', 'dev-b']);
  const resetA = resets.find((e) => e.scope === 'dev-a');
  const resetB = resets.find((e) => e.scope === 'dev-b');
  if (resetA?.type !== 'reset' || resetB?.type !== 'reset') throw new Error('missing scope resets');
  expect(resetA.tools.map((t) => t.rowKey).sort()).toEqual([toolA1.rowKey, toolA2.rowKey].sort());
  expect(resetB.tools).toEqual([]);
  const marker = snapshot.find((e) => e.type === 'scope' && e.scope === 'dev-a');
  expect(marker).toMatchObject({ status: 'unavailable', reason: 'parked' });
  expect(snapshot.map((e, i) => e.sequence)).toEqual(snapshot.map((_, i) => i + 1));
  const toolA3 = projectComputerToolRow('dev-a', runRow('inv-a3', ['screenshot'], 'dev-a'));
  held.apply(state.emit({ type: 'tool.upsert', scope: 'dev-a', rowKey: toolA3.rowKey, tool: toolA3 }));
  const late2 = new FeedWatchState();
  const snapshot2 = held.snapshot(late2);
  const resetA2 = snapshot2.find((e) => e.scope === 'dev-a' && e.type === 'reset');
  if (resetA2?.type !== 'reset') throw new Error('missing dev-a reset');
  expect(resetA2.tools.map((t) => t.rowKey).sort())
    .toEqual([toolA1.rowKey, toolA2.rowKey, toolA3.rowKey].sort());
});

it('tool rows: a computer run is history, never a live session with a stop control; close is offered only on a live browser task', () => {
  const manyVerbs = Array.from({ length: TOOL_ACTION_LIMIT + 10 }, (_, i) => `verb${i % 3}`);
  const computer = projectComputerToolRow('dev-a', runRow('inv-history', manyVerbs, 'dev-a'));
  expect(computer.live).toBe(false);
  expect('closeCommand' in computer).toBe(false);
  expect(computer.actions).toHaveLength(TOOL_ACTION_LIMIT);
  expect(computer.actionCounts).toEqual({ verb0: 20, verb1: 20, verb2: 20 });

  const bound = projectBrowserToolRow('dev-a', browserTaskRow('task-live'), { name: 'task-live', url: 'https://example.test', device: 'dev-a' });
  expect(bound.live).toBe(true);
  expect(bound.closeCommand).toEqual({ command: 'browser', args: ['done', '--task', 'task-live'], runOn: 'dev-a' });
  const unbound = projectBrowserToolRow('dev-a', browserTaskRow('task-gone'), undefined);
  expect(unbound.live).toBe(false);
  expect('closeCommand' in unbound).toBe(false);
});

it('tool rows carry paths and redacted URLs only — no credential value reaches the stream', () => {
  const secretUrl = 'https://user:pass@internal.example.test/?access_token=SECRETTOKEN&signature=MYSIG&ok=1#token=FRAGSECRET';
  const row = projectBrowserToolRow('dev-a', browserTaskRow('task-s'), { name: 'task-s', url: secretUrl, device: 'dev-a' });
  const json = JSON.stringify(row);
  for (const forbidden of ['user:pass', 'SECRETTOKEN', 'MYSIG', 'FRAGSECRET']) {
    expect(json).not.toContain(forbidden);
  }
  expect(row.url).toContain('ok=1');
  expect(row.url).not.toContain('#');
  expect(redactToolUrl('not a url at all')).toBeUndefined();
  expect(redactToolUrl(undefined)).toBeUndefined();
});

it('cross-track: a slow setup health probe never blocks the shared hub — tool rows still deliver while the probe hangs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-vitest-cross-slow-'));
  const savedPath = process.env.PATH;
  try {
    const probeLog = path.join(root, 'browser-probes.log');
    const fake = makeFakeTool(root, 'browser', '{"running":true}', { probeLog, statusDelayMs: 30_000 });
    delete process.env.BROWSER_BIN;
    process.env.PATH = toolPath(fake);

    const socketPath = path.join(root, 'feed.sock');
    const devicesDir = path.join(root, 'devices');
    fs.mkdirSync(devicesDir, { recursive: true });
    const savedDevicesDir = process.env.AGENTS_DEVICES_DIR;
    process.env.AGENTS_DEVICES_DIR = devicesDir;
    const hub = new FeedHub({ watch: (options) => watchLocalFeed({ ...options, scope: 'dev-x' }), reconnectMs: 300 });
    const server = new FeedHubServer(hub, socketPath);
    await server.start();
    const controller = new AbortController();
    const events: FeedWatchEnvelope[] = [];
    const client = streamFeedFromHub({ signal: controller.signal, endpoint: socketPath, emit: (e) => events.push(e) });
    try {
      await until(() => events.some((e) => e.type === 'reset'), 8000, 'local reset reaches the hub client');

      const { refreshToolSetup } = await import('../setup-tool-status.js');
      const cacheDir = path.join(root, 'cache');
      let probeSettled = false;
      const refresh = refreshToolSetup('browser', { cacheDir }).then((rows) => { probeSettled = true; return rows; });
      await sleep(800);

      const line = JSON.stringify({
        v: 1, event: 'computer.action', command: 'click', ts: new Date().toISOString(),
        pid: 7777, invocationId: 'inv-cross-track', host: 'dev-x', runtime: 'headless',
      });
      fs.appendFileSync(EVENTS_FILE, `${line}\n`);
      await until(() => events.some((e) => e.type === 'tool.upsert' && e.tool.kind === 'computer'), 7500, 'tool row delivered during the hanging probe');
      expect(probeSettled).toBe(false);

      const rows = await refresh;
      expect(rows.find((r) => r.tool === 'browser')).toMatchObject({ readiness: 'unknown' });
      expect(probeCount(fake)).toBe(1);
    } finally {
      controller.abort();
      await server.stop().catch(() => {});
      await client.catch(() => {});
      if (savedDevicesDir === undefined) delete process.env.AGENTS_DEVICES_DIR; else process.env.AGENTS_DEVICES_DIR = savedDevicesDir;
    }
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
