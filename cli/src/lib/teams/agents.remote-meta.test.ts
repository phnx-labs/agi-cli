import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentProcess, AgentStatus } from './agents.js';

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-remote-meta-'));
}

describe('remote-teammate meta round-trip', () => {
  it('persists and restores every host/remote field', async () => {
    const base = tmpBase();
    const id = 'remote-agent-1';
    fs.mkdirSync(path.join(base, id), { recursive: true });

    const a = new AgentProcess(
      id, 'dist-team', 'claude', 'do a thing',
      null, 'plan', null, AgentStatus.RUNNING, new Date(), null, base,
    );
    a.hostName = 'yosemite-s0';
    a.hostTarget = 'yosemite-s0.tail1a85a1.ts.net';
    a.repoPath = '/home/muqsit/.agents/repos/dist-team';
    a.remotePid = 3007345;
    a.remoteLog = '$HOME/.agents/.cache/hosts/04e22423.log';
    a.remoteExit = '$HOME/.agents/.cache/hosts/04e22423.exit';
    a.remoteLogOffset = 512;
    a.hostIdentityFile = '/home/muqsit/.ssh/fleet_ed25519';
    await a.saveMeta();

    const loaded = await AgentProcess.loadFromDisk(id, base);
    expect(loaded).not.toBeNull();
    expect(loaded!.hostName).toBe('yosemite-s0');
    expect(loaded!.hostTarget).toBe('yosemite-s0.tail1a85a1.ts.net');
    expect(loaded!.repoPath).toBe('/home/muqsit/.agents/repos/dist-team');
    expect(loaded!.remotePid).toBe(3007345);
    expect(loaded!.remoteLog).toBe('$HOME/.agents/.cache/hosts/04e22423.log');
    expect(loaded!.remoteExit).toBe('$HOME/.agents/.cache/hosts/04e22423.exit');
    expect(loaded!.remoteLogOffset).toBe(512);
    expect(loaded!.hostIdentityFile).toBe('/home/muqsit/.ssh/fleet_ed25519');

    fs.rmSync(base, { recursive: true, force: true });
  });

  it('a purely-local teammate loads with null host fields (no regression)', async () => {
    const base = tmpBase();
    const id = 'local-agent-1';
    fs.mkdirSync(path.join(base, id), { recursive: true });

    const a = new AgentProcess(
      id, 'local-team', 'claude', 'do a thing',
      null, 'plan', 4242, AgentStatus.RUNNING, new Date(), null, base,
    );
    await a.saveMeta();

    const loaded = await AgentProcess.loadFromDisk(id, base);
    expect(loaded).not.toBeNull();
    expect(loaded!.hostName).toBeNull();
    expect(loaded!.remotePid).toBeNull();
    expect(loaded!.remoteLogOffset).toBe(0);
    expect(loaded!.pid).toBe(4242);

    fs.rmSync(base, { recursive: true, force: true });
  });
});
