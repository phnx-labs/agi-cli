import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import chalk from 'chalk';
import { gatherLiveTargets } from './go.js';
import type { ActiveSession } from '../lib/session/active.js';
import { killSession } from '../lib/tmux/index.js';
import { getDefaultSocketPath } from '../lib/tmux/paths.js';
import { getAgentsInvocation } from '../lib/daemon/daemon.js';
import { captureProcessStartTime } from '../lib/platform/process.js';
import { writeDetachRecord } from '../lib/session/detached.js';
import { getLogsDir } from '../lib/state.js';
import { runOnPeer } from '../lib/session/remote-list.js';
import { buildBackgroundArgv, resolveDetachTarget, resolveOne } from './detach-core.js';
import { setHelpSections } from '../lib/help.js';

export function registerDetachCommand(program: Command, group: 'sessions' | 'ps' = 'sessions'): void {
  const cmd = program
    .command('detach')
    .argument('<id>', 'Short or full id of the live session to background')
    .option('--local', 'Only this machine (skip the cross-host sweep)')
    .description('Send a live agent to the background — stop its terminal, keep it working headless')
    .action(async (id: string, opts: { local?: boolean }) => {
      await detachAction(id, opts);
    });
  setHelpSections(cmd, {
    examples: `
      # Background a live session: its terminal closes, the agent keeps working headless
      agents ${group} detach 4b2f1a9c

      # Bring it back into a terminal later
      agents sessions resume 4b2f1a9c
    `,
  });
}

export async function stopInteractive(s: ActiveSession, socket: string = getDefaultSocketPath()): Promise<void> {
  if (s.tmuxTarget) {
    const name = s.tmuxTarget.split(':')[0];
    await killSession(name, socket);
  } else if (s.pid && s.pid > 0) {
    try {
      process.kill(s.pid, 'SIGTERM');
    } catch {
      return;
    }
  }
  if (s.pid && s.pid > 0) await waitForExit(s.pid);
}

async function waitForExit(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() >= deadline) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function backgroundLogPath(sessionId: string): string {
  return path.join(getLogsDir(), `detach-${sessionId.slice(0, 8)}.log`);
}

function spawnHeadless(command: string, args: string[], logFile: string): Promise<number> {
  return new Promise((resolve, reject) => {
    mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = openSync(logFile, 'a');
    const child = spawn(command, args, { detached: true, stdio: ['ignore', fd, fd], env: process.env });
    child.once('spawn', () => {
      const pid = child.pid ?? 0;
      child.unref();
      try { closeSync(fd); } catch {  }
      resolve(pid);
    });
    child.once('error', (err) => {
      try { closeSync(fd); } catch {  }
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

async function detachAction(id: string, opts: { local?: boolean } = {}): Promise<void> {
  const { self, activeById } = await gatherLiveTargets(!!opts.local, { includeCloud: true, selector: id });
  const resolved = resolveOne(activeById, id);
  if ('error' in resolved) {
    console.error(chalk.red(resolved.error));
    process.exitCode = 1;
    return;
  }
  const s = resolved;
  const target = resolveDetachTarget(s, self);

  if (target.kind === 'refuse') {
    console.error(chalk.red(target.reason));
    process.exitCode = 1;
    return;
  }

  const short = target.sessionId.slice(0, 8);

  if (target.kind === 'remote') {
    console.log(chalk.gray(`${short} lives on ${target.machine} — detaching it there over SSH…`));
    const rc = await runOnPeer(['ps', 'detach', target.sessionId, '--local'], target.machine);
    if (rc === 'no-target') {
      console.error(chalk.red(`Can't reach ${target.machine} to detach ${short}.`));
      process.exitCode = 1;
    }
    return;
  }

  const sessionId = target.sessionId;
  const agent = s.kind;
  await stopInteractive(s);

  const logFile = backgroundLogPath(sessionId);
  const inv = getAgentsInvocation(buildBackgroundArgv(agent, sessionId, s.cwd));
  const pid = await spawnHeadless(inv.command, inv.args, logFile);

  writeDetachRecord({
    sessionId,
    agent,
    cwd: s.cwd,
    headlessPid: pid,
    headlessStartTime: captureProcessStartTime(pid),
    detachedAtMs: Date.now(),
  });

  console.log(
    chalk.green(`◒ Backgrounded ${agent} ${short}`) +
      chalk.gray(` — running headless (pid ${pid}). Bring it back: agents sessions resume ${short}`),
  );
  console.log(chalk.gray(`  logs: ${logFile}`));
}
