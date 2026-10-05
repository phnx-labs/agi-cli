import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { dispatchAction } from './dispatch.js';
import type { MonitorConfig, MonitorEvent } from './config.js';
import type { Meta } from '../types.js';

/** The monitor `notify` action used to exec openclaw with no target, inheriting a hardcoded owner
 * number and no missing-binary guard. It now routes through the one owner-send seam (sendToOwner).
 * POSIX-only (RUSH-2215): the provider uses `which` and the fake is a `#!/bin/sh` recorder. */
describe.skipIf(process.platform === 'win32')('dispatchAction notify (resolves the owner, fails loud on a missing binary)', () => {
  let tmp: string;
  let record: string;
  const savedPath = process.env.PATH;
  const savedRecord = process.env.OPENCLAW_RECORD;

  function metaWithOwner(to: string): Meta {
    return {
      notify: { owner: { channel: 'telegram', to }, transports: { telegram: 'openclaw-telegram' } },
    } as Meta;
  }

  function notifyMonitor(): MonitorConfig {
    return {
      name: 'ci-red',
      enabled: true,
      source: { type: 'command', command: 'echo x' },
      condition: { mode: 'on-change' },
      action: { type: 'notify' },
    } as MonitorConfig;
  }

  const event: MonitorEvent = {
    monitorName: 'ci-red',
    firedAt: '2026-07-21T12:00:00.000Z',
    summary: 'build failed',
    payload: {},
  };

  function installFakeOpenclaw(): void {
    const bin = path.join(tmp, 'openclaw');
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$OPENCLAW_RECORD"\nexit 0\n`);
    fs.chmodSync(bin, 0o755);
    process.env.PATH = `${tmp}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-notify-'));
    record = path.join(tmp, 'argv.log');
    process.env.OPENCLAW_RECORD = record;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedRecord === undefined) delete process.env.OPENCLAW_RECORD;
    else process.env.OPENCLAW_RECORD = savedRecord;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('sends the fired event to notify.owner.to, not a hardcoded number', async () => {
    installFakeOpenclaw();
    const result = await dispatchAction(notifyMonitor(), event, metaWithOwner('monitor-owner'));
    expect(result).toEqual({ kind: 'notify', ok: true });
    const argv = fs.readFileSync(record, 'utf-8');
    expect(argv).toContain('--target monitor-owner');
    expect(argv).toContain('--message build failed');
  });

  it('follows a change to notify.owner.to', async () => {
    installFakeOpenclaw();
    await dispatchAction(notifyMonitor(), event, metaWithOwner('owner-a'));
    await dispatchAction(notifyMonitor(), event, metaWithOwner('owner-b'));
    const argv = fs.readFileSync(record, 'utf-8');
    expect(argv).toContain('--target owner-a');
    expect(argv).toContain('--target owner-b');
  });

  it('fails loud with a clean error (not ENOENT) when openclaw is missing', async () => {
    process.env.PATH = `${tmp}${path.delimiter}/usr/bin${path.delimiter}/bin`; // no openclaw on PATH
    const result = await dispatchAction(notifyMonitor(), event, metaWithOwner('monitor-owner'));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('openclaw CLI not found on PATH');
    expect(result.error).not.toMatch(/ENOENT/);
  });

  it('an explicit notifyChannel overrides the owner channel but keeps the owner target', async () => {
    installFakeOpenclaw();
    const monitor = { ...notifyMonitor(), action: { type: 'notify', notifyChannel: 'telegram' } } as MonitorConfig;
    const result = await dispatchAction(monitor, event, metaWithOwner('monitor-owner'));
    expect(result.ok).toBe(true);
    const argv = fs.readFileSync(record, 'utf-8');
    expect(argv).toContain('--target monitor-owner');
  });

  it('an unresolvable notifyChannel returns ok:false — it does not exit the process', async () => {
    // `agents monitors add --notify <channel>` validates nothing (commands/monitors.ts), so a typo
    // reaches here. The die()-capable resolveTransport used to process.exit() and take the monitor
    // daemon down (engine.ts's try/catch can't catch an exit).
    const monitor = {
      ...notifyMonitor(),
      action: { type: 'notify', notifyChannel: 'not-a-real-channel' },
    } as MonitorConfig;
    const result = await dispatchAction(monitor, event, metaWithOwner('monitor-owner'));
    expect(result.kind).toBe('notify');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No channel provider 'not-a-real-channel'/);
  });
});

/** RUSH-2500: dispatchAction run/routine must return ok:false when executeJobDetached returns a
 * skipped/blocked RunMeta (it was always ok:true, so `monitors logs` and `monitors runs`
 * disagreed). Uses a child process so HOME is set before module state resolves. */
describe('dispatchAction run (skipped run returns ok:false)', () => {
  const tsxBin = path.resolve('node_modules/.bin/tsx');
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-dispatch-skip-'));
  });

  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('returns ok:false and the skip reason when executeJobDetached returns status:skipped', () => {
    // Plant a fake "running" run so allocateRoutineAttempt hits the active_run
    // skip gate and returns proceed:false without launching an agent process.
    const monitorName = 'test-skip-monitor';
    const activeRunId = 'fake-run-001';
    const metaDir = path.join(home, '.agents', '.history', 'runs', monitorName, activeRunId);
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(path.join(metaDir, 'meta.json'), JSON.stringify({
      jobName: monitorName,
      runId: activeRunId,
      status: 'running',
      startedAt: new Date().toISOString(),
      // No pid — triggers the startedAt-within-timeout branch in activeRoutineRun.
    }));

    const moduleUrl = pathToFileURL(path.resolve('src/lib/monitors/dispatch.ts')).href;
    const fixture = path.join(home, 'run-skip.mts');
    fs.writeFileSync(fixture,
      `import { dispatchAction } from ${JSON.stringify(moduleUrl)};\n` +
      `const monitor = {\n` +
      `  name: ${JSON.stringify(monitorName)},\n` +
      `  enabled: true,\n` +
      `  source: { type: 'command', command: 'echo x' },\n` +
      `  condition: { mode: 'on-change' },\n` +
      `  action: { type: 'run', agent: 'claude', prompt: 'test {event}' },\n` +
      `} as any;\n` +
      `const event = {\n` +
      `  monitorName: ${JSON.stringify(monitorName)},\n` +
      `  firedAt: '2026-08-15T12:00:00.000Z',\n` +
      `  summary: 'test event',\n` +
      `  payload: {},\n` +
      `} as any;\n` +
      `const result = await dispatchAction(monitor, event);\n` +
      `console.log(JSON.stringify(result));\n`,
    );

    const child = spawnSync(tsxBin, [fixture], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: home },
    });

    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    // Before the fix: ok: true (executeJobDetached's skipped return was ignored).
    // After the fix: ok: false with the runner's errorMessage.
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('run');
    expect(result.error).toMatch(/skipped/i);
  });
});

/** RUSH-2681: a monitor's `run` was refused by the ROUTINES activation manifest (its synthesized
 * job name is never in it), recording `skipReason: "wrong_owner"` on every fire. Real path in a
 * child process; asserts neither `wrong_owner` nor `execution_context_missing`. */
describe('dispatchAction run (the routines activation manifest does not refuse a monitor)', () => {
  const tsxBin = path.resolve('node_modules/.bin/tsx');
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-activation-'));
  });

  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  /** Run a fixture with HOME planted; return its parsed stdout JSON. */
  function runFixture(body: string): { result: { ok: boolean; kind: string; error?: string }; skipReason?: string } {
    const fixture = path.join(home, 'fixture.mts');
    fs.writeFileSync(fixture, body);
    const child = spawnSync(tsxBin, [fixture], { encoding: 'utf-8', env: { ...process.env, HOME: home } });
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout.trim());
  }

  /** The newest run record written for `name`, if any. */
  function latestRunMeta(name: string): { skipReason?: string; readiness?: { code?: string } } {
    const runsDir = path.join(home, '.agents', '.history', 'runs', name);
    if (!fs.existsSync(runsDir)) return {};
    const runs = fs.readdirSync(runsDir).sort();
    if (runs.length === 0) return {};
    const metaPath = path.join(runsDir, runs[runs.length - 1]!, 'meta.json');
    if (!fs.existsSync(metaPath)) return {};
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  }

  it('dispatches when the manifest EXISTS and the monitor name is absent from it', () => {
    const monitorName = 'rush-2681-monitor';
    const dispatchUrl = pathToFileURL(path.resolve('src/lib/monitors/dispatch.ts')).href;
    const activationUrl = pathToFileURL(path.resolve('src/lib/routine-activation.ts')).href;

    const out = runFixture(
      `import { dispatchAction } from ${JSON.stringify(dispatchUrl)};\n` +
      `import { replaceEnabledRoutines, enabledRoutineNames } from ${JSON.stringify(activationUrl)};\n` +
      // Materialize a real manifest that does NOT contain the monitor's name.
      `replaceEnabledRoutines(['some-other-routine']);\n` +
      `if (enabledRoutineNames() === null) throw new Error('manifest was not materialized');\n` +
      `const monitor = {\n` +
      `  name: ${JSON.stringify(monitorName)},\n` +
      `  enabled: true,\n` +
      `  source: { type: 'command', command: 'echo x' },\n` +
      `  condition: { mode: 'on-change' },\n` +
      `  action: { type: 'run', agent: 'claude', prompt: 'test {event}' },\n` +
      `} as any;\n` +
      `const event = { monitorName: ${JSON.stringify(monitorName)}, firedAt: '2026-08-15T12:00:00.000Z', summary: 'e', payload: {} } as any;\n` +
      `const result = await dispatchAction(monitor, event);\n` +
      `console.log(JSON.stringify({ result }));\n`,
    );

    // Before the fix: "Job 'rush-2681-monitor' can only run on: " (empty allowlist).
    expect(out.result.error ?? '').not.toMatch(/can only run on/);
    const meta = latestRunMeta(monitorName);
    expect(meta.skipReason).not.toBe('wrong_owner');
    // The gate behind it: a monitor owns no project and had no field to supply a cwd, so the run
    // was blocked with `execution_context_missing`. dispatchAction now defaults the job's cwd to
    // the target home.
    expect(meta.readiness?.code).not.toBe('execution_context_missing');
  });

  it('still refuses a routine action whose routine is defined but NOT activated here', () => {
    const routineName = 'rush-2681-routine';
    const dispatchUrl = pathToFileURL(path.resolve('src/lib/monitors/dispatch.ts')).href;
    const activationUrl = pathToFileURL(path.resolve('src/lib/routine-activation.ts')).href;
    const routinesUrl = pathToFileURL(path.resolve('src/lib/scheduling/routines.ts')).href;

    const out = runFixture(
      `import { dispatchAction } from ${JSON.stringify(dispatchUrl)};\n` +
      `import { replaceEnabledRoutines } from ${JSON.stringify(activationUrl)};\n` +
      `import { writeJob } from ${JSON.stringify(routinesUrl)};\n` +
      `writeJob({ name: ${JSON.stringify(routineName)}, schedule: '0 9 * * *', agent: 'claude',\n` +
      `  mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'hi {event}' } as any);\n` +
      // Activated: something else. This routine is defined but off on this device.
      `replaceEnabledRoutines(['some-other-routine']);\n` +
      `const monitor = {\n` +
      `  name: 'rush-2681-routine-monitor',\n` +
      `  enabled: true,\n` +
      `  source: { type: 'command', command: 'echo x' },\n` +
      `  condition: { mode: 'on-change' },\n` +
      `  action: { type: 'routine', routine: ${JSON.stringify(routineName)} },\n` +
      `} as any;\n` +
      `const event = { monitorName: 'rush-2681-routine-monitor', firedAt: '2026-08-15T12:00:00.000Z', summary: 'e', payload: {} } as any;\n` +
      `const result = await dispatchAction(monitor, event);\n` +
      `console.log(JSON.stringify({ result }));\n`,
    );

    // The exemption is deliberately narrow: a real routine keeps its activation gate.
    expect(out.result.ok).toBe(false);
    expect(out.result.error).toMatch(/can only run on/);
    expect(latestRunMeta(routineName).skipReason).toBe('wrong_owner');
  });
});

/** The daemon-survival guarantee, proven in a real child process: an in-process assertion can't
 * tell "returned a result" from "would have exited", so this runs dispatchAction for real and
 * requires the process to reach the next line and exit 0. */
describe('dispatchAction notify (process survives an unresolvable channel)', () => {
  const tsxBin = path.resolve('node_modules/.bin/tsx');
  let fixtureDir: string;

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-die-'));
  });

  afterEach(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

  it('returns to its caller and exits 0 instead of process.exit()-ing', () => {
    const moduleUrl = pathToFileURL(path.resolve('src/lib/monitors/dispatch.ts')).href;
    // A file, not `tsx -e`: the inline form compiles to cjs, where the top-level
    // await this needs is unavailable.
    const fixture = path.join(fixtureDir, 'dispatch-bad-channel.mts');
    fs.writeFileSync(
      fixture,
      `import { dispatchAction } from ${JSON.stringify(moduleUrl)};\n` +
        `const monitor = {\n` +
        `  name: 'ci-red',\n` +
        `  enabled: true,\n` +
        `  source: { type: 'command', command: 'echo x' },\n` +
        `  condition: { mode: 'on-change' },\n` +
        `  action: { type: 'notify', notifyChannel: 'not-a-real-channel' },\n` +
        `} as any;\n` +
        `const event = {\n` +
        `  monitorName: 'ci-red',\n` +
        `  firedAt: '2026-07-21T12:00:00.000Z',\n` +
        `  summary: 'build failed',\n` +
        `  payload: {},\n` +
        `} as any;\n` +
        `const meta = { notify: { owner: { channel: 'telegram', to: 'monitor-owner' } } } as any;\n` +
        `console.log('BEFORE');\n` +
        `const result = await dispatchAction(monitor, event, meta);\n` +
        `console.log('AFTER ' + JSON.stringify(result));\n`,
    );

    const child = spawnSync(tsxBin, [fixture], { encoding: 'utf-8' });

    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('BEFORE');
    expect(child.stdout).toContain('AFTER '); // the pre-fix build exited before this
    const result = JSON.parse(child.stdout.slice(child.stdout.indexOf('AFTER ') + 6).trim());
    expect(result.kind).toBe('notify');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No channel provider 'not-a-real-channel'/);
  });
});
