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
      'pid 4242, up 05:00: …/claude -p headless',
    ]);
    const line = activeCheck.formatInUseDeferral('Claude@2.1.219', activity);
    expect(line).toContain('pid 2173999');
    expect(line).not.toContain('??');
    expect(line).toContain('agents ps stop');
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

describe('listProcessRowsFromProc', () => {
  it('reads pid and full argv from a /proc tree without ps, and fails loud when /proc is unreadable', async () => {
    const { activeCheck, store } = await load();
    const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-proc-'));
    try {
      const dir = store.getVersionDir('opencode', 'main');
      fs.mkdirSync(path.join(proc, '4242'));
      fs.writeFileSync(path.join(proc, '4242', 'cmdline'), `${dir}/node_modules/.bin/opencode\0run\0--model\0x\0`);
      fs.mkdirSync(path.join(proc, '7'));
      fs.writeFileSync(path.join(proc, '7', 'cmdline'), '');
      fs.mkdirSync(path.join(proc, 'self'));
      const rows = activeCheck.listProcessRowsFromProc(proc);
      expect(rows).toEqual([{ pid: 4242, args: `${dir}/node_modules/.bin/opencode run --model x` }]);
      expect(activeCheck.installationLooksActive({ agent: 'opencode', label: 'main' }, rows.map((r) => r.args))).toBe(true);
      expect(activeCheck.installationLooksActive({ agent: 'opencode', label: '1.0.0' }, rows.map((r) => r.args))).toBe(false);
      expect(() => activeCheck.listProcessRowsFromProc(path.join(proc, 'missing'))).toThrow(/could not read the process table/);
    } finally {
      fs.rmSync(proc, { recursive: true, force: true });
    }
  });
});
