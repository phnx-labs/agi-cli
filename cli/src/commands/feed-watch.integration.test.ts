import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CLI = path.resolve(process.cwd(), 'src/index.ts');
const HUB = path.resolve(process.cwd(), 'src/commands/testdata/feed-hub.ts');

type Exit = { code: number | null; signal: NodeJS.Signals | null; stderr: string };

function exited(child: ChildProcess, stderr: () => string): Promise<Exit> {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, stderr: stderr() })));
}

describe.skipIf(process.platform === 'win32')('agents feed watch --json as a real process against an owned hub', () => {
  let home: string;
  let hub: ChildProcess;
  const watchers: ChildProcess[] = [];

  const env = (): NodeJS.ProcessEnv => ({
    ...process.env,
    HOME: home,
    AGENTS_REAL_HOME: home,
    AGENTS_STATE_DIR: path.join(home, 'state'),
    AGENTS_DAEMON_DIR: path.join(home, 'daemon'),
    AGENTS_DEVICES_DIR: path.join(home, 'devices'),
    AGENTS_SYNC_MACHINE_ID: 'feedbox',
    AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
    AGENTS_NO_NUDGE: '1',
    FORCE_COLOR: '0',
  });

  function watch(stdout: 'pipe' | number): { child: ChildProcess; done: Promise<Exit> } {
    let stderr = '';
    const child = spawn('bun', [CLI, 'feed', 'watch', '--json', '--local'], { env: env(), stdio: ['ignore', stdout, 'pipe'] });
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    watchers.push(child);
    return { child, done: exited(child, () => stderr) };
  }

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-watch-'));
    fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
    hub = spawn('bun', [HUB], { env: env(), stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      hub.stdout!.once('data', () => resolve());
      hub.once('exit', (code) => reject(new Error(`feed hub exited ${code} before binding`)));
    });
  });

  afterEach(async () => {
    for (const child of [...watchers.splice(0), hub]) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const gone = new Promise((resolve) => child.once('exit', resolve));
      child.kill(child === hub ? 'SIGTERM' : 'SIGKILL');
      await gone;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('exits 0 without a stack trace when the consumer closes the pipe after one line', async () => {
    const { child, done } = watch('pipe');
    const first = await new Promise<string>((resolve) => {
      let buffered = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        buffered += chunk.toString();
        const newline = buffered.indexOf('\n');
        if (newline >= 0) resolve(buffered.slice(0, newline));
      });
    });
    child.stdout!.destroy();

    expect(JSON.parse(first)).toMatchObject({ v: 1, type: 'reset', scope: 'feedbox' });
    const exit = await done;
    expect(exit).toEqual({ code: 0, signal: null, stderr: '' });
  });

  it.skipIf(!fs.existsSync('/dev/full'))('still fails on a write error that is not a closed consumer', async () => {
    const full = fs.openSync('/dev/full', 'w');
    try {
      const exit = await watch(full).done;
      expect(exit.code).toBe(1);
      expect(exit.stderr).toContain('ENOSPC');
    } finally { fs.closeSync(full); }
  });
});
