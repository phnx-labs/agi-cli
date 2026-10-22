import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-session-state-live-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.AGENTS_DAEMON_DIR = path.join(TEST_HOME, 'daemon');

const accountSessions = path.join(TEST_HOME, '.agents', '.history', 'accounts', 'claude', 'acct-live-0001', '.claude', 'sessions');
fs.mkdirSync(accountSessions, { recursive: true });

const { ServiceSupervisor } = await import('./supervisor.js');
const { SessionStateService } = await import('./session-state-service.js');
const { readClaudeLiveNames } = await import('../session/discover.js');

afterAll(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function writeLiveName(name: string): void {
  fs.writeFileSync(path.join(accountSessions, '4101.json'), JSON.stringify({
    pid: 4101, sessionId: 'live-0001', cwd: '/repo', kind: 'interactive', name, nameSource: 'user', updatedAt: Date.now(),
  }));
}

describe('SessionStateService wakes on a live Claude session file', () => {
  it('a /rename wakes the publish at once, a burst wakes it once, a recreated dir is watched again', async () => {
    readClaudeLiveNames();
    const supervisor = new ServiceSupervisor();
    const wakes: number[] = [];
    supervisor.register(new SessionStateService(() => { wakes.push(Date.now()); supervisor.runNow('session-state'); }));
    await supervisor.startAll({ log: () => {} });
    await pause(1_200);
    wakes.length = 0;

    const renamedAt = Date.now();
    writeLiveName('Improve - AGI Ext');
    await pause(1_100);
    expect(wakes.length).toBe(1);
    expect(wakes[0] - renamedAt).toBeLessThan(1_000);

    for (let i = 0; i < 5; i++) { writeLiveName(`burst ${i}`); await pause(20); }
    await pause(1_500);
    expect(wakes.length).toBe(2);
    expect(wakes[1] - wakes[0]).toBeGreaterThanOrEqual(990);

    fs.rmSync(accountSessions, { recursive: true });
    fs.mkdirSync(accountSessions, { recursive: true });
    readClaudeLiveNames();
    supervisor.runNow('session-state');
    await pause(1_200);
    wakes.length = 0;
    writeLiveName('after recreate');
    await pause(1_100);
    expect(wakes.length).toBe(1);

    await supervisor.stopAll();
    wakes.length = 0;
    writeLiveName('after stop');
    await pause(400);
    expect(wakes.length).toBe(0);
  });
});
