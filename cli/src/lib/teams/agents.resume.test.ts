import { describe, it, expect } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgentManager,
  AgentProcess,
  AgentStatus,
  beginResumeLogTransaction,
  captureProcessStartTime,
  commitResumeLogTransaction,
  terminateSpawnedProcess,
} from './agents.js';
import { IS_WINDOWS } from '../platform/index.js';
import { shellQuote } from '../ssh-exec.js';

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-resume-test-'));
}

function argv(opts: {
  agentType?: string;
  prompt?: string;
  mode?: string;
  model?: string | null;
  effort?: string;
  version?: string | null;
  profileName?: string | null;
  resume?: { id: string; message: string };
}): string[] {
  const mgr = new AgentManager() as any;
  return mgr.buildRunArgv(
    opts.agentType ?? 'claude',
    opts.prompt ?? 'the original brief',
    opts.mode ?? 'edit',
    opts.model ?? null,
    opts.effort ?? 'medium',
    opts.version ?? null,
    opts.profileName ?? null,
    opts.resume,
  );
}

describe('buildRunArgv — resume', () => {
  it('emits `run <agent> <message> --resume <id>` with headless/json flags', () => {
    const a = argv({ agentType: 'claude', resume: { id: 'sess-123', message: 'merge the PR now' } });
    expect(a[0]).toBe('run');
    expect(a[1]).toBe('claude');
    expect(a[2].startsWith('merge the PR now')).toBe(true);
    const ri = a.indexOf('--resume');
    expect(ri).toBeGreaterThan(-1);
    expect(a[ri + 1]).toBe('sess-123');
    expect(a).toContain('--headless');
    expect(a).toContain('--json');
    expect(a).toContain('--quiet');
    expect(a).toContain('--mode');
    expect(a).toContain('--effort');
  });

  it('drops the Claude plan-mode prefix on resume but keeps it on a fresh plan launch', () => {
    const fresh = argv({ agentType: 'claude', mode: 'plan', prompt: 'do X' });
    const resumed = argv({ agentType: 'claude', mode: 'plan', resume: { id: 'x', message: 'keep going' } });
    expect(fresh[2].includes('HEADLESS PLAN MODE')).toBe(true);
    expect(resumed[2].includes('HEADLESS PLAN MODE')).toBe(false);
    expect(resumed[2].startsWith('keep going')).toBe(true);
  });

  it('never emits --resume on a fresh (non-resume) launch', () => {
    expect(argv({ agentType: 'codex', prompt: 'do a thing' })).not.toContain('--resume');
  });

  it('is agent-agnostic — a codex resume id forwards the same way', () => {
    const a = argv({ agentType: 'codex', resume: { id: 'thread-abc', message: 'continue' } });
    expect(a[1]).toBe('codex');
    const ri = a.indexOf('--resume');
    expect(a[ri + 1]).toBe('thread-abc');
  });
});

describe('buildCommand — resume omits --session-id', () => {
  it('creates with --session-id on a fresh launch and omits it on resume', () => {
    const mgr = new AgentManager() as any;
    const fresh: string[] = mgr.buildCommand('claude', 'brief', 'edit', null, '/tmp/x', 'agent-uuid', 'medium', null, null);
    expect(fresh).toContain('--session-id');

    const resumed: string[] = mgr.buildCommand(
      'claude', 'brief', 'edit', null, '/tmp/x', 'agent-uuid', 'medium', null, null,
      { id: 'agent-uuid', message: 'go' },
    );
    expect(resumed).not.toContain('--session-id');
    expect(resumed).toContain('--resume');
    expect(resumed).toContain('--add-dir');
  });
});

describe('resumeTeammate — resume-id guard', () => {
  it('refuses to resume a non-Claude teammate whose session id was never captured', async () => {
    const base = tmpBase();
    const id = 'codex-agent-1';
    fs.mkdirSync(path.join(base, id), { recursive: true });

    const a = new AgentProcess(
      id, 'guard-team', 'codex', 'do a thing',
      null, 'edit', null, AgentStatus.COMPLETED, new Date(), new Date(), base,
    );
    await a.saveMeta();

    const mgr = new AgentManager(50, base);
    await expect(mgr.resumeTeammate(id, 'keep going')).rejects.toThrow(/No resumable session id was captured/);

    fs.rmSync(base, { recursive: true, force: true });
  });

  it('refuses a resume message that starts with a dash (would be parsed as a flag)', async () => {
    const base = tmpBase();
    const id = 'claude-agent-dash';
    fs.mkdirSync(path.join(base, id), { recursive: true });

    const a = new AgentProcess(
      id, 'guard-team', 'claude', 'do a thing',
      null, 'edit', null, AgentStatus.COMPLETED, new Date(), new Date(), base,
    );
    await a.saveMeta();

    const mgr = new AgentManager(50, base);
    await expect(mgr.resumeTeammate(id, '-- force merge it')).rejects.toThrow(/can't start with '-'/);

    fs.rmSync(base, { recursive: true, force: true });
  });

  it('uses the captured remoteSessionId as the resume id when present (no throw at the guard)', async () => {
    const base = tmpBase();
    const id = 'codex-agent-2';
    fs.mkdirSync(path.join(base, id), { recursive: true });

    const a = new AgentProcess(
      id, 'guard-team', 'codex', 'do a thing',
      null, 'edit', null, AgentStatus.COMPLETED, new Date(), new Date(), base,
    );
    a.remoteSessionId = 'codex-thread-xyz';
    await a.saveMeta();

    const mgr = new AgentManager(50, base);
    const loaded = await mgr.get(id);
    expect(loaded!.remoteSessionId).toBe('codex-thread-xyz');
    expect(loaded!.agentType).toBe('codex');

    fs.rmSync(base, { recursive: true, force: true });
  });
});

describe.skipIf(IS_WINDOWS)('resumeTeammate — successful launch state', () => {
  it('persists RUNNING without the prior attempt failure after a real local resume launch', async () => {
    const base = tmpBase();
    const id = `claude-agent-resume-success-${Date.now()}`;
    fs.mkdirSync(path.join(base, id), { recursive: true });

    const agent = new AgentProcess(
      id, 'resume-success-team', 'claude', 'do a thing',
      null, 'edit', null, AgentStatus.FAILED, new Date(), new Date(), base,
    );
    agent.failure = {
      stage: 'execution',
      code: 'process-exit-nonzero',
      message: 'prior attempt exited 1',
      exit_code: 1,
      retryable: true,
      observed_at: new Date().toISOString(),
    };
    await agent.saveMeta();

    const mgr = new AgentManager(50, base);
    try {
      const resumed = await mgr.resumeTeammate(id, 'Continue the task');
      expect(resumed.status).toBe(AgentStatus.RUNNING);
      expect(resumed.failure).toBeNull();

      const persisted = await AgentProcess.loadFromDisk(id, base);
      expect(persisted?.status).toBe(AgentStatus.RUNNING);
      expect(persisted?.failure).toBeNull();
    } finally {
      await mgr.stop(id).catch(() => false);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe.skipIf(IS_WINDOWS)('resumeTeammate — launch failure', () => {
  it('terminates the replacement and restores all prior state when persistence fails after spawn', async () => {
    const base = tmpBase();
    const id = 'claude-agent-relaunch-failure';
    const dir = path.join(base, id);
    const marker = `resume-transaction-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const startedAt = new Date(Date.now() - 60 * 60 * 1000);
    const completedAt = new Date(Date.now() - 30 * 60 * 1000);
    fs.mkdirSync(dir, { recursive: true });

    const agent = new AgentProcess(
      id, 'failure-team', 'claude', 'do a thing',
      null, 'edit', null, AgentStatus.COMPLETED, startedAt, completedAt, base,
    );
    agent.failure = {
      stage: 'execution',
      code: 'process-exit-nonzero',
      message: 'prior attempt exited 1',
      exit_code: 1,
      retryable: true,
      observed_at: new Date().toISOString(),
    };
    await agent.saveMeta();
    fs.writeFileSync(path.join(dir, 'prior-turn.log'), 'preserve me');
    const stdoutPath = path.join(dir, 'stdout.log');
    fs.writeFileSync(stdoutPath, 'prior stdout');

    const mgr = new AgentManager(50, base);
    try {
      const preloaded = await mgr.get(id);
      expect(preloaded).not.toBeNull();
      const poison: Record<string, unknown> = {};
      poison.self = poison;
      (preloaded as unknown as { envOverrides: unknown }).envOverrides = { POISON: poison };

      const rejection = await mgr.resumeTeammate(id, marker).then(
        () => { throw new Error('expected resumeTeammate to reject'); },
        (e: unknown) => e as Error,
      );
      expect(rejection.message).toMatch(/restoring stopped state also failed/);
      const originalErr = rejection.cause as Error | undefined;
      expect(originalErr).toBeDefined();
      expect(originalErr!.message).not.toMatch(/restoring stopped state also failed/);

      const retained = (mgr as any).agents.get(id) as AgentProcess | undefined;
      expect(retained).toBeDefined();
      expect(retained!.status).toBe(AgentStatus.COMPLETED);
      expect(retained!.completedAt?.toISOString()).toBe(completedAt.toISOString());
      expect(retained!.startedAt.toISOString()).toBe(startedAt.toISOString());
      expect(retained!.pid).toBeNull();
      expect(retained!.startTime).toBeNull();
      expect(retained!.failure).toEqual(agent.failure);
      expect(fs.readFileSync(path.join(dir, 'prior-turn.log'), 'utf-8')).toBe('preserve me');
      expect(fs.readFileSync(stdoutPath, 'utf-8')).toBe('prior stdout');
      const restored = await AgentProcess.loadFromDisk(id, base);
      expect(restored).not.toBeNull();
      expect(restored!.status).toBe(AgentStatus.COMPLETED);
      expect(restored!.completedAt?.toISOString()).toBe(completedAt.toISOString());
      expect(restored!.failure).toEqual(agent.failure);
      expect(() => execFileSync('pgrep', ['-f', marker], { stdio: 'ignore' })).toThrow();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('kills a TERM-resistant process-group child after the wrapper exits', async () => {
    const base = tmpBase();
    const childPidPath = path.join(base, 'child.pid');
    const childCommand = `echo $$ > ${shellQuote(childPidPath)}; trap '' TERM; sleep 30`;
    const wrapperCommand = `trap 'exit 0' TERM; /bin/sh -c ${shellQuote(childCommand)} & wait`;
    const wrapper = spawn('/bin/sh', ['-c', wrapperCommand], {
      stdio: 'ignore',
      detached: true,
    });
    const wrapperPid = wrapper.pid as number;
    let childPid = 0;

    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (fs.existsSync(childPidPath)) {
          childPid = Number.parseInt(fs.readFileSync(childPidPath, 'utf-8').trim(), 10);
          if (Number.isFinite(childPid) && childPid > 0) break;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(childPid).toBeGreaterThan(0);

      await terminateSpawnedProcess(wrapperPid);

      const isAlive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let attempt = 0; attempt < 20 && (isAlive(-wrapperPid) || isAlive(childPid)); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(isAlive(-wrapperPid)).toBe(false);
      expect(isAlive(childPid)).toBe(false);
    } finally {
      try { process.kill(-wrapperPid, 'SIGKILL'); } catch {  }
      if (childPid > 0) {
        try { process.kill(childPid, 'SIGKILL'); } catch {  }
      }
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe.skipIf(IS_WINDOWS)('resume log-truncation hazard', () => {
  function spawnAlive(agent: AgentProcess, dir: string): ChildProcess {
    const fd = fs.openSync(path.join(dir, 'stdout.log'), 'a');
    const child = spawn('sleep', ['10'], { stdio: ['ignore', fd, fd], detached: true });
    fs.closeSync(fd);
    agent.pid = child.pid ?? null;
    agent.startTime = agent.pid ? captureProcessStartTime(agent.pid) : null;
    agent.status = AgentStatus.RUNNING;
    return child;
  }

  it('a stale prior-turn result:success poisons a LIVE teammate to COMPLETED (why we truncate)', async () => {
    const base = tmpBase();
    const id = 'poison';
    const dir = path.join(base, id);
    fs.mkdirSync(dir, { recursive: true });
    const agent = new AgentProcess(id, 't', 'claude', 'x', null, 'edit', null, AgentStatus.RUNNING, new Date(), null, base);
    const child = spawnAlive(agent, dir);
    try {
      fs.writeFileSync(path.join(dir, 'stdout.log'), JSON.stringify({ type: 'result', subtype: 'success', session_id: 's' }) + '\n');
      expect(agent.isProcessAlive()).toBe(true);
      await agent.updateStatusFromProcess();
      expect(agent.status).toBe(AgentStatus.COMPLETED);
    } finally {
      try { process.kill(-(child.pid as number)); } catch {  }
      try { process.kill(child.pid as number); } catch {  }
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('a truncated (current-turn-only, no terminal event) log leaves a LIVE teammate RUNNING', async () => {
    const base = tmpBase();
    const id = 'clean';
    const dir = path.join(base, id);
    fs.mkdirSync(dir, { recursive: true });
    const agent = new AgentProcess(id, 't', 'claude', 'x', null, 'edit', null, AgentStatus.RUNNING, new Date(), null, base);
    const child = spawnAlive(agent, dir);
    try {
      fs.writeFileSync(path.join(dir, 'stdout.log'), JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }) + '\n');
      expect(agent.isProcessAlive()).toBe(true);
      await agent.updateStatusFromProcess();
      expect(agent.status).toBe(AgentStatus.RUNNING);
    } finally {
      try { process.kill(-(child.pid as number)); } catch {  }
      try { process.kill(child.pid as number); } catch {  }
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('reads a shorter successful-resume log from byte zero', async () => {
    const base = tmpBase();
    const id = 'cursor-reset';
    const dir = path.join(base, id);
    const stdoutPath = path.join(dir, 'stdout.log');
    fs.mkdirSync(dir, { recursive: true });
    const agent = new AgentProcess(
      id, 't', 'claude', 'x', null, 'edit', null,
      AgentStatus.COMPLETED, new Date(), new Date(), base,
    );

    try {
      fs.writeFileSync(stdoutPath, 'prior-turn-event-that-is-longer-than-the-new-log\n');
      await agent.readNewEvents();
      expect(agent.events.at(-1)).toMatchObject({ type: 'raw', content: 'prior-turn-event-that-is-longer-than-the-new-log' });

      const transaction = await beginResumeLogTransaction(agent);
      fs.writeFileSync(stdoutPath, 'new\n');
      await commitResumeLogTransaction(transaction);
      await agent.readNewEvents();

      expect(agent.events.at(-1)).toMatchObject({ type: 'raw', content: 'new' });
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
