import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMenubarNotifyArgs,
  buildOsascriptNotifyArgs,
  notifyDesktop,
  spawnDetachedQuiet,
} from './notify-desktop.js';

describe('buildMenubarNotifyArgs', () => {
  it('emits --title/--body and omits optional flags when absent', () => {
    expect(buildMenubarNotifyArgs({ title: 'T', body: 'B' })).toEqual([
      '--notify',
      '--title',
      'T',
      '--body',
      'B',
    ]);
  });

  it('includes subtitle and action when present', () => {
    expect(
      buildMenubarNotifyArgs({
        title: 'Routine finished',
        body: 'Completed in 3s',
        subtitle: 'nightly',
        action: 'open:/tmp/report.md',
      }),
    ).toEqual([
      '--notify',
      '--title',
      'Routine finished',
      '--body',
      'Completed in 3s',
      '--subtitle',
      'nightly',
      '--action',
      'open:/tmp/report.md',
    ]);
  });

  it('forwards the agent so the companion can draw its right-hand avatar', () => {
    expect(
      buildMenubarNotifyArgs({ title: 'claude finished', body: 'ship it', agent: 'claude' }),
    ).toEqual(['--notify', '--title', 'claude finished', '--body', 'ship it', '--agent', 'claude']);
  });

  it('omits --agent when no single harness owns the event', () => {
    expect(buildMenubarNotifyArgs({ title: 'T', body: 'B' })).not.toContain('--agent');
    expect(buildMenubarNotifyArgs({ title: 'T', body: 'B', agent: '' })).not.toContain('--agent');
  });

  it('appends category, key, session, and one --choice per choice (ordered)', () => {
    expect(
      buildMenubarNotifyArgs({
        title: 'claude · Command approval',
        body: 'Run the test suite?',
        subtitle: 'zion · agents-cli',
        agent: 'claude',
        category: 'permission',
        key: 'zion/sess-1/t4000',
        sessionId: 'sess-1',
        choices: [
          { id: 'approve', label: 'Approve' },
          { id: 'approve-session', label: 'Approve for session' },
          { id: 'deny', label: 'Deny' },
        ],
      }),
    ).toEqual([
      '--notify',
      '--title',
      'claude · Command approval',
      '--body',
      'Run the test suite?',
      '--subtitle',
      'zion · agents-cli',
      '--agent',
      'claude',
      '--category',
      'permission',
      '--key',
      'zion/sess-1/t4000',
      '--session',
      'sess-1',
      '--choice',
      'approve=Approve',
      '--choice',
      'approve-session=Approve for session',
      '--choice',
      'deny=Deny',
    ]);
  });

  it('omits the new flags when absent and carries no --choice for an empty list', () => {
    const args = buildMenubarNotifyArgs({ title: 'T', body: 'B', choices: [] });
    expect(args).not.toContain('--category');
    expect(args).not.toContain('--key');
    expect(args).not.toContain('--session');
    expect(args).not.toContain('--choice');
  });

  it('passes a choice label verbatim, splitting only the first = (label may contain =)', () => {
    const args = buildMenubarNotifyArgs({
      title: 'T',
      body: 'B',
      choices: [{ id: 'approve', label: 'a=b=c' }],
    });
    expect(args[args.indexOf('--choice') + 1]).toBe('approve=a=b=c');
  });

  it('passes title/body verbatim as separate argv (no shell interpolation)', () => {
    const args = buildMenubarNotifyArgs({ title: 'a "b" $c', body: 'x; rm -rf /' });
    expect(args[args.indexOf('--title') + 1]).toBe('a "b" $c');
    expect(args[args.indexOf('--body') + 1]).toBe('x; rm -rf /');
  });
});

describe('buildOsascriptNotifyArgs (degradation path)', () => {
  it('builds an AppleScript display-notification statement', () => {
    expect(buildOsascriptNotifyArgs({ title: 'Routine overdue', body: 'catchup' })).toEqual([
      '-e',
      'display notification "catchup" with title "Routine overdue"',
    ]);
  });

  it('escapes embedded double-quotes and backslashes so the script stays well-formed', () => {
    const [flag, script] = buildOsascriptNotifyArgs({
      title: 'say "hi"',
      body: 'path C:\\x',
      subtitle: 'sub "q"',
    });
    expect(flag).toBe('-e');
    expect(script).toBe(
      'display notification "path C:\\\\x" with title "say \\"hi\\"" subtitle "sub \\"q\\""',
    );
  });
});

describe('notifyDesktop — missing notifier must not crash the daemon', () => {
  const origPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = origPath;
  });

  // Parity with overdue.test.ts: on a headless box the notifier is absent and spawn() reports
  // ENOENT as an ASYNC 'error' event; the module's listener keeps Node from crashing the daemon.
  // Emptying PATH forces ENOENT.
  it('swallows the notifier ENOENT and survives', async () => {
    process.env.PATH = '';
    expect(() =>
      notifyDesktop({ title: 'T', body: 'B', action: 'routines:list' }),
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(true).toBe(true);
  });
});

describe('spawnDetachedQuiet — bounded lifetime', () => {
  // A stalled one-shot notifier (locked screen, WindowServer hiccup) must not linger: a real
  // `sleep 30` child that never exits must be SIGKILLed after the timeout. Real process, real
  // signal.
  it('SIGKILLs a child that outlives the timeout', async () => {
    const child = spawnDetachedQuiet('sleep', ['30'], 120);
    const result = await new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        const guard = setTimeout(
          () => reject(new Error('child was not killed within the watchdog window')),
          2000,
        );
        child.on('exit', (code, signal) => {
          clearTimeout(guard);
          resolve({ code, signal });
        });
        child.on('error', (err) => {
          clearTimeout(guard);
          reject(err);
        });
      },
    );
    expect(result.signal).toBe('SIGKILL');
    expect(child.killed).toBe(true);
  });

  it('leaves a child that self-exits before the timeout untouched', async () => {
    const child = spawnDetachedQuiet('true', [], 2000);
    const result = await new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        child.on('exit', (code, signal) => resolve({ code, signal }));
        child.on('error', reject);
      },
    );
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(child.killed).toBe(false);
  });
});
