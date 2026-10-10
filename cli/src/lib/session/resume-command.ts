import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import chalk from 'chalk';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { AGENTS } from '../agents.js';
import { getAgentsInvocation } from '../daemon/daemon.js';
import { composeWin32CommandLine, needsWindowsShell } from '../platform/index.js';
import { getShimsDir } from '../state.js';
import type { AgentId } from '../types.js';
import { sessionAgentSupportsResume, sessionRecoveryRunArgs } from './recovery.js';
import { sessionOwnerDevice } from './resume-owner.js';

export function buildCanonicalResumeCommand(sessionId: string): string[] {
  return ['agents', 'sessions', 'resume', sessionId];
}

export async function resumeSessionInPlace(session: SessionMeta): Promise<void> {
  const owner = sessionOwnerDevice(session);
  if (owner) {
    console.error(chalk.red(`Session ${session.shortId} belongs to ${owner} — it cannot resume on this machine.`));
    console.error(chalk.gray(`  Resume it there: agents sessions resume ${session.id}`));
    process.exitCode = 1;
    return;
  }

  const cwd = session.cwd && fs.existsSync(session.cwd)
    ? session.cwd
    : process.cwd();

  const resume = buildSessionRecoveryCommand(session);

  console.log(chalk.gray(`Resuming: ${resume.join(' ')} (cwd: ${cwd})`));

  await spawnResumeCommand(resume, cwd);
}

export function buildSessionRecoveryCommand(session: Pick<SessionMeta, 'id'>, portable = false): string[] {
  const args = sessionRecoveryRunArgs(session);
  if (portable) return ['agents', ...args];
  const invocation = getAgentsInvocation(args);
  return [invocation.command, ...invocation.args];
}

export function resumeSpawnInvocation(
  cmd: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; shell: boolean } {
  const shell = needsWindowsShell(cmd[0], platform);
  if (shell) {
    return {
      command: composeWin32CommandLine(cmd[0], cmd.slice(1)),
      args: [],
      shell: true,
    };
  }
  return { command: cmd[0], args: cmd.slice(1), shell: false };
}

function spawnResumeCommand(cmd: string[], cwd: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let child: ChildProcess;
    try {
      const { command, args, shell } = resumeSpawnInvocation(cmd);
      child = spawn(command, args, {
        cwd,
        stdio: 'inherit',
        shell,
      });
    } catch (err: any) {
      console.error(chalk.red(`Failed to launch ${cmd[0]}: ${err.message}`));
      resolve();
      return;
    }
    child.on('error', (err: any) => {
      console.error(chalk.red(`Failed to launch ${cmd[0]}: ${err.message}`));
      if (err.code === 'ENOENT') {
        console.error(chalk.gray(`Make sure '${cmd[0]}' is on your PATH.`));
      }
      resolve();
    });
    child.on('close', () => resolve());
  });
}

function resumeArgv(agent: SessionMeta['agent'], id: string, launcher: string): string[] | null {
  switch (agent) {
    case 'claude': return [launcher, '--resume', id];
    case 'codex': return [launcher, 'resume', id];
    case 'opencode': return [launcher, '--session', id];
    case 'muse': return [launcher, 'resume', id];
    default: return null;
  }
}

function versionedAliasIfPresent(agent: SessionMeta['agent'], version: string): string | null {
  const cli = AGENTS[agent as AgentId]?.cliCommand ?? agent;
  const base = path.join(getShimsDir(), `${cli}@${version}`);
  if (process.platform === 'win32' && fs.existsSync(`${base}.cmd`)) return `${base}.cmd`;
  if (fs.existsSync(base)) return base;
  return null;
}

export function buildResumeCommand(session: SessionMeta): string[] | null {
  if (!sessionAgentSupportsResume(session.agent)) return null;
  switch (session.agent) {
    case 'opencode':
      return resumeArgv('opencode', session.id, 'opencode');

    case 'claude':
    case 'codex':
    case 'muse': {
      const cli = AGENTS[session.agent as AgentId]?.cliCommand ?? session.agent;
      if (session.version) {
        const alias = versionedAliasIfPresent(session.agent, session.version);
        return resumeArgv(session.agent, session.id, alias ?? `${cli}@${session.version}`);
      }
      return resumeArgv(session.agent, session.id, cli);
    }
    default:
      return null;
  }
}
