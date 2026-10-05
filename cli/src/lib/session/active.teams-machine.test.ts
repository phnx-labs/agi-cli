/** A remote teams teammate is attributed to the box it executes on, not the orchestrator
 * (SES-GAP-10, RUSH-2486). `teams add --device <peer>` has no host-dispatch index row;
 * `listTeamsActive` now folds `AgentProcess.hostName` into `machine`/`offloadedFrom`. No mocks. */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-teamsmachine-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.AGENTS_SYNC_MACHINE_ID = 'dispatcher-box';

const { getTeamsAgentsDir } = await import('../state.js');
const { listTeamsActive } = await import('./active.js');

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  delete process.env.AGENTS_SYNC_MACHINE_ID;
});

/** Write a minimal RUNNING teammate meta.json the AgentManager will load. */
function seedTeammate(agentId: string, over: Record<string, unknown>): void {
  const dir = path.join(getTeamsAgentsDir(), agentId);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    agent_id: agentId,
    task_name: 'feat',
    agent_type: 'claude',
    prompt: 'do the thing',
    cwd: null,
    mode: 'auto',
    pid: null,
    status: 'running',
    started_at: '2026-08-10T00:00:00.000Z',
    remote_session_id: `sess-${agentId}`,
    name: agentId,
    ...over,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
}

async function rowFor(agentId: string) {
  const rows = await listTeamsActive({ localOnly: true });
  return rows.find((r) => r.sessionId === `sess-${agentId}`);
}

describe('listTeamsActive execution-host attribution', () => {
  it('attributes a --device peer teammate to its execution host and marks the dispatcher', async () => {
    seedTeammate('remote-peer', { host_name: 'yosemite-s0', host_target: 'user@yosemite-s0' });
    const row = await rowFor('remote-peer');
    expect(row).toBeDefined();
    expect(row!.machine).toBe('yosemite-s0');
    // offloadedFrom is the dispatcher (this box) so the value survives the
    // cross-machine fan-out (parseRemoteActive keeps an offloaded row's machine)
    // and is COMPARED to this box downstream, never merely tested.
    expect(row!.offloadedFrom).toBe('dispatcher-box');
  });

  it('leaves a teammate pinned to this box unattributed for the self-stamp', async () => {
    // `--device` onto the orchestrator's own box: it executes HERE, so machine
    // must stay unset for the self-stamp rather than reading as offloaded.
    seedTeammate('remote-self', { host_name: 'dispatcher-box', host_target: 'user@dispatcher-box' });
    const row = await rowFor('remote-self');
    expect(row).toBeDefined();
    expect(row!.machine).toBeUndefined();
    expect(row!.offloadedFrom).toBeUndefined();
  });
});
