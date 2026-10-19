import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerLeadCommand } from './lead.js';
import { ensureLeadDir } from '../lib/lead/paths.js';
import { appendHistory, writeSessionState } from '../lib/lead/store.js';

function program(): Command {
  const p = new Command();
  p.exitOverride();
  p.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerLeadCommand(p);
  const override = (c: Command): void => { c.exitOverride(); c.commands.forEach(override); };
  p.commands.forEach(override);
  return p;
}

async function stdoutOf(argv: string[]): Promise<string> {
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
    out += String(chunk);
    const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
    cb?.();
    return true;
  }) as typeof process.stdout.write);
  try {
    await program().parseAsync(['node', 'agents', ...argv]);
  } finally {
    spy.mockRestore();
  }
  return out;
}

describe('agents lead', () => {
  afterEach(() => { process.exitCode = undefined; });

  it('history --json prints a JSON array of turns', async () => {
    const paths = ensureLeadDir('cmd-demo');
    appendHistory(paths, { turn: 't_1', at: '2026-10-13T00:00:00.000Z', ask: 'q', voice: 2, text: 'a.', summary: 'a.', refs: [], tools: [], session: 's', timing: { boot: 0, model: 1, tools: 0 } });
    const out = JSON.parse(await stdoutOf(['lead', 'history', '--project', 'cmd-demo', '--json']));
    expect(out).toEqual([expect.objectContaining({ turn: 't_1', at: '2026-10-13T00:00:00.000Z', ask: 'q', voice: 2, text: 'a.', summary: 'a.', refs: [], tools: [] })]);
  });

  it('status --json reports a stopped Lead from its files', async () => {
    const paths = ensureLeadDir('cmd-status');
    writeSessionState(paths, { sessionId: 'sess-1', model: 'sonnet', startedAtMs: 1, turns: 2, briefed: true, brief: ['project cmd-status'], lastEngine: 'warm' });
    const out = JSON.parse(await stdoutOf(['lead', 'status', '--project', 'cmd-status', '--json']));
    expect(out).toMatchObject({ project: 'cmd-status', state: 'stopped', session: 'sess-1', engine: 'warm', brief: ['project cmd-status'], memory: [] });
    expect(out.tools.every((t: string) => t.startsWith('Bash(agents lead tool '))).toBe(true);
  });

  it('lead tools accept no flags beyond their fixed shape', async () => {
    await expect(program().parseAsync(['node', 'agents', 'lead', 'tool', 'dispatch', '--ticket', 'PHNX-1', '--mode', 'skip']))
      .rejects.toThrow(/unknown option '--mode'/);
    await expect(program().parseAsync(['node', 'agents', 'lead', 'tool', 'stop', '--session', 'abcd1234', 'extra']))
      .rejects.toThrow(/too many arguments/);
    await expect(program().parseAsync(['node', 'agents', 'lead', 'tool', 'roster', '--secrets', 'prod']))
      .rejects.toThrow(/unknown option '--secrets'/);
    await expect(program().parseAsync(['node', 'agents', 'lead', 'tool', 'prs', 'merge', '--repo', 'a/b', '--number', '1', '--admin']))
      .rejects.toThrow(/unknown option '--admin'/);
    await expect(program().parseAsync(['node', 'agents', 'lead', 'tool', 'prs', 'close', '--repo', 'a/b', '--number', '1', '--body', 'x']))
      .rejects.toThrow(/unknown option '--body'/);
  });

  it('ask refuses a --context that is not a JSON object before starting anything', async () => {
    const out = await stdoutOf(['lead', 'ask', '--project', 'cmd-demo', '--json', '--context', 'front=3', '--', 'stop this one']);
    expect(JSON.parse(out.trim())).toEqual({ type: 'error', message: expect.stringContaining('--context expects a JSON object') });
    expect(process.exitCode).toBe(1);
  });

  it('a lead tool outside a Lead fails loud', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);
    try {
      await stdoutOf(['lead', 'tool', 'roster']);
      expect(process.exitCode).toBe(1);
      expect(String(err.mock.calls[0][0])).toMatch(/only inside a Lead/);
    } finally {
      err.mockRestore();
    }
  });
});
