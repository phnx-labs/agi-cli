import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { repoRoot, runAgents, tsxLoaderUrl } from '../commands/sessions.test-fixture.js';
import { failureCause, launchSessionId, launchesAgent } from './launch-log.js';

describe('launch classification', () => {
  it('names the session a launch resumes and which commands end in an agent', () => {
    expect(launchSessionId(['sessions', 'resume', 'abc', '--quiet'])).toBe('abc');
    expect(launchSessionId(['run', 'claude', '--resume', 'abc', '--quiet'])).toBe('abc');
    expect(launchSessionId(['sessions', '--json'])).toBeUndefined();
    expect(launchesAgent(['run', 'claude', '--resume', 'abc'])).toBe(true);
    expect(launchesAgent(['sessions', 'resume', 'abc'])).toBe(true);
    expect(launchesAgent(['sessions', '--json'])).toBe(false);
  });

  it('takes the cause from the last lines, without colour codes', () => {
    expect(failureCause('noise\n\x1b[31mNo session matching "x".\x1b[39m\n  Try: agents sessions\n')).toBe('No session matching "x".');
    expect(failureCause('')).toContain('without saying why');
  });
});

describe.skipIf(process.platform === 'win32')('a quiet launch through the real CLI', () => {
  it('prints nothing but the failure and its log, keeps the chatter in the log, and records the cause', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-launch-'));
    fs.mkdirSync(path.join(home, '.agents', '.cache'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', '.cache', '.update-check'),
      JSON.stringify({ lastCheck: Date.now(), latestVersion: '999.0.0' }));
    fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
    const id = '0db3f95b-0000-4000-8000-000000000000';

    const nodeOnly = path.join(home, 'node-only');
    fs.mkdirSync(nodeOnly);
    fs.symlinkSync(process.execPath, path.join(nodeOnly, 'node'));
    const res = runAgents(['sessions', 'resume', id, '--quiet', '--local'], repoRoot, home, {
      PATH: nodeOnly, AGENTS_NO_AUTOPULL: '1', NODE_OPTIONS: `--import ${tsxLoaderUrl}`, AGENTS_CLI_DISABLE_AUTO_UPDATE: '',
    });

    expect(res.status).not.toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).not.toContain('Update available');
    expect(res.stderr).not.toContain('Upgrade now');
    const m = res.stderr.match(/^\nThe agent did not start: (.+)\nFull output: (.+)\n$/);
    expect(m, res.stderr).not.toBeNull();
    expect(m![1]).toContain(id.slice(0, 8));
    const log = fs.readFileSync(m![2], 'utf8');
    expect(log).toContain('Update available');
    const record = JSON.parse(fs.readFileSync(path.join(path.dirname(m![2]), `${id}.json`), 'utf8'));
    expect(record).toMatchObject({ status: 'failed', log: m![2], cause: m![1] });
  }, 60_000);
});
