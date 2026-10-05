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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-remote-poll-'));
}

async function makeRemoteTeammate(base: string, id: string, status: AgentStatus): Promise<AgentProcess> {
  const agent = new AgentProcess(
    id, 'dist-team', 'claude', 'do a thing',
    null, 'plan', null, status, new Date(),
    status === AgentStatus.RUNNING ? null : new Date(), base,
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

describe('remote-host teammate polling (RUSH-2118)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    sshExecMock.mockReset();
    sshExecRawMock.mockReset();
  });

  it('a --local (localOnly) query issues zero ssh for a still-RUNNING remote teammate', async () => {
    const base = tmpBase();
    dirs.push(base);
    await makeRemoteTeammate(base, 'remote-running', AgentStatus.RUNNING);

    sshExecMock.mockReturnValue({ code: 0, stdout: '', stderr: '' });
    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });

    const mgr = new AgentManager(50, base, undefined, undefined, undefined, true);
    const all = await mgr.listAll();

    expect(all).toHaveLength(1);
    expect(all[0].status).toBe(AgentStatus.RUNNING);
    expect(sshExecMock).not.toHaveBeenCalled();
    expect(sshExecRawMock).not.toHaveBeenCalled();
  });

  it('a terminal-status remote teammate is never re-polled, --local or not', async () => {
    const base = tmpBase();
    dirs.push(base);
    await makeRemoteTeammate(base, 'remote-done', AgentStatus.COMPLETED);

    sshExecMock.mockReturnValue({ code: 0, stdout: '', stderr: '' });
    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });

    const mgr = new AgentManager(50, base);
    const all = await mgr.listAll();

    expect(all).toHaveLength(1);
    expect(all[0].status).toBe(AgentStatus.COMPLETED);
    expect(sshExecMock).not.toHaveBeenCalled();
    expect(sshExecRawMock).not.toHaveBeenCalled();
  });

  it('sanity: a still-RUNNING remote teammate DOES get polled when not --local', async () => {
    const base = tmpBase();
    dirs.push(base);
    await makeRemoteTeammate(base, 'remote-running-2', AgentStatus.RUNNING);

    sshExecMock.mockReturnValue({ code: 0, stdout: '', stderr: '' });
    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });

    const mgr = new AgentManager(50, base);
    await mgr.listAll();

    expect(sshExecRawMock).toHaveBeenCalled();
  });
});
