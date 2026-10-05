import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildRunLaunchPayload, execAgent } from './exec.js';
import { emit, _resetForTest } from './feed/events.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  _resetForTest();
});

describe('buildRunLaunchPayload (pre-launch run.launch payload — signedIn -> launchedLoggedOut)', () => {
  it('a signed-in launch is NOT flagged logged-out and carries the account email', () => {
    const p = buildRunLaunchPayload({
      agent: 'claude',
      version: '2.1.207',
      strategy: 'balanced',
      signedIn: true,
      email: 'muqsit@example.com',
      resolvedVia: 'rotated',
    });
    expect(p.module).toBe('run');
    expect(p.agent).toBe('claude');
    expect(p.version).toBe('2.1.207');
    expect(p.strategy).toBe('balanced');
    expect(p.signedIn).toBe(true);
    expect(p.launchedLoggedOut).toBe(false);
    expect(p.email).toBe('muqsit@example.com');
    expect(p.resolvedVia).toBe('rotated');
  });

  it('a LOGGED-OUT launch sets launchedLoggedOut true with a null email (the yosemite-m3 2.1.219 case)', () => {
    const p = buildRunLaunchPayload({
      agent: 'claude',
      version: '2.1.219',
      strategy: 'balanced',
      signedIn: false,
      email: null,
    });
    expect(p.signedIn).toBe(false);
    expect(p.launchedLoggedOut).toBe(true);
    expect(p.email).toBeNull();
  });

  it('an UNKNOWN verdict (signedIn null) is never treated as logged out', () => {
    const p = buildRunLaunchPayload({
      agent: 'amp',
      version: undefined,
      signedIn: null,
      email: null,
    });
    expect(p.signedIn).toBeNull();
    expect(p.launchedLoggedOut).toBe(false);
    expect('version' in p ? p.version : undefined).toBeUndefined();
  });

  it('omits optional fields (harnessName, resolvedVia) when absent', () => {
    const p = buildRunLaunchPayload({ agent: 'claude', version: '1', signedIn: true, email: null });
    expect('harnessName' in p).toBe(false);
    expect('resolvedVia' in p).toBe(false);
    expect(p.strategy).toBeNull();
  });
});

describe('run.launch fires on the real spawn path, before the harness runs (persisted to the event sink)', () => {
  function fakeHarness(): { binDir: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-launch-'));
    tmpDirs.push(root);
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir);
    const script = `#!/usr/bin/env node\nprocess.exit(0);\n`;
    const bin = path.join(binDir, 'amp');
    fs.writeFileSync(bin, script);
    fs.chmodSync(bin, 0o755);
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(binDir, 'amp.js'), script);
      fs.writeFileSync(path.join(binDir, 'amp.cmd'), `@node "%~dp0amp.js" %*\r\n`);
    }
    return { binDir };
  }

  it('emits a run.launch record (module run) right before spawning the harness', async () => {
    const { binDir } = fakeHarness();
    const eventsPath = path.join(binDir, '..', 'events.jsonl');
    _resetForTest(eventsPath);

    const code = await execAgent({
      agent: 'amp',
      prompt: 'do the task',
      mode: 'edit',
      effort: 'auto',
      headless: true,
      cwd: binDir,
      strategy: 'balanced',
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AGENTS_NO_TMUX: '1',
      },
    });
    expect(code).toBe(0);

    const lines = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const launch = lines.find((r) => r.event === 'run.launch');
    expect(launch).toBeDefined();
    expect(launch.module).toBe('run');
    expect(launch.agent).toBe('amp');
    expect(launch.strategy).toBe('balanced');
    expect(launch.launchedLoggedOut).toBe(false);
    expect(typeof launch.hostname).toBe('string');
  });

  it('a threaded LOGGED-OUT verdict (the interactive picker case) surfaces launchedLoggedOut:true', async () => {
    const { binDir } = fakeHarness();
    const eventsPath = path.join(binDir, '..', 'events.jsonl');
    _resetForTest(eventsPath);

    const code = await execAgent({
      agent: 'amp',
      prompt: 'do the task',
      mode: 'edit',
      effort: 'auto',
      headless: true,
      cwd: binDir,
      strategy: 'balanced',
      launchSignedIn: false,
      launchEmail: null,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AGENTS_NO_TMUX: '1',
      },
    });
    expect(code).toBe(0);

    const lines = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const launch = lines.find((r) => r.event === 'run.launch');
    expect(launch).toBeDefined();
    expect(launch.signedIn).toBe(false);
    expect(launch.launchedLoggedOut).toBe(true);
  });

  it('a threaded SIGNED-IN verdict is honored verbatim (launchedLoggedOut:false)', async () => {
    const { binDir } = fakeHarness();
    const eventsPath = path.join(binDir, '..', 'events.jsonl');
    _resetForTest(eventsPath);

    const code = await execAgent({
      agent: 'amp',
      prompt: 'do the task',
      mode: 'edit',
      effort: 'auto',
      headless: true,
      cwd: binDir,
      strategy: 'balanced',
      launchSignedIn: true,
      launchEmail: 'muqsit@example.com',
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AGENTS_NO_TMUX: '1',
      },
    });
    expect(code).toBe(0);

    const lines = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const launch = lines.find((r) => r.event === 'run.launch');
    expect(launch.signedIn).toBe(true);
    expect(launch.launchedLoggedOut).toBe(false);
    expect(launch.email).toBe('muqsit@example.com');
  });
});
