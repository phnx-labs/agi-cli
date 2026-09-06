import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getRuntimeStateDir, getTerminalsDir } from '../state.js';
import { writePidSessionEntry } from '../session/pid-registry.js';
import { runAgents, writeUpdateCache } from '../../commands/sessions.test-fixture.js';

describe('remote launch resolution protocol', () => {
  it.skipIf(process.platform === 'win32')('executes the owning CLI against a real legacy hook and leaves registry bytes unchanged', () => {
    const home = process.env.HOME!;
    writeUpdateCache(home);
    const pid = process.pid;
    writePidSessionEntry({ pid, agent: 'codex', launchId: 'exact-launch', terminalId: 'origin-tab', startedAtMs: Date.now() });
    const dir = path.join(getRuntimeStateDir(), 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, session_id: 'execution-session', ts: Date.now() / 1000 }));
    const registryPath = path.join(getTerminalsDir(), 'by-pid', `${pid}.json`);
    const before = fs.readFileSync(registryPath, 'utf8');
    const result = runAgents(['sessions', '--resolve-launch-id', 'exact-launch', '--json', '--local'], process.cwd(), home);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ launchId: 'exact-launch', sessionId: 'execution-session' });
    expect(fs.readFileSync(registryPath, 'utf8')).toBe(before);
    const absent = runAgents(['sessions', '--resolve-launch-id', 'different-launch', '--json', '--local'], process.cwd(), home);
    expect(absent.status, absent.stderr).toBe(0);
    expect(JSON.parse(absent.stdout)).toEqual({ launchId: 'different-launch', sessionId: null });
  });
});
