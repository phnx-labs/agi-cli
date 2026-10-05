import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { probeCapture } from './probe.js';

const posixOnly = describe.skipIf(process.platform === 'win32');

function writeForker(dir: string, opts: { parentExits: boolean }): string {
  const script = path.join(dir, 'forker.sh');
  fs.writeFileSync(
    script,
    [
      '#!/bin/sh',
      `( echo $$ > "${dir}/grandchild.pid.tmp"; mv "${dir}/grandchild.pid.tmp" "${dir}/grandchild.pid"`,
      `  while :; do echo tick >> "${dir}/writes.log"; sleep 0.05; done ) &`,
      'echo 1.2.3',
      opts.parentExits ? 'exit 0' : 'sleep 60',
    ].join('\n'),
    'utf-8',
  );
  fs.chmodSync(script, 0o755);
  return script;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readGrandchildPid(dir: string): Promise<number> {
  const p = path.join(dir, 'grandchild.pid');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) {
      const pid = parseInt(fs.readFileSync(p, 'utf-8').trim(), 10);
      if (!isNaN(pid)) return pid;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('grandchild never recorded its pid');
}

async function expectDeadSoon(pid: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
  }
  expect.fail(`grandchild ${pid} survived the probe — the process group was not reaped`);
}

posixOnly('probeCapture (RUSH-3028: nothing a probe spawns outlives it)', () => {
  it('reaps the grandchild when the probed parent exits cleanly (copilot fork-and-return shape)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-reap-'));
    try {
      const script = writeForker(dir, { parentExits: true });
      const { stdout } = await probeCapture(script, [], 3000);
      expect(stdout).toContain('1.2.3');
      const log = path.join(dir, 'writes.log');
      const sizeOf = (): number => (fs.existsSync(log) ? fs.statSync(log).size : 0);
      await new Promise((r) => setTimeout(r, 150));
      const before = sizeOf();
      await new Promise((r) => setTimeout(r, 400));
      expect(sizeOf()).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reaps the probe subtree when the CLI hard-exits mid-probe (Ctrl-C shape, process.exit(130))', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-reap-'));
    try {
      const script = writeForker(dir, { parentExits: false });
      const probeModule = path.resolve(__dirname, 'probe.ts');
      const wrapper = path.join(dir, 'wrapper.ts');
      fs.writeFileSync(
        wrapper,
        [
          `import { probeCapture } from ${JSON.stringify(probeModule)};`,
          `void probeCapture(${JSON.stringify(script)}, [], 30_000).catch(() => {});`,
          `setTimeout(() => process.exit(130), 400);`,
        ].join('\n'),
        'utf-8',
      );
      const tsx = path.resolve(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
      const { spawnSync } = await import('child_process');
      const run = spawnSync(tsx, [wrapper], { stdio: 'ignore', timeout: 15_000 });
      expect(run.status).toBe(130);
      const pid = await readGrandchildPid(dir);
      await expectDeadSoon(pid);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reaps the grandchild when the probe times out on a hung parent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-reap-'));
    try {
      const script = writeForker(dir, { parentExits: false });
      await expect(probeCapture(script, [], 500)).rejects.toThrow(/timed out/);
      const pid = await readGrandchildPid(dir);
      await expectDeadSoon(pid);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
