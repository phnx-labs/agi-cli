import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { sshExecMock, sshExecRawMock } = vi.hoisted(() => ({
  sshExecMock: vi.fn(),
  sshExecRawMock: vi.fn(),
}));

vi.mock('../ssh-exec.js', async () => {
  const actual = await vi.importActual<typeof import('../ssh-exec.js')>('../ssh-exec.js');
  return { ...actual, sshExec: sshExecMock, sshExecRaw: sshExecRawMock };
});

import { AgentManager, AgentProcess, AgentStatus } from './agents.js';

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-remote-liveness-'));
}

async function makeRemoteRunning(base: string, id: string): Promise<AgentProcess> {
  const agent = new AgentProcess(
    id, 'dist-team', 'claude', 'do a thing',
    null, 'plan', null, AgentStatus.RUNNING, new Date(), null, base,
  );
  agent.hostName = 'yosemite-s0';
  agent.hostTarget = 'yosemite-s0.tail1a85a1.ts.net';
  agent.repoPath = '/home/muqsit/.agents/repos/dist-team';
  agent.remotePid = 4242;
  agent.remoteLog = '$HOME/.agents/.cache/hosts/aaaaaaaa.log';
  agent.remoteExit = '$HOME/.agents/.cache/hosts/aaaaaaaa.exit';
  agent.remoteLogOffset = 0;
  await agent.saveMeta();
  return agent;
}

describe('remote GONE detection — a killed --device teammate resolves terminal (RUSH-2366)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    sshExecMock.mockReset();
    sshExecRawMock.mockReset();
  });

  it('GONE (process dead, no .exit sentinel at all) resolves FAILED, not RUNNING forever', async () => {
    const base = tmpBase();
    dirs.push(base);
    const id = 'remote-killed';
    await makeRemoteRunning(base, id);

    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });
    sshExecMock.mockReturnValue({ code: 0, stdout: `${id} GONE\n`, stderr: '' });

    const mgr = new AgentManager(50, base);
    const all = await mgr.listAll();

    expect(all).toHaveLength(1);
    expect(all[0].status).toBe(AgentStatus.FAILED);
    expect(all[0].completedAt).not.toBeNull();
  });

  it('EXITED with a parseable code resolves COMPLETED/FAILED from that code', async () => {
    const base = tmpBase();
    dirs.push(base);
    const id = 'remote-exited';
    await makeRemoteRunning(base, id);

    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });
    sshExecMock.mockReturnValue({ code: 0, stdout: `${id} EXITED 1\n`, stderr: '' });

    const mgr = new AgentManager(50, base);
    const all = await mgr.listAll();

    expect(all[0].status).toBe(AgentStatus.FAILED);
  });

  it('EXITED with an empty (mid-write) code stays RUNNING — does not misfire as GONE', async () => {
    const base = tmpBase();
    dirs.push(base);
    const id = 'remote-mid-write';
    await makeRemoteRunning(base, id);

    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });
    sshExecMock.mockReturnValue({ code: 0, stdout: `${id} EXITED\n`, stderr: '' });

    const mgr = new AgentManager(50, base);
    const all = await mgr.listAll();

    expect(all[0].status).toBe(AgentStatus.RUNNING);
  });

  it('ALIVE (process still running, no sentinel) stays RUNNING', async () => {
    const base = tmpBase();
    dirs.push(base);
    const id = 'remote-alive';
    await makeRemoteRunning(base, id);

    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });
    sshExecMock.mockReturnValue({ code: 0, stdout: `${id} ALIVE\n`, stderr: '' });

    const mgr = new AgentManager(50, base);
    const all = await mgr.listAll();

    expect(all[0].status).toBe(AgentStatus.RUNNING);
  });

  it('a transient ssh failure (code null) leaves the teammate RUNNING rather than reaping it', async () => {
    const base = tmpBase();
    dirs.push(base);
    const id = 'remote-ssh-blip';
    await makeRemoteRunning(base, id);

    sshExecRawMock.mockReturnValue({ code: null, stdout: Buffer.alloc(0), stderr: 'connection refused' });
    sshExecMock.mockReturnValue({ code: null, stdout: '', stderr: 'connection refused' });

    const mgr = new AgentManager(50, base);
    const all = await mgr.listAll();

    expect(all[0].status).toBe(AgentStatus.RUNNING);
  });

  it('a staged (--after) distributed teammate is left untouched — no ssh call, no completedAt stamped', async () => {
    const base = tmpBase();
    dirs.push(base);
    const id = 'remote-staged';
    const agent = new AgentProcess(
      id, 'dist-team', 'claude', 'do a thing',
      null, 'plan', null, AgentStatus.PENDING, new Date(), null, base,
      null, null, null, null, null, null, null, 'staged', ['someone-else'],
    );
    agent.hostName = 'yosemite-s0';
    agent.hostTarget = 'yosemite-s0.tail1a85a1.ts.net';
    agent.remotePid = null as unknown as number;
    await agent.saveMeta();

    const mgr = new AgentManager(50, base);
    const all = await mgr.listAll();

    expect(all[0].status).toBe(AgentStatus.PENDING);
    expect(all[0].completedAt).toBeNull();
    expect(sshExecMock).not.toHaveBeenCalled();
    expect(sshExecRawMock).not.toHaveBeenCalled();

    const reread = await AgentProcess.loadFromDisk(id, base);
    expect(reread?.status).toBe(AgentStatus.PENDING);
    expect(reread?.completedAt).toBeNull();
  });
});
