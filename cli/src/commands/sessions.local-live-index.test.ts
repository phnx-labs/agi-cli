import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-local-live-index-home-'));
const originalHome = process.env.HOME;
process.env.HOME = fakeHome;
fs.mkdirSync(path.join(fakeHome, '.agents'), { recursive: true });

const { sshExecMock, sshExecRawMock } = vi.hoisted(() => ({
  sshExecMock: vi.fn(),
  sshExecRawMock: vi.fn(),
}));

vi.mock('../lib/ssh-exec.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/ssh-exec.js')>('../lib/ssh-exec.js');
  return { ...actual, sshExec: sshExecMock, sshExecRaw: sshExecRawMock };
});

const { maybeLiveIndex, renderSessionPreview } = await import('./sessions.js');
const { AgentProcess, AgentStatus } = await import('../lib/teams/agents.js');

afterEach(() => {
  sshExecMock.mockReset();
  sshExecRawMock.mockReset();
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

async function makeRemoteTeammate(id: string): Promise<void> {
  const agent = new AgentProcess(
    id, 'dist-team', 'claude', 'do a thing',
    null, 'plan', null, AgentStatus.RUNNING, new Date(), null,
  );
  agent.hostName = 'fake-device';
  agent.hostTarget = 'fake-device.tail1a85a1.ts.net';
  agent.repoPath = '/home/fake/repo';
  agent.remotePid = 4242;
  agent.remoteSessionId = `${id}-ffffffff-ffff-ffff-ffff-ffffffffffff`;
  agent.remoteLog = '$HOME/.agents/.cache/hosts/aaaaaaaa.log';
  agent.remoteExit = '$HOME/.agents/.cache/hosts/aaaaaaaa.exit';
  agent.remoteLogOffset = 0;
  await agent.saveMeta();
}

function writeClaudeSession(sessionId: string, cwd: string): void {
  fs.mkdirSync(cwd, { recursive: true });
  const projectKey = cwd.replace(/[/.]/g, '-');
  const sessionsDir = path.join(fakeHome, '.claude', 'projects', projectKey);
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: 'user',
      timestamp: new Date().toISOString(),
      cwd,
      sessionId,
      version: '2.1.110',
      gitBranch: 'main',
      message: { role: 'user', content: 'RUSH-2118 preview fixture' },
    }) + '\n',
    'utf-8',
  );
}

describe.skipIf(process.platform === 'win32')('maybeLiveIndex --local (RUSH-2118 default-listing gap)', () => {
  it('a bare `agents sessions --local` (no --active) issues zero ssh for a remote-host teammate', async () => {
    await makeRemoteTeammate('remote-running-local');

    sshExecMock.mockReturnValue({ code: 0, stdout: '', stderr: '' });
    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });

    const index = await maybeLiveIndex({ local: true } as any);

    expect(sshExecMock).not.toHaveBeenCalled();
    expect(sshExecRawMock).not.toHaveBeenCalled();
    expect(index?.size ?? 0).toBeGreaterThan(0);
  });

  it('sanity: without --local, the same remote-host teammate DOES get dialed', async () => {
    await makeRemoteTeammate('remote-running-nonlocal');

    sshExecMock.mockReturnValue({ code: 0, stdout: '', stderr: '' });
    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });

    await maybeLiveIndex({} as any);

    expect(sshExecRawMock).toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === 'win32')('renderSessionPreview --local (RUSH-2118 --preview gap)', () => {
  const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  afterAll(() => consoleLogSpy.mockRestore());

  it('`agents sessions --local --preview <id>` issues zero ssh for a remote-host teammate', async () => {
    const sessionId = crypto.randomUUID();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rush2118-preview-cwd-'));
    writeClaudeSession(sessionId, cwd);
    await makeRemoteTeammate('remote-running-preview-local');

    sshExecMock.mockReturnValue({ code: 0, stdout: '', stderr: '' });
    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });

    await renderSessionPreview(sessionId, { local: true });

    expect(sshExecMock).not.toHaveBeenCalled();
    expect(sshExecRawMock).not.toHaveBeenCalled();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('an exact local UUID preview does not dial an unrelated remote teammate', async () => {
    const sessionId = crypto.randomUUID();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rush2118-preview-cwd-'));
    writeClaudeSession(sessionId, cwd);
    await makeRemoteTeammate('remote-running-preview-nonlocal');

    sshExecMock.mockReturnValue({ code: 0, stdout: '', stderr: '' });
    sshExecRawMock.mockReturnValue({ code: 0, stdout: Buffer.alloc(0), stderr: '' });

    await renderSessionPreview(sessionId, {});

    expect(sshExecMock).not.toHaveBeenCalled();
    expect(sshExecRawMock).not.toHaveBeenCalled();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
