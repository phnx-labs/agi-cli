/**
 * A refused update names WHAT holds the installation (PHNX-4116 follow-up):
 * the operator saw "Account home is in use; retry after its sessions finish"
 * with a one-hour-old session on another tty and no way to find it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let home: string;

async function load() {
  const activeCheck = await import('./active-check.js');
  const store = await import('./store.js');
  return { activeCheck, store };
}

describe('describeInstallationActivity', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-active-check-'));
    process.env.HOME = home;
  });
  afterEach(() => {
    delete process.env.HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('names the live process by pid, uptime and tty, and only for this installation', async () => {
    const { activeCheck, store } = await load();
    const dir = store.getVersionDir('claude', '2.1.219');
    const other = store.getVersionDir('claude', '2.1.207');
    const snapshot = {
      listCommandLines: async () => [],
      listProcessRows: async () => [
        { pid: 2173999, elapsed: '01:10:22', tty: 'pts/1', args: `${dir}/node_modules/.bin/claude --permission-mode plan --resume 3ef30267-f84f` },
        { pid: 42, elapsed: '00:01', tty: '?', args: `${other}/node_modules/.bin/claude` },
        { pid: 4242, elapsed: '05:00', tty: '??', args: `${dir}/node_modules/.bin/claude -p headless` },
        { pid: 7, elapsed: '9-01:00:00', tty: '?', args: '/usr/bin/sshd' },
      ],
    };
    const activity = await activeCheck.describeInstallationActivity({ agent: 'claude', label: '2.1.219' }, snapshot);
    expect(activity.active).toBe(true);
    expect(activity.processes).toEqual([
      'pid 2173999, up 01:10:22, pts/1: …/claude --permission-mode plan --resume 3ef30267-f84f',
      // macOS prints `??` for no controlling terminal; it must not print as a tty.
      'pid 4242, up 05:00: …/claude -p headless',
    ]);
    const line = activeCheck.formatInUseDeferral('Claude@2.1.219', activity);
    expect(line).toContain('pid 2173999');
    expect(line).not.toContain('??');
    expect(line).toContain('agents sessions stop');
    expect(line).not.toContain('retry after its sessions finish');
  });

  it('reads idle when nothing names the directory, and fails closed on a broken scan', async () => {
    const { activeCheck } = await load();
    const idle = await activeCheck.describeInstallationActivity(
      { agent: 'claude', label: '2.1.219' },
      { listCommandLines: async () => ['/usr/bin/sshd'] },
    );
    expect(idle).toEqual({ active: false, lease: false, processes: [] });
    const broken = await activeCheck.describeInstallationActivity(
      { agent: 'claude', label: '2.1.219' },
      { listCommandLines: async () => { throw new Error('ps failed'); } },
    );
    expect(broken.active).toBe(true);
    expect(activeCheck.formatInUseDeferral('Claude@2.1.219', broken)).toContain('ps failed');
  });
});
